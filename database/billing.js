const { supabaseAdmin } = require("../services/supabaseClients");

// Every one of these goes through the narrow RPCs from
// supabase/migrations/013_stripe_billing_rpc_functions.sql and
// 014_claim_stripe_webhook_event_rpc.sql, or a plain read — never a direct
// `.from("households").update(...)`. service_role has no UPDATE grant on
// households at all (migration 012, deliberate); the RPCs are the only
// write path for households.stripe_customer_id.

// Sets households.stripe_customer_id via the RPC. Idempotent: a call with
// the same value that's already set is a no-op success. A call with a
// *different* value than what's already set throws — see the RPC's own
// comment for why (a household should never legitimately be re-pointed at
// a different Stripe Customer).
async function setHouseholdStripeCustomerId(householdId, stripeCustomerId) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { error } = await supabaseAdmin.rpc("set_household_stripe_customer_id", {
    p_household_id: householdId,
    p_stripe_customer_id: stripeCustomerId,
  });

  if (error) {
    console.error("STRIPE CUSTOMER ID SET ERROR:", error);
    throw error;
  }
}

async function getHouseholdByStripeCustomerId(stripeCustomerId) {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("households")
    .select("*")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();

  if (error) {
    console.error("SUPABASE HOUSEHOLD BY STRIPE CUSTOMER READ ERROR:", error);
    return null;
  }

  return data;
}

// Soft-launch integration 2026-10-04 (lifecycle F-03): the facts needed to
// tell an anonymised (deleted) household apart. Throws on a read error so the
// webhook returns 500 and Stripe retries — never guesses.
async function getHouseholdDeletionFacts(householdId) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");
  const { data, error } = await supabaseAdmin
    .from("households")
    .select("id, status, email, auth_user_id, stripe_customer_id")
    .eq("id", householdId)
    .maybeSingle();
  if (error) throw new Error(`household deletion facts unreadable: ${error.message || error}`);
  return data || null;
}

// Records an already-claimed event as terminal 'ignored' with its reason
// (only from 'received', i.e. the claim this request owns). Throws on error.
async function markWebhookEventIgnored({ stripeEventId, reason }) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");
  const { error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .update({ status: "ignored", processed_at: new Date().toISOString(), error: reason })
    .eq("stripe_event_id", stripeEventId)
    .eq("status", "received");
  if (error) throw new Error(`could not mark webhook event ignored: ${error.message || error}`);
}

// Claims a webhook event for processing via the dedup RPC (see that
// migration's comment for the full claim/retry semantics). Returns true if
// this call should proceed to process the event, false if it's already
// terminal (processed/ignored) or another attempt currently owns it — the
// caller should return 200 to Stripe either way.
async function claimWebhookEvent({ stripeEventId, eventType, stripeCustomerId, householdId, payload }) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { data, error } = await supabaseAdmin.rpc("claim_stripe_webhook_event", {
    p_stripe_event_id: stripeEventId,
    p_event_type: eventType,
    p_stripe_customer_id: stripeCustomerId,
    p_household_id: householdId,
    p_payload: payload,
  });

  if (error) {
    console.error("STRIPE WEBHOOK EVENT CLAIM ERROR:", error);
    throw error;
  }

  return data === true;
}

// Applies one already-claimed event's business effects (subscription
// upsert, entitlement transition, event status) atomically. Returns
// 'processed' or 'failed' — never throws; a thrown error here would mean
// supabaseAdmin itself is unreachable, not a business-logic failure (those
// are caught inside the RPC and recorded on the event row already).
async function processWebhookEvent({
  stripeEventId,
  householdId,
  stripeCustomerId,
  stripeSubscriptionId,
  stripePriceId,
  subscriptionStatus,
  currentPeriodEnd,
  cancelAtPeriodEnd,
  // Optional — the RPC defaults to now() if omitted (existing call sites
  // that predate the ordering guard keep working unmodified). Real
  // webhook deliveries should always pass the genuine Stripe event's own
  // `created` timestamp; see routes/billing.js.
  stripeEventCreated,
}) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const params = {
    p_stripe_event_id: stripeEventId,
    p_household_id: householdId,
    p_stripe_customer_id: stripeCustomerId,
    p_stripe_subscription_id: stripeSubscriptionId,
    p_stripe_price_id: stripePriceId,
    p_subscription_status: subscriptionStatus,
    p_current_period_end: currentPeriodEnd,
    p_cancel_at_period_end: cancelAtPeriodEnd,
  };
  if (stripeEventCreated) {
    params.p_stripe_event_created = stripeEventCreated;
  }

  const { data, error } = await supabaseAdmin.rpc("process_stripe_webhook_event", params);

  if (error) {
    console.error("STRIPE WEBHOOK EVENT PROCESS ERROR:", error);
    throw error;
  }

  return data;
}

