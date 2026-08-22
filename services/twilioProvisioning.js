const { twilioRestClient } = require("./twilioClient");
const {
  assignHouseholdTwilioNumber,
  recordTwilioProvisioningFailure,
  markTwilioNumberPendingRelease,
  cancelTwilioNumberPendingRelease,
  releaseHouseholdTwilioNumber,
  releaseHouseholdTwilioNumberImmediately,
} = require("../database/households");

const DEFAULT_MAX_ATTEMPTS = 5;

// Pure — see tests/twilio-provisioning.test.mjs. Bounds retry so a
// persistently-failing household (Twilio misconfiguration, region
// exhausted, account issue) stops being retried on every subsequent
// webhook/reconcile call and instead sits flagged for administrative
// attention, per this system's failure-handling requirement, rather than
// being hammered forever.
function shouldAttemptProvisioning(household, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  if (!household) return false;
  if (household.twilio_number) return false;
  return (household.twilio_provisioning_attempts || 0) < maxAttempts;
}

// Pure — the one place that decides which search result to buy, isolated
// so a future change in selection strategy (e.g. prefer a specific area
// code) is a one-function change with its own test, not a rewrite of the
// orchestrator below.
function pickAvailableNumber(availableNumbers) {
  return (availableNumbers && availableNumbers[0]) || null;
}

// Pure — the exact params passed to Twilio's purchase call, isolated so
// the voice-webhook wiring is directly testable without a real Twilio
// client. voiceUrl must point back at this app's own /voice route, or a
// purchased number would ring with nothing configured to answer it.
//
// addressSid is UK local numbers' one hard prerequisite: Twilio rejects
// the purchase outright ("Phone Number Requires an Address but the
// 'AddressSid' parameter was empty") without a registered Address object
// on file — see docs/launch/KNOWN_ISSUES.md. Deliberately omitted from
// the returned params (not sent as null/undefined) when not supplied, so
// this function's behavior is byte-for-byte unchanged from today for as
// long as TWILIO_ADDRESS_SID remains unset — this is a strict addition,
// not a change, to the existing failure mode.
//
// bundleSid is a second, separate UK regulatory requirement, in addition
// to (not instead of) addressSid — confirmed via a real purchase attempt
// that was still rejected ("Bundle required and not provided for
// country: [GB] and numberType: [LOCAL]") even with addressSid supplied.
// Same omit-when-unset treatment as addressSid.
function buildIncomingPhoneNumberParams({ phoneNumber, appUrl, addressSid, bundleSid }) {
  return {
    phoneNumber,
    voiceUrl: `${appUrl}/voice`,
    voiceMethod: "POST",
    ...(addressSid ? { addressSid } : {}),
    ...(bundleSid ? { bundleSid } : {}),
  };
}

