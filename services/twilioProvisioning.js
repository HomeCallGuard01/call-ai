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
function buildIncomingPhoneNumberParams({ phoneNumber, appUrl }) {
  return {
    phoneNumber,
    voiceUrl: `${appUrl}/voice`,
    voiceMethod: "POST",
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
    const available = await client.availablePhoneNumbers("GB").local.list({
      limit: 1,
      voiceEnabled: true,
    });

    const candidate = pickAvailableNumber(available);

    if (!candidate) {
      throw new Error("No available GB Twilio numbers found");
    }

    const purchased = await client.incomingPhoneNumbers.create(
      buildIncomingPhoneNumberParams({ phoneNumber: candidate.phoneNumber, appUrl })
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
};