// Decision 009's own stated rule for "is this household currently
// protected", implemented verbatim: an entitlements row that is active
// right now — never by asking Stripe whether a subscription exists.
async function getActiveEntitlement(householdId) {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("entitlements")
    .select("*")
    .eq("household_id", householdId)
    .eq("status", "active")
    .lte("starts_at", new Date().toISOString())
    .or(`ends_at.is.null,ends_at.gt.${new Date().toISOString()}`)
    .maybeSingle();

  if (error) {
    console.error("SUPABASE ENTITLEMENT READ ERROR:", error);
    return null;
  }

  return data;
}

// Same rule as getActiveEntitlement, but THROWS on a read error instead of
// returning null (WS4, 2026-10-10). For callers where "unreadable" must not
// be mistaken for "no entitlement" — e.g. GET /api/v1/billing/eligibility
// (routes/billingEligibility.js) must never tell an existing member they may
// buy again just because the database was briefly unreachable.
async function getActiveEntitlementOrThrow(householdId) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("entitlements")
    .select("*")
    .eq("household_id", householdId)
    .eq("status", "active")
    .lte("starts_at", nowIso)
    .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
    .maybeSingle();

  if (error) throw new Error(`entitlement unreadable: ${error.message || error}`);
  return data;
}

// Plain read for the Membership card — service_role already has SELECT on
// subscriptions (migration 012), so no new grant is needed. A household
// can have more than one historical subscriptions row (e.g. an old one
// replaced by a resubscribe); the most recently updated one is the real,
// current membership, hence the ordering.
async function getSubscriptionByHouseholdId(householdId) {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("*")
    .eq("household_id", householdId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("SUPABASE SUBSCRIPTION READ ERROR:", error);
    return null;
  }

  return data;
}