// Orchestrates provisioning a Twilio number for a household that doesn't
// have one yet. Never throws: every failure (missing Twilio credentials,
// no available numbers, a Twilio API error, a database error recording
// the outcome) is caught, logged, and recorded via
// recordTwilioProvisioningFailure — so a Stripe webhook or the checkout
// reconciliation route calling this can always still complete normally,
// and the subscription/entitlement it followed is never affected either
// way, per the requirement that provisioning failure must never make a
// valid subscription look broken.
//
// Accepts its collaborators as `deps` so tests can inject a fake Twilio
// client and fake database functions instead of hitting real network
// services — everything defaults to the real ones for production use.
async function ensureTwilioNumberProvisioned(household, deps = {}) {
  const {
    client = twilioRestClient,
    assign = assignHouseholdTwilioNumber,
    recordFailure = recordTwilioProvisioningFailure,
    appUrl = process.env.APP_URL,
    addressSid = process.env.TWILIO_ADDRESS_SID,
    bundleSid = process.env.TWILIO_BUNDLE_SID,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = deps;

  if (!shouldAttemptProvisioning(household, { maxAttempts })) {
    return { attempted: false };
  }

  if (!client) {
    const message = "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured";
    console.error("TWILIO PROVISIONING SKIPPED:", household.id, message);
    await recordFailure(household.id, message).catch(err =>
      console.error("TWILIO PROVISIONING FAILURE-RECORD ERROR:", err.message)
    );
    return { attempted: true, success: false, error: message };
  }

  try {
    // Reverted to .local, smsEnabled removed, 2026-08-16 (see the
    // 2026-08-16 architecture review): a brief attempt to fix a missing-
    // SMS bug by switching every household's number to .mobile was the
    // wrong fix — UK .mobile numbers cost ~2.2x more per month than
    // .local for zero benefit to this call-routing architecture, since
    // the caller never sees this Twilio number either way (they only see
    // the household's own real number, which is what's actually being
    // forwarded from). SMS capability doesn't need to live on the
    // per-household voice number: the plan is one shared, dedicated
    // SMS-capable number for all warning texts, decoupled from any
    // household's own voice number — that number hasn't been purchased
    // yet (pending regulatory bundle approval and a separate cost
    // sign-off), and the code to send from it instead of the household's
    // own number hasn't been wired up yet either. Per-household numbers
    // stay .local, voice-only, exactly as before this whole episode
    // started.
    const available = await client.availablePhoneNumbers("GB").local.list({
      limit: 1,
      voiceEnabled: true,
    });

    const candidate = pickAvailableNumber(available);

    if (!candidate) {
      throw new Error("No available GB Twilio numbers found");
    }

    const purchased = await client.incomingPhoneNumbers.create(
      buildIncomingPhoneNumberParams({ phoneNumber: candidate.phoneNumber, appUrl, addressSid, bundleSid })
    );

    const assigned = await assign(household.id, purchased.phoneNumber);

    if (!assigned) {
      // Another attempt already assigned a different number to this
      // household between our read and our write — this call's own
      // purchase is now redundant. Release it rather than silently pay
      // for a number nothing will ever use.
      console.warn(
        "TWILIO PROVISIONING RACE: releasing redundant number for household",
        household.id
      );
      await client.incomingPhoneNumbers(purchased.sid).remove().catch(err =>
        console.error("TWILIO NUMBER RELEASE ERROR:", err.message)
      );
      return { attempted: true, success: false, error: "race: household already provisioned" };
    }

    console.log("TWILIO PROVISIONING SUCCESS:", household.id, purchased.phoneNumber);
    return { attempted: true, success: true, twilioNumber: purchased.phoneNumber };
  } catch (err) {
    console.error("TWILIO PROVISIONING FAILED:", household.id, err.message);
    await recordFailure(household.id, err.message).catch(recordErr =>
      console.error("TWILIO PROVISIONING FAILURE-RECORD ERROR:", recordErr.message)
    );
    return { attempted: true, success: false, error: err.message };
  }
}

// Pure — the one place that decides which of a number's matching Twilio
// resources to act on when releasing by phone number (rather than by the
// SID a fresh purchase already has in hand). Isolated with its own test
// for the same reason as pickAvailableNumber above.
function pickMatchingIncomingNumber(matches) {
  return (matches && matches[0]) || null;
}

// Looks up a previously-purchased number's Twilio SID by its phone number
// string — the lifecycle release paths below only ever have the number
// itself stored on the household row, never the SID a fresh purchase
// returns directly.
async function findTwilioIncomingNumberSid(client, phoneNumber) {
  const matches = await client.incomingPhoneNumbers.list({ phoneNumber, limit: 1 });
  const match = pickMatchingIncomingNumber(matches);
  return match ? match.sid : null;
}

// Grace-period release path (see migrations/017's header for the
// cancellation-vs-deletion policy this implements). The database RPC is
// the sole authority on eligibility — it atomically checks the number
// still matches, a deadline was set, and that deadline has passed, and
// only then clears it — so this function releases the number via
// Twilio's API *after* confirming the database write succeeded, not
// before. That ordering is deliberate: if the Twilio-side release fails
// after a successful database clear, the result is a harmless (if
// wasteful) orphaned Twilio resource nothing references anymore; the
// reverse ordering — releasing from Twilio first — risks the opposite
// failure instead, where a database error leaves our records still
// pointing at a number Twilio has already given to someone else, which
// is the real hazard (misrouted calls), not idle cost.
async function releaseExpiredTwilioNumber(household, deps = {}) {
  const {
    client = twilioRestClient,
    release = releaseHouseholdTwilioNumber,
    findSid = findTwilioIncomingNumberSid,
  } = deps;

  if (!household || !household.twilio_number || !household.twilio_number_pending_release_at) {
    return { released: false };
  }

  try {
    const eligible = await release(household.id, household.twilio_number);

    if (!eligible) {
      return { released: false };
    }

    if (client) {
      const sid = await findSid(client, household.twilio_number);
      if (sid) {
        await client.incomingPhoneNumbers(sid).remove();
      } else {
        console.warn(
          "TWILIO NUMBER RELEASE: no matching Twilio resource found for",
          household.twilio_number
        );
      }
    }

    console.log("TWILIO NUMBER RELEASED (grace period expired):", household.id, household.twilio_number);
    return { released: true, twilioNumber: household.twilio_number };
  } catch (err) {
    console.error("TWILIO NUMBER RELEASE FAILED:", household.id, err.message);
    return { released: false, error: err.message };
  }
}

// Immediate-release path — intended for a future account-deletion
// feature (none exists in this codebase yet). Same database-first
// ordering rationale as releaseExpiredTwilioNumber above.
async function releaseTwilioNumberImmediately(household, deps = {}) {
  const {
    client = twilioRestClient,
    releaseImmediately = releaseHouseholdTwilioNumberImmediately,
    findSid = findTwilioIncomingNumberSid,
  } = deps;

  if (!household) return { released: false };

  try {
    const releasedNumber = await releaseImmediately(household.id);

    if (!releasedNumber) {
      return { released: false };
    }

    if (client) {
      const sid = await findSid(client, releasedNumber);
      if (sid) {
        await client.incomingPhoneNumbers(sid).remove();
      } else {
        console.warn("TWILIO NUMBER IMMEDIATE RELEASE: no matching Twilio resource found for", releasedNumber);
      }
    }

    console.log("TWILIO NUMBER RELEASED (immediate):", household.id, releasedNumber);
    return { released: true, twilioNumber: releasedNumber };
  } catch (err) {
    console.error("TWILIO NUMBER IMMEDIATE RELEASE FAILED:", household.id, err.message);
    return { released: false, error: err.message };
  }
}

// The single entry point routes/billing.js calls on every entitlement
// change (webhook or reconcile-poll driven) — centralizes the policy so
// there's one place, not two ad-hoc call sites, deciding what happens to
// a household's number as it moves between entitled and not:
//   entitled, no number yet       -> provision one
//   entitled, already has one     -> cancel any pending release, keep it
//   not entitled, still has one   -> start the grace-period clock
//   not entitled, never had one   -> nothing to do
async function updateTwilioNumberForEntitlementChange(household, isEntitled, deps = {}) {
  if (!household) return { action: "none" };

  const {
    cancelPendingRelease = cancelTwilioNumberPendingRelease,
    markPendingRelease = markTwilioNumberPendingRelease,
    gracePeriodDays,
  } = deps;

  if (isEntitled) {
    await cancelPendingRelease(household.id).catch(err =>
      console.error("TWILIO NUMBER PENDING-RELEASE CANCEL ERROR:", err.message)
    );
    const result = await ensureTwilioNumberProvisioned(household, deps);
    return { action: "provision", ...result };
  }

  if (household.twilio_number) {
    const marked = await markPendingRelease(household.id, gracePeriodDays).catch(err => {
      console.error("TWILIO NUMBER PENDING-RELEASE MARK ERROR:", err.message);
      return false;
    });
    if (marked) {
      console.log("TWILIO NUMBER MARKED FOR RELEASE:", household.id, household.twilio_number);
    }
    return { action: "mark-pending-release", marked };
  }

  return { action: "none" };
}

// Mirrors process_stripe_webhook_event's own v_qualifies check
// (supabase/migrations/019_subscription_event_ordering_guard.sql) —
// deliberately the same three literal strings, since this is the
// webhook's *immediate* provisioning signal, derived directly from the
// Stripe subscription event already in hand rather than a second,
// independent source of truth that could disagree with the one the RPC
// just used to write the entitlement row.
const QUALIFYING_SUBSCRIPTION_STATUSES = new Set(["trialing", "active", "past_due"]);

// Pure — see tests/webhook-provisioning-decision.test.mjs.
function isQualifyingSubscriptionStatus(status) {
  return QUALIFYING_SUBSCRIPTION_STATUSES.has(status);
}

// Orchestrates the webhook's immediate provisioning decision once
// routes/billing.js has confirmed a Stripe subscription event was
// durably processed (subscriptions/entitlements already written by the
// RPC). Takes the event's own subscriptionStatus directly — never a
// fresh getActiveEntitlement() re-read — because that re-read used to
// run immediately after the same request's own RPC call had just
// inserted the entitlement row, racing the entitlement's own
// database-generated `starts_at` (default now()) against this Node
// process's clock. Any clock skew or propagation delay could make the
// re-read transiently see "not entitled" for an entitlement just
// written a few lines above, silently resolving to
// updateTwilioNumberForEntitlementChange(household, false) —
// { action: "none" } — with no number ever provisioned and no error
// anywhere (confirmed live: household
// 816b3f10-217a-43f2-b242-e3f8ba44fd95's subscription/entitlement
// synced correctly on 2026-08-22 but twilio_number stayed null,
// attempts stayed 0). The entitlements table remains the real source of
// truth for every other read (requireEntitlement, dashboard, etc.) —
// this is the one call site, right after a webhook that just told us
// definitively what changed, where re-deriving the same fact from a
// timestamp-sensitive read was actively the wrong source to use.
//
// Never throws — mirrors updateTwilioNumberForEntitlementChange's own
// "provisioning failure must never affect the webhook's own success"
// contract. deps flow straight through to
// updateTwilioNumberForEntitlementChange/ensureTwilioNumberProvisioned,
// so a test can inject a fake Twilio client/household-lookup all the
// way down without ever calling the real Twilio API.
async function handleWebhookProvisioningDecision(
  { householdId, eventType, subscriptionStatus, stripeCustomerId },
  deps = {}
) {
  const {
    getHouseholdByStripeCustomerId,
    updateForEntitlementChange = updateTwilioNumberForEntitlementChange,
    logDecision = (...args) => console.log(...args),
    logSkip = (...args) => console.error(...args),
  } = deps;

  const intendedEnabled = isQualifyingSubscriptionStatus(subscriptionStatus);

  logDecision(
    "WEBHOOK PROVISIONING DECISION:",
    JSON.stringify({ householdId, eventType, subscriptionStatus, intendedEnabled })
  );

  if (!householdId) {
    logSkip("WEBHOOK PROVISIONING SKIPPED: no household_id resolved for event", eventType);
    return { action: "skipped", reason: "no_household_id" };
  }

  const household = await getHouseholdByStripeCustomerId(stripeCustomerId);

  if (!household) {
    logSkip(
      "WEBHOOK PROVISIONING SKIPPED: no household row found for customer",
      stripeCustomerId,
      "resolved household_id",
      householdId
    );
    return { action: "skipped", reason: "no_household_row" };
  }

  const result = await updateForEntitlementChange(household, intendedEnabled, deps);
  logDecision("WEBHOOK PROVISIONING RESULT:", JSON.stringify({ householdId, ...result }));
  return result;
}

// Gates handleWebhookProvisioningDecision on whether
// process_stripe_webhook_event (database/billing.js's processWebhookEvent)
// actually applied this specific event, or discarded it as stale/
// out-of-order (supabase/migrations/019_subscription_event_ordering_guard.sql,
// supabase/migrations/027_stale_webhook_event_result.sql). Both outcomes
// used to return the identical string 'processed', which is exactly why
// handleWebhookProvisioningDecision alone isn't safe to call on every
// "processed" webhook: a stale event that the ordering guard correctly
// ignored still carries its OWN (possibly outdated) subscription.status,
// and acting on it here would risk the exact out-of-order provisioning/
// deprovisioning flip the guard exists to prevent — e.g. an old
// "canceled" event arriving late after a newer "active" reactivation was
// already applied must not deprovision the number the accepted newer
// event just re-enabled, and vice versa. This is the single call site
// routes/billing.js's webhook handler uses; only 'processed' ever reaches
// handleWebhookProvisioningDecision, 'ignored_stale' is a deliberate,
// logged no-op, and anything else (e.g. 'failed') is also a no-op here
// (routes/billing.js handles 'failed' itself, via its own 500 response).
async function handleProcessedWebhookEvent(processWebhookEventResult, decisionInput, deps = {}) {
  const { logSkip = (...args) => console.error(...args) } = deps;

  if (processWebhookEventResult === "ignored_stale") {
    logSkip(
      "WEBHOOK PROVISIONING SKIPPED: event superseded by a newer one already applied (stale/out-of-order) — not acting on its subscription status",
      JSON.stringify({
        householdId: decisionInput.householdId,
        eventType: decisionInput.eventType,
        subscriptionStatus: decisionInput.subscriptionStatus,
      })
    );
    return { action: "skipped", reason: "stale_event" };
  }

  if (processWebhookEventResult !== "processed") {
    return { action: "skipped", reason: "not_processed" };
  }

  return handleWebhookProvisioningDecision(decisionInput, deps);
}

module.exports = {
  shouldAttemptProvisioning,
  pickAvailableNumber,
  buildIncomingPhoneNumberParams,
  ensureTwilioNumberProvisioned,
  pickMatchingIncomingNumber,
  findTwilioIncomingNumberSid,
  releaseExpiredTwilioNumber,
  releaseTwilioNumberImmediately,
  updateTwilioNumberForEntitlementChange,
  isQualifyingSubscriptionStatus,
  handleWebhookProvisioningDecision,
  handleProcessedWebhookEvent,
};
