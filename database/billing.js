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
async function upsertActiveEntitlementFromRevenueCat(householdId, { originalTransactionId, expiresAtMs }) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const endsAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;

  const { data: existingActive, error: readError } = await supabaseAdmin
    .from("entitlements")
    .select("*")
    .eq("household_id", householdId)
    .eq("status", "active")
    .maybeSingle();

  if (readError) {
    console.error("SUPABASE ENTITLEMENT READ ERROR (revenuecat upsert):", readError);
    throw readError;
  }

  if (
    existingActive &&
    existingActive.source === "apple_revenuecat" &&
    existingActive.external_reference === originalTransactionId
  ) {
    if (existingActive.ends_at !== endsAt) {
      const { error: updateError } = await supabaseAdmin
        .from("entitlements")
        .update({ ends_at: endsAt })
        .eq("id", existingActive.id);
      if (updateError) {
        console.error("SUPABASE ENTITLEMENT ENDS_AT UPDATE ERROR:", updateError);
        throw updateError;
      }
    }
    return { action: "renewed", entitlementId: existingActive.id };
  }

  if (existingActive) {
    const { error: expireError } = await supabaseAdmin
      .from("entitlements")
      .update({ status: "expired" })
      .eq("id", existingActive.id);
    if (expireError) {
      console.error("SUPABASE ENTITLEMENT EXPIRE-ON-TRANSITION ERROR:", expireError);
      throw expireError;
    }
  }

  const { data, error } = await supabaseAdmin
    .from("entitlements")
    .insert({
      household_id: householdId,
      entitlement_type: "paid_subscription",
      status: "active",
      source: "apple_revenuecat",
      external_reference: originalTransactionId,
      ends_at: endsAt,
      notes: "Granted via RevenueCat (Apple In-App Purchase, StoreKit).",
    })
    .select("*")
    .single();

  if (error) {
    console.error("SUPABASE ENTITLEMENT GRANT ERROR (revenuecat):", error);
    throw error;
  }
  return { action: "granted", entitlementId: data.id };
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

// Revokes a household's active entitlement on a genuine RevenueCat
// EXPIRATION event — only if that active entitlement is actually the one
// RevenueCat owns (source + external_reference match). A household that
// cancelled Apple IAP and separately resubscribed via Stripe on the web
// must never have that Stripe entitlement revoked by a late/retried
// Apple expiration event — this check is what prevents that.
async function expireEntitlementFromRevenueCat(householdId, originalTransactionId) {
  if (!supabaseAdmin) throw new Error("Supabase admin client not configured");

  const { data: existingActive, error: readError } = await supabaseAdmin
    .from("entitlements")
    .select("id, source, external_reference")
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

  const { error } = await supabaseAdmin
    .from("entitlements")
    .update({ status: "expired" })
    .eq("id", existingActive.id);

  if (error) {
    console.error("SUPABASE ENTITLEMENT REVOKE ERROR (revenuecat):", error);
    throw error;
  }
  return { revoked: true };
}

module.exports = {
  setHouseholdStripeCustomerId,
  getHouseholdByStripeCustomerId,
  claimWebhookEvent,
  processWebhookEvent,
  getActiveEntitlement,
  getSubscriptionByHouseholdId,
  upsertActiveEntitlementFromRevenueCat,
  expireEntitlementFromRevenueCat,
  grantComplimentaryEntitlement,
  revokeComplimentaryEntitlement,
};