// Grants or renews a non-Stripe entitlement (currently: Apple IAP via
// RevenueCat) — plain table writes rather than an RPC, since this is an
// additive payment source, not a modification of the Stripe-specific
// process_stripe_webhook_event function. Reuses entitlements' existing,
// deliberately free-text `source` column (migration 011's own comment:
// "future sources... shouldn't require a schema migration just to add a
// label") and `external_reference` for the store's own subscription
// identifier — no new table, no migration.
//
// Idempotent by construction: if the household's current active
// entitlement already IS this exact subscription (same source +
// external_reference), this is a renewal/uncancellation for a grant we
// already made — only ends_at is extended, never a duplicate row. A
// genuinely new grant (first purchase, or replacing a different/no
// active entitlement) expires whatever was active first, preserving the
// same "at most one active row per household" invariant migration 011's
// partial unique index enforces for every other source.
// deps.client (default: the real supabaseAdmin) — added purely for
// testability, same pattern already used by grantComplimentaryEntitlement/
// revokeComplimentaryEntitlement below. No existing caller passes a
// third argument, so this is a zero-behavior-change addition: every
// production call site continues to use the real supabaseAdmin exactly
// as before.
//
// `environment` (2026-09-27, P0 fix): the RevenueCat event's own
// `environment` field ('sandbox' | 'production' | null/undefined),
// lower-cased by the caller before it reaches here — see
// routes/mobileApi.js. Purely recorded on the row (migration 053's
// revenuecat_environment column); this function itself makes no
// decision based on it and grants the entitlement identically either
// way, matching the existing "app still shows subscribed" requirement
// for a legitimate sandbox/TestFlight purchase. The actual safety
// behaviour (skipping real Twilio provisioning for a sandbox grant)
// lives at the call site in routes/mobileApi.js, which has the
// information needed to decide that; this function's only job is to
// make sure the fact is never lost once decided.
async function upsertActiveEntitlementFromRevenueCat(householdId, { originalTransactionId, expiresAtMs, environment = null }, deps = {}) {
  const { client = supabaseAdmin } = deps;
  if (!client) throw new Error("Supabase admin client not configured");

  const endsAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;

  const { data: existingActive, error: readError } = await client
    .from("entitlements")
    .select("*")
    .eq("household_id", householdId)
    .eq("status", "active")
    .maybeSingle();

  if (readError) {
    console.error("SUPABASE ENTITLEMENT READ ERROR (revenuecat upsert):", readError);
    throw readError;
  }

  // Integration 2026-10-03 — one canonical entitlement decision (mirrors
  // migration 070 for Stripe):
  //   * same Apple transaction → renew, but ends_at NEVER moves backwards (a
  //     replayed or out-of-order older event cannot shorten access);
  //   * a SANDBOX event never supersedes anything in effect (protects
  //     complimentary/App Review accounts and paying customers);
  //   * an in-effect PAID entitlement from another channel (Stripe) is never
  //     expired by an Apple purchase — kept, and the caller alerts support
  //     (the customer is paying twice);
  //   * a stale "active" row (ends_at passed) is not in effect and is replaced.
  const nowMs = typeof deps.now === "function" ? deps.now() : Date.now();
  const inEffect = (row) => row && (!row.ends_at || Date.parse(row.ends_at) > nowMs);
  const sandbox = environment !== "production";

  if (
    existingActive &&
    existingActive.source === "apple_revenuecat" &&
    existingActive.external_reference === originalTransactionId
  ) {
    if (endsAt && existingActive.ends_at && Date.parse(endsAt) < Date.parse(existingActive.ends_at)) {
      return { action: "ignored_older_event", entitlementId: existingActive.id, environment };
    }
    const patch = {};
    if (existingActive.ends_at !== endsAt) patch.ends_at = endsAt;
    // A renewal can genuinely flip environment (e.g. a sandbox
    // subscription's own accelerated renewal cadence) — always keep the
    // stored value in sync with the most recent event rather than
    // freezing whatever the very first grant happened to report.
    if (existingActive.revenuecat_environment !== environment) patch.revenuecat_environment = environment;
    if (Object.keys(patch).length > 0) {
      const { error: updateError } = await client
        .from("entitlements")
        .update(patch)
        .eq("id", existingActive.id);
      if (updateError) {
        console.error("SUPABASE ENTITLEMENT ENDS_AT UPDATE ERROR:", updateError);
        throw updateError;
      }
    }
    return { action: "renewed", entitlementId: existingActive.id, environment };
  }

  if (existingActive && inEffect(existingActive)) {
    if (sandbox) {
      return { action: "sandbox_kept_existing", entitlementId: existingActive.id, environment };
    }
    if (existingActive.entitlement_type === "paid_subscription" && existingActive.source !== "apple_revenuecat") {
      return { action: "parallel_paid_kept_existing", entitlementId: existingActive.id, existingSource: existingActive.source, environment };
    }
  }

  if (existingActive) {
    const { error: expireError } = await client
      .from("entitlements")
      .update({ status: "expired" })
      .eq("id", existingActive.id);
    if (expireError) {
      console.error("SUPABASE ENTITLEMENT EXPIRE-ON-TRANSITION ERROR:", expireError);
      throw expireError;
    }
  }

  const { data, error } = await client
    .from("entitlements")
    .insert({
      household_id: householdId,
      entitlement_type: "paid_subscription",
      status: "active",
      source: "apple_revenuecat",
      external_reference: originalTransactionId,
      ends_at: endsAt,
      revenuecat_environment: environment,
      notes: "Granted via RevenueCat (Apple In-App Purchase, StoreKit).",
    })
    .select("*")
    .single();

  if (error) {
    console.error("SUPABASE ENTITLEMENT GRANT ERROR (revenuecat):", error);
    throw error;
  }
  return { action: "granted", entitlementId: data.id, environment };
}

// Admin-granted complimentary access (2026-09) — no Stripe or RevenueCat
// object exists or is implied: source is 'admin_manual', external_reference
// is always null. Follows the exact same expire-old-then-insert-new
// transition upsertActiveEntitlementFromRevenueCat above already uses,
// so a household is never left with, or briefly passes through, two
// active entitlements — entitlements_one_active_per_household (migration
// 011) is the final backstop either way. Not wrapped in a single SQL
// transaction/RPC, matching this exact same pre-existing two-step
// pattern rather than introducing a new one.
//
// `deps.client` defaults to the real supabaseAdmin — only these two new
// functions accept it, so this is purely additive and never changes how
// the existing Stripe/RevenueCat functions above are called.
async function grantComplimentaryEntitlement(householdId, { grantedByAuthUserId, notes, endsAt }, deps = {}) {
  const { client = supabaseAdmin } = deps;
  if (!client) throw new Error("Supabase admin client not configured");
  if (!householdId) throw new Error("householdId is required");
  if (typeof notes !== "string" || !notes.trim()) {
    throw new Error("A reason/note is required to grant complimentary access");
  }
  if (!endsAt || Number.isNaN(Date.parse(endsAt))) {
    throw new Error("A valid expiry date (endsAt) is required to grant complimentary access");
  }

  const { data: existingActive, error: readError } = await client
    .from("entitlements")
    .select("id, source, entitlement_type")
    .eq("household_id", householdId)
    .eq("status", "active")
    .maybeSingle();

  if (readError) {
    console.error("SUPABASE ENTITLEMENT READ ERROR (complimentary grant):", readError);
    throw readError;
  }

  // Safety guard (2026-09): never expire or replace a real paid Stripe
  // or RevenueCat entitlement. Exactly two starting states are safe to
  // proceed from — no active entitlement at all, or an existing active
  // entitlement that is ITSELF already an admin-granted complimentary
  // one (safe to extend/replace/change, since nothing paid is at risk).
  // Anything else — genuinely paying, of any source — is refused
  // outright and left completely untouched. This is a normal, expected
  // business-rule outcome for the caller to present cleanly (like
  // revokeComplimentaryEntitlement's own { revoked: false, reason }
  // pattern below), not a thrown program error.
  if (existingActive && !(existingActive.source === "admin_manual" && existingActive.entitlement_type === "complimentary")) {
    return {
      granted: false,
      reason: "active_paid_entitlement_exists",
      existingEntitlement: { source: existingActive.source, entitlementType: existingActive.entitlement_type },
    };
  }

  if (existingActive) {
    const { error: expireError } = await client
      .from("entitlements")
      .update({ status: "expired" })
      .eq("id", existingActive.id);

    if (expireError) {
      console.error("SUPABASE ENTITLEMENT EXPIRE-ON-TRANSITION ERROR (complimentary grant):", expireError);
      throw expireError;
    }
  }

  const { data, error } = await client
    .from("entitlements")
    .insert({
      household_id: householdId,
      entitlement_type: "complimentary",
      status: "active",
      source: "admin_manual",
      external_reference: null,
      ends_at: new Date(endsAt).toISOString(),
      created_by: grantedByAuthUserId || null,
      notes: notes.trim(),
    })
    .select("*")
    .single();

  if (error) {
    console.error("SUPABASE ENTITLEMENT GRANT ERROR (complimentary):", error);
    throw error;
  }
  return { granted: true, action: "granted", entitlementId: data.id, endsAt: data.ends_at };
}

// Revokes an admin-granted complimentary entitlement only. Verifies the
// household's current active entitlement is actually
// source='admin_manual' AND entitlement_type='complimentary' before
// touching anything — this is what makes it impossible for this action
// to accidentally revoke a real, currently-active paid Stripe or
// RevenueCat entitlement. Uses 'revoked' (not 'expired') to distinguish
// a deliberate admin action from a natural lapse, matching entitlements'
// own status vocabulary (migration 011) — never deletes the row, so the
// audit trail (who granted it, when, why) is preserved exactly like
// every other entitlement transition in this codebase.
async function revokeComplimentaryEntitlement(householdId, deps = {}) {
  const { client = supabaseAdmin } = deps;
  if (!client) throw new Error("Supabase admin client not configured");
  if (!householdId) throw new Error("householdId is required");

  const { data: existingActive, error: readError } = await client
    .from("entitlements")
    .select("id, source, entitlement_type")
    .eq("household_id", householdId)
    .eq("status", "active")
    .maybeSingle();

  if (readError) {
    console.error("SUPABASE ENTITLEMENT READ ERROR (complimentary revoke):", readError);
    throw readError;
  }

  if (!existingActive) {
    return { revoked: false, reason: "no_active_entitlement" };
  }

  if (existingActive.source !== "admin_manual" || existingActive.entitlement_type !== "complimentary") {
    return { revoked: false, reason: "active_entitlement_is_not_complimentary" };
  }

  const { error } = await client
    .from("entitlements")
    .update({ status: "revoked" })
    .eq("id", existingActive.id);

  if (error) {
    console.error("SUPABASE ENTITLEMENT REVOKE ERROR (complimentary):", error);
    throw error;
  }
  return { revoked: true, entitlementId: existingActive.id };
}

// Reads a household's most recent RevenueCat entitlement row,
// regardless of status (active or already-expired) — deliberately not
// scoped to status='active' like getActiveEntitlement above. Used only
// by TRANSFER handling (services/revenuecatWebhook.js's
// resolveAndRevokeTransferSources): a TRANSFER event moves an existing
// subscription, so the source household's own entitlement row already
// holds the real original_transaction_id from whenever it was first
// granted — reading it is what lets the destination be granted under
// the genuine reference instead of a synthetic placeholder. Reading
// regardless of status (not just active) is what makes this safe to
// call again on a replayed webhook delivery after the first delivery
// has already expired the row: the reference is still sitting in it.
async function getMostRecentRevenueCatEntitlement(householdId, deps = {}) {
  const { client = supabaseAdmin } = deps;
  if (!client) return null;

  const { data, error } = await client
    .from("entitlements")
    .select("*")
    .eq("household_id", householdId)
    .eq("source", "apple_revenuecat")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("SUPABASE ENTITLEMENT READ ERROR (revenuecat most-recent):", error);
    return null;
  }

  return data;
}

// Revokes a household's active entitlement on a genuine RevenueCat
// EXPIRATION event — only if that active entitlement is actually the one
// RevenueCat owns (source + external_reference match). A household that
// cancelled Apple IAP and separately resubscribed via Stripe on the web
// must never have that Stripe entitlement revoked by a late/retried
// Apple expiration event — this check is what prevents that.
async function expireEntitlementFromRevenueCat(householdId, originalTransactionId, deps = {}) {
  const { client = supabaseAdmin, expiresAtMs = null } = deps;
  if (!client) throw new Error("Supabase admin client not configured");

  const { data: existingActive, error: readError } = await client
    .from("entitlements")
    .select("id, source, external_reference, ends_at")
    .eq("household_id", householdId)
    .eq("status", "active")
    .maybeSingle();

  if (readError) {
    console.error("SUPABASE ENTITLEMENT READ ERROR (revenuecat expire):", readError);
    throw readError;
  }

  if (
    !existingActive ||
    existingActive.source !== "apple_revenuecat" ||
    existingActive.external_reference !== originalTransactionId
  ) {
    return { revoked: false };
  }
  // Integration 2026-10-03: an expiry event for an EARLIER period than the
  // one now stored (renewed since; out-of-order or replayed) is ignored.
  if (expiresAtMs && existingActive.ends_at && Date.parse(existingActive.ends_at) > Number(expiresAtMs)) {
    return { revoked: false, ignored: "older_than_current_period" };
  }

  const { error } = await client
    .from("entitlements")
    .update({ status: "expired" })
    .eq("id", existingActive.id);

  if (error) {
    console.error("SUPABASE ENTITLEMENT REVOKE ERROR (revenuecat):", error);
    throw error;
  }
  return { revoked: true };
}

// Apple / RevenueCat subscription lifecycle state (migration 073, launch
// sprint 2026-10-05). Records CANCELLATION / UNCANCELLATION / BILLING_ISSUE /
// recovery on the ONE entitlement row this event is about: same household,
// source apple_revenuecat, same original transaction AND same RevenueCat
// environment — a sandbox/TestFlight event can never alter a production row.
// Never changes status or ends_at (no access is removed here). Out-of-order or
// replayed events are ignored via store_state_event_at. Before 073 is applied
// the columns do not exist: returns { applied: false, reason:
// 'store_state_columns_missing' } and the webhook behaves exactly as before.
// services/storeSubscriptionState.js decides the patch.
function isMissingStoreStateColumn(error) {
  return /42703|store_state_event_at|store_will_renew|does not exist|Could not find/i.test(`${(error && error.code) || ""} ${(error && error.message) || ""}`);
}

async function applyRevenueCatStoreState(householdId, { originalTransactionId, environment, eventAt, patch }, deps = {}) {
  const { client = supabaseAdmin } = deps;
  if (!client) throw new Error("Supabase admin client not configured");
  if (!householdId || !originalTransactionId || !environment || !eventAt || !patch) {
    return { applied: false, reason: "missing_input" };
  }
  const { isNewerThanRecorded } = require("../services/storeSubscriptionState");

  const { data: rows, error: readError } = await client
    .from("entitlements")
    .select("id, status, ends_at, revenuecat_environment, store_state_event_at")
    .eq("household_id", householdId)
    .eq("source", "apple_revenuecat")
    .eq("external_reference", originalTransactionId)
    .eq("revenuecat_environment", environment)
    .order("created_at", { ascending: false })
    .limit(1);

  if (readError) {
    if (isMissingStoreStateColumn(readError)) return { applied: false, reason: "store_state_columns_missing" };
    console.error("SUPABASE ENTITLEMENT READ ERROR (revenuecat store state):", readError);
    throw readError;
  }
  const row = rows && rows[0];
  if (!row) return { applied: false, reason: "no_matching_entitlement" };
  if (!isNewerThanRecorded(eventAt, row.store_state_event_at)) {
    return { applied: false, reason: "older_or_replayed_event", entitlementId: row.id };
  }

  const { error: updateError } = await client
    .from("entitlements")
    .update({ ...patch, store_state_event_at: eventAt })
    .eq("id", row.id);
  if (updateError) {
    if (isMissingStoreStateColumn(updateError)) return { applied: false, reason: "store_state_columns_missing" };
    console.error("SUPABASE ENTITLEMENT STORE STATE UPDATE ERROR:", updateError);
    throw updateError;
  }
  return { applied: true, entitlementId: row.id };
}

// Revokes a household's active Stripe-sourced entitlement, for
// account-deletion use (services/accountDeletion.js). Every other
// Stripe-driven entitlement change up to now has only ever happened via
// the real webhook (customer.subscription.* -> process_stripe_webhook_event),
// because cancellation itself always happened through Stripe's own
// customer-facing Billing Portal, which fires that webhook naturally.
// Account deletion needs the DB state updated synchronously in the same
// request — the household is about to be anonymised immediately after,
// and migration 020's own anonymize_inactive_household refuses to run
// while an active entitlement row still exists, so this can't just wait
// for the webhook to eventually land. The actual Stripe-side
// cancellation (stopping the real recurring charge) is a separate call
// the caller makes first — see deleteOwnAccount below — this function
// only ever updates HCG's own database record of it, exactly like
// revokeComplimentaryEntitlement/expireEntitlementFromRevenueCat above
// already do for their own sources.
async function revokeStripeEntitlementForDeletion(householdId, deps = {}) {
  const { client = supabaseAdmin } = deps;
  if (!client) throw new Error("Supabase admin client not configured");
  if (!householdId) throw new Error("householdId is required");

  const { data: existingActive, error: readError } = await client
    .from("entitlements")
    .select("id, source, external_reference")
    .eq("household_id", householdId)
    .eq("status", "active")
    .maybeSingle();

  if (readError) {
    console.error("SUPABASE ENTITLEMENT READ ERROR (stripe deletion revoke):", readError);
    throw readError;
  }

  if (!existingActive || existingActive.source !== "stripe") {
    return { revoked: false, reason: "no_active_stripe_entitlement" };
  }

  const { error } = await client
    .from("entitlements")
    .update({ status: "revoked" })
    .eq("id", existingActive.id);

  if (error) {
    console.error("SUPABASE ENTITLEMENT REVOKE ERROR (stripe deletion):", error);
    throw error;
  }

  return { revoked: true, entitlementId: existingActive.id, stripeSubscriptionId: existingActive.external_reference };
}

module.exports = {
  getHouseholdDeletionFacts,
  markWebhookEventIgnored,
  setHouseholdStripeCustomerId,
  getHouseholdByStripeCustomerId,
  claimWebhookEvent,
  processWebhookEvent,
  getActiveEntitlement,
  getActiveEntitlementOrThrow,
  getMostRecentRevenueCatEntitlement,
  getSubscriptionByHouseholdId,
  upsertActiveEntitlementFromRevenueCat,
  expireEntitlementFromRevenueCat,
  applyRevenueCatStoreState,
  grantComplimentaryEntitlement,
  revokeComplimentaryEntitlement,
  revokeStripeEntitlementForDeletion,
};
