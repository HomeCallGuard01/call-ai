const { twilioRestClient } = require("./twilioClient");
const {
  assignHouseholdTwilioNumber,
  recordTwilioProvisioningFailure,
  markTwilioNumberPendingRelease,
  cancelTwilioNumberPendingRelease,
  releaseHouseholdTwilioNumber,
  releaseHouseholdTwilioNumberImmediately,
  householdBlocksNumberRelease,
} = require("../database/households");
const {
  quarantineHouseholdTwilioNumber,
  markTwilioNumberQuarantineReleased,
} = require("../database/twilioQuarantine");
const { sendCriticalAlert } = require("./alerting");
const { decideNumberPurchase, decideTelephonyMutation, fakeNumber } = require("./telephony/provisioningGuard");

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
//
// voiceFallbackUrl (soft-launch integration 2026-10-04, containment T4):
// when HCG cannot be reached at all, Twilio answers with "an application
// error has occurred" and bills it. A fallback URL pointing at a static
// <Reject/> (e.g. a TwiML Bin) makes those calls unbilled. Omitted unless
// TWILIO_VOICE_FALLBACK_URL is an https URL — applies to NEW purchases only;
// existing numbers need a provider-side update (EXTERNAL, not done here).
function buildIncomingPhoneNumberParams({ phoneNumber, appUrl, addressSid, bundleSid, voiceFallbackUrl = process.env.TWILIO_VOICE_FALLBACK_URL }) {
  const fallback = typeof voiceFallbackUrl === "string" && /^https:\/\/[^\s]+$/.test(voiceFallbackUrl.trim()) ? voiceFallbackUrl.trim() : null;
  return {
    phoneNumber,
    voiceUrl: `${appUrl}/voice`,
    voiceMethod: "POST",
    ...(fallback ? { voiceFallbackUrl: fallback, voiceFallbackMethod: "POST" } : {}),
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
// Telephony abuse P0 (2026-10-03): every purchase now passes the
// provisioning abuse guard (services/abuse/provisioningGuard.js) —
// single-flight per household, incident mode, global purchase velocity,
// account-risk hold, provider-side idempotency (friendlyName tag + adopt
// before buy) and a provider-response check. server.js configures the guard
// at boot. With no guard configured, production REFUSES to buy (fail
// closed); non-production keeps the legacy behaviour so the existing unit
// tests of the purchase mechanics run unchanged.
let configuredAbuseGuard = null;
function configureProvisioningAbuseGuard(guard) {
  configuredAbuseGuard = guard || null;
}

async function ensureTwilioNumberProvisioned(household, deps = {}) {
  const guard = deps.abuseGuard !== undefined ? deps.abuseGuard : configuredAbuseGuard;
  const env = deps.env || process.env;

  if (!shouldAttemptProvisioning(household, { maxAttempts: deps.maxAttempts || DEFAULT_MAX_ATTEMPTS })) {
    return { attempted: false };
  }

  if (!guard) {
    if (env.NODE_ENV === "production") {
      console.error("TWILIO PROVISIONING REFUSED: abuse guard not configured", household.id);
      return { attempted: false, held: true, reason: "abuse_guard_not_configured" };
    }
    return purchaseTwilioNumber(household, deps, null);
  }

  return guard.singleFlight(household.id, async () => {
    const admission = await guard.admit(household, { override: deps.abuseOverride || null });
    if (!admission.allowed) {
      console.error("TWILIO PROVISIONING HELD:", household.id, admission.reason);
      return { attempted: false, held: true, reason: admission.reason };
    }
    return purchaseTwilioNumber(household, deps, guard);
  });
}

// The purchase mechanics. `guard` null = legacy (non-production unit tests).
async function purchaseTwilioNumber(household, deps, guard) {
  const {
    client = twilioRestClient,
    assign = assignHouseholdTwilioNumber,
    recordFailure = recordTwilioProvisioningFailure,
    // Injectable the same way as client/assign/recordFailure above —
    // fixes a real test-isolation leak (2026-09): this was previously a
    // direct, non-injectable call to the real sendCriticalAlert, so a
    // unit test simulating a Twilio failure sent a genuine alert email
    // whenever a real Resend_API_Key happened to be configured, despite
    // the Twilio client and database writes both already being properly
    // faked. Defaults to the real function for production use — no
    // behavior change outside tests.
    sendAlert = sendCriticalAlert,
    appUrl = process.env.APP_URL,
    addressSid = process.env.TWILIO_ADDRESS_SID,
    bundleSid = process.env.TWILIO_BUNDLE_SID,
    isQuarantinedNumber = isNumberInUnreleasedQuarantine,
    readHouseholdNumber = readHouseholdTwilioNumber,
    // Environment guard dep keeps its historical key `guard`, but is bound
    // to a different local name: `guard` is this function's abuse-guard
    // parameter (integration 2026-10-03). shouldAttemptProvisioning already
    // ran in ensureTwilioNumberProvisioned.
    guard: environmentGuard = decideNumberPurchase,
    guardEnv = process.env,
  } = deps;
  // Financial containment P0: every REAL number purchase needs a one-shot
  // authorisation (company-wide daily purchase cap + global breaker/kill
  // switch). Fail-closed. Applied by default whenever the real Twilio client
  // is in use; tests with a fake client inject their own (or none).
  const authorizeNumberPurchase = deps.authorizeNumberPurchase !== undefined
    ? deps.authorizeNumberPurchase
    : (client && client === twilioRestClient ? require("./containment").authorizeNumberPurchase : null);

  // Environment guard (services/telephony/provisioningGuard.js): a staging
  // or local server must never buy a real number on the production provider
  // account. It protects the REAL provider client — every production path
  // calls this without injecting a client; tests that inject a fake client
  // opt in with deps.enforceGuard. A blocked purchase is recorded as a
  // failure (so the existing attempt limit stops retries), never silently.
  // Keyed on the client's IDENTITY, not on whether one was passed: a
  // caller that passes the real client explicitly is guarded too.
  if (!("client" in deps) || (client && client === twilioRestClient) || deps.enforceGuard) {
    let decision = environmentGuard(guardEnv);
    if (decision.action === "purchase" && decision.environment === "nonproduction" && client) {
      const owned = await client.incomingPhoneNumbers.list().catch(() => null);
      decision = environmentGuard(guardEnv, { ownedNumberCount: owned ? owned.length : Infinity });
    }
    if (decision.action === "block") {
      console.warn("TWILIO PROVISIONING BLOCKED BY ENVIRONMENT GUARD:", household.id, decision.reason);
      await recordFailure(household.id, `provisioning blocked: ${decision.reason}`).catch(err =>
        console.error("TWILIO PROVISIONING FAILURE-RECORD ERROR:", err.message)
      );
      // A process that believes it is production but fails the production
      // signature would leave real customers without a number: shout.
      if (guardEnv.NODE_ENV === "production") {
        sendAlert("twilio_provisioning_blocked_by_guard", `Number purchase blocked in a production process: ${decision.reason}`, {
          householdId: household.id,
        }).catch(() => {});
      }
      return { attempted: true, success: false, blocked: true, error: decision.reason };
    }
    if (decision.action === "fake") {
      const number = fakeNumber(Date.now());
      const assigned = await assign(household.id, number);
      console.log("TWILIO PROVISIONING FAKE NUMBER (no provider call):", household.id, number);
      return { attempted: true, success: Boolean(assigned), fake: true, twilioNumber: number };
    }
  }

  if (!client) {
    const message = "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured";
    console.error("TWILIO PROVISIONING SKIPPED:", household.id, message);
    await recordFailure(household.id, message).catch(err =>
      console.error("TWILIO PROVISIONING FAILURE-RECORD ERROR:", err.message)
    );
    return { attempted: true, success: false, error: message };
  }

  if (authorizeNumberPurchase) {
    // Each attempt is counted (random key): two racing attempts are two
    // purchases. A refusal is NOT recorded as a provisioning failure, so it
    // never burns the household's limited attempts.
    const auth = await Promise.resolve(authorizeNumberPurchase({ householdId: household.id, attemptKey: require("crypto").randomUUID() }))
      .catch(err => ({ allowed: false, reason: `authorization_error: ${err.message}` }));
    if (!auth || !auth.allowed) {
      const reason = (auth && auth.reason) || "authorization_unavailable";
      console.error("TWILIO PROVISIONING REFUSED BY FINANCIAL CONTAINMENT:", household.id, reason);
      Promise.resolve().then(() => sendAlert("twilio_provisioning_refused_containment", `Number purchase not authorised: ${reason}`, { householdId: household.id, reason })).catch(() => {});
      return { attempted: true, success: false, error: `number purchase not authorised: ${reason}`, containmentRefused: true };
    }
  }

  try {
    let friendlyName = null;
    if (guard) {
      // Provider-side idempotency: a number already bought for this
      // household (create() timed out but succeeded, or the DB assign
      // failed after a purchase) is adopted, never bought twice. A number
      // still in quarantine keeps its tag and must NOT be adopted (its
      // pending release would later remove a number in use).
      friendlyName = guard.friendlyNameFor(household.id);
      const tagged = await client.incomingPhoneNumbers.list({ friendlyName, limit: 20 });
      const adoptable = [];
      for (const n of tagged || []) {
        if (n.friendlyName !== friendlyName) continue;
        if (await isQuarantinedNumber(n.phoneNumber)) continue;
        adoptable.push(n);
      }
      if (adoptable.length) {
        const adopt = adoptable[0];
        if (adoptable.length > 1) {
          sendAlert("twilio_provisioning_duplicate_tagged_numbers", "More than one unassigned number is tagged for one household — extra numbers need review", { householdId: household.id, count: adoptable.length }).catch(() => {});
        }
        const adoptedAssigned = await assign(household.id, adopt.phoneNumber);
        if (!adoptedAssigned) return { attempted: true, success: false, error: "race: household already provisioned" };
        console.log("TWILIO PROVISIONING ADOPTED existing tagged number:", household.id);
        return { attempted: true, success: true, twilioNumber: adopt.phoneNumber, adopted: true };
      }
    }

    const available = await client.availablePhoneNumbers("GB").local.list({
      limit: 1,
      voiceEnabled: true,
    });

    const candidate = pickAvailableNumber(available);

    if (!candidate) {
      throw new Error("No available GB Twilio numbers found");
    }

    const params = buildIncomingPhoneNumberParams({ phoneNumber: candidate.phoneNumber, appUrl, addressSid, bundleSid });
    if (friendlyName) params.friendlyName = friendlyName;
    const purchased = await client.incomingPhoneNumbers.create(params);

    if (guard) {
      guard.noteSuccessfulPurchase();
      const mismatch = guard.checkPurchased(candidate.phoneNumber, purchased);
      if (mismatch) {
        // Never assign a number we did not ask for (or that is not a UK
        // geographic number). Nothing points at it yet, so releasing now
        // is safe and stops the monthly charge.
        await client.incomingPhoneNumbers(purchased.sid).remove().catch(err =>
          console.error("TWILIO NUMBER RELEASE ERROR:", err.message)
        );
        throw new Error(`provider response rejected: ${mismatch}`);
      }
    }

    // Integration 2026-10-03 (launch-gate PR-07 / C7): the purchase has
    // SUCCEEDED; if the DB assignment then throws or times out, its outcome
    // is unknown. Re-read the household before deciding:
    //   - it now holds this number → the write committed: success;
    //   - it confirmably does NOT → nothing points at the number: release it
    //     now (stops the rental) — same safe class as the race-loser release;
    //   - unreadable → KEEP it (never release a number that may be live for a
    //     customer whose forwarding already points at it) and raise a critical
    //     alert; a tagged number is adopted on the next attempt, never bought twice.
    let assigned;
    try {
      assigned = await assign(household.id, purchased.phoneNumber);
    } catch (assignErr) {
      let holder;
      try { holder = await readHouseholdNumber(household.id); } catch { holder = undefined; }
      if (holder === purchased.phoneNumber) {
        console.warn("TWILIO PROVISIONING: assignment reported an error but committed:", household.id);
        return { attempted: true, success: true, twilioNumber: purchased.phoneNumber, assignErrorRecovered: true };
      }
      if (holder !== undefined) {
        console.error("TWILIO PROVISIONING: assignment failed after purchase — releasing the unassigned number", household.id);
        await client.incomingPhoneNumbers(purchased.sid).remove().catch(err =>
          console.error("TWILIO NUMBER RELEASE ERROR:", err.message)
        );
        throw new Error(`assignment failed after purchase; number released: ${assignErr.message}`);
      }
      sendAlert("twilio_provisioning_orphan_risk", "A number was purchased but its assignment outcome is unknown (database unreadable) — kept, tagged for adoption; verify and reconcile", {
        householdId: household.id, tagged: Boolean(friendlyName),
      }).catch(() => {});
      throw new Error(`assignment outcome unknown after purchase; number kept${friendlyName ? " (tagged for adoption)" : ""}: ${assignErr.message}`);
    }

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
    sendAlert("twilio_provisioning_failed", `Twilio number provisioning failed: ${err.message}`, {
      householdId: household.id,
    }).catch(() => {});
    await recordFailure(household.id, err.message).catch(recordErr =>
      console.error("TWILIO PROVISIONING FAILURE-RECORD ERROR:", recordErr.message)
    );
    return { attempted: true, success: false, error: err.message };
  }
}

// Integration 2026-10-03: the household's current number, for deciding what
// to do with a purchase whose assignment threw. THROWS when unreadable (the
// caller then keeps the number rather than guessing).
async function readHouseholdTwilioNumber(householdId) {
  const { supabaseAdmin } = require("./supabaseClients");
  if (!supabaseAdmin) throw new Error("household state unavailable");
  const { data, error } = await supabaseAdmin.from("households").select("twilio_number").eq("id", householdId).maybeSingle();
  if (error) throw new Error(`household read failed: ${error.message}`);
  return data ? data.twilio_number || null : null;
}

// Fail closed: if the quarantine table cannot be read, treat the number as
// quarantined (not adoptable) — the purchase path then buys nothing new
// either, because an unreadable state also fails the tagged lookup above.
async function isNumberInUnreleasedQuarantine(phoneNumber) {
  const { supabaseAdmin } = require("./supabaseClients");
  if (!supabaseAdmin) throw new Error("quarantine state unavailable");
  const { data, error } = await supabaseAdmin
    .from("twilio_number_quarantine")
    .select("id")
    .eq("twilio_number", phoneNumber)
    .is("released_at", null)
    .limit(1);
  if (error) throw new Error("quarantine state unavailable");
  return Array.isArray(data) && data.length > 0;
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

// Grace-period QUARANTINE path (see migrations/017's header for the
// cancellation-vs-deletion policy this implements, and migration 037's
// header for the quarantine correction layered on top of it, 2026-09-10).
// The database RPC is the sole authority on eligibility — it atomically
// checks the number still matches, a deadline was set, and that deadline
// has passed, and only then clears it — so this function only quarantines
// the number *after* confirming the database write succeeded, not
// before. That ordering is deliberate: if the quarantine insert fails
// after a successful database clear, the result is a harmless (if
// wasteful) orphaned Twilio resource nothing references anymore; the
// reverse ordering risks the opposite failure instead, where a database
// error leaves our records still pointing at a number that's already
// been handed off elsewhere — the real hazard (misrouted calls), not
// idle cost.
//
// IMPORTANT — this function no longer calls Twilio's real
// incomingPhoneNumbers(sid).remove() at all. Per the corrected quarantine
// design (migration 037), a number is never returned to Twilio's pool
// just because this grace period elapsed — it moves into quarantine,
// unconfirmed, and stays there until a human confirms deactivation. The
// genuine Twilio release only happens via releaseQuarantinedTwilioNumber,
// below, for confirmed rows. The one Twilio call this function still
// makes (findSid, a read-only .list() lookup) exists only to capture the
// resource's SID onto the quarantine row up front — see migration 037's
// own header on why relying solely on a phone-number search again later
// is not the only mechanism any more; a failure here is non-fatal (SID
// stays null, resolved lazily at release time from the fallback search).
async function releaseExpiredTwilioNumber(household, deps = {}) {
  const {
    client = twilioRestClient,
    release = releaseHouseholdTwilioNumber,
    quarantine = quarantineHouseholdTwilioNumber,
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

    const sid = client
      ? await findSid(client, household.twilio_number).catch(() => null)
      : null;

    await quarantine(household.id, household.twilio_number, "subscription_grace_expired", sid);

    console.log(
      "TWILIO NUMBER QUARANTINED (grace period expired, deactivation not yet confirmed):",
      household.id,
      household.twilio_number
    );
    return { released: false, quarantined: true, twilioNumber: household.twilio_number };
  } catch (err) {
    console.error("TWILIO NUMBER QUARANTINE FAILED:", household.id, err.message);
    return { released: false, error: err.message };
  }
}

// Immediate-QUARANTINE path — used by services/accountDeletion.js. Same
// database-first ordering rationale as releaseExpiredTwilioNumber above,
// and the same 2026-09-10 correction: account deletion is a deliberate,
// explicit customer action, but that does not establish that carrier-level
// forwarding has actually been removed — the same misdirected-call risk
// applies, so this path also quarantines rather than genuinely releasing.
// This does not weaken Apple Guideline 5.1.1(v) compliance: the customer's
// account (auth user, household row, personal data) is still fully and
// immediately deleted by deleteOwnAccount — only the underlying Twilio
// phone-number *resource*, a backend infrastructure concern the customer
// never sees, is held back from actually returning to Twilio's pool.
async function releaseTwilioNumberImmediately(household, deps = {}) {
  const {
    client = twilioRestClient,
    releaseImmediately = releaseHouseholdTwilioNumberImmediately,
    quarantine = quarantineHouseholdTwilioNumber,
    findSid = findTwilioIncomingNumberSid,
    blocksRelease = householdBlocksNumberRelease,
    sendAlert = sendCriticalAlert,
  } = deps;

  if (!household) return { released: false };

  try {
    // Migration 047: never take a number from a household that still has an
    // active or scheduled entitlement. Account deletion revokes the
    // entitlement first, so this only fires if something was left in force —
    // and then it alerts rather than silently leaving the number behind.
    // Fails closed: if the check can't be completed, treat as entitled.
    if (await blocksRelease(household.id).catch(() => true)) {
      console.error("NUMBER RELEASE BLOCKED (account deletion, household still entitled):", household.id);
      sendAlert(
        "number_release_blocked_entitled",
        "Account deletion could not release a number: the household still has an active or scheduled entitlement",
        { householdId: household.id, path: "account_deletion" }
      ).catch(() => {});
      return { released: false, blocked: "household_entitled" };
    }

    const releasedNumber = await releaseImmediately(household.id);

    if (!releasedNumber) {
      return { released: false };
    }

    const sid = client
      ? await findSid(client, releasedNumber).catch(() => null)
      : null;

    await quarantine(household.id, releasedNumber, "account_deletion", sid);

    console.log(
      "TWILIO NUMBER QUARANTINED (account deletion, deactivation not yet confirmed):",
      household.id,
      releasedNumber
    );
    return { released: false, quarantined: true, twilioNumber: releasedNumber };
  } catch (err) {
    console.error("TWILIO NUMBER IMMEDIATE QUARANTINE FAILED:", household.id, err.message);
    return { released: false, error: err.message };
  }
}

// Stage 2 — the only path in this codebase that still calls Twilio's real
// incomingPhoneNumbers(sid).remove(). Only ever acts on a quarantine row
// that is BOTH confirmed and not yet released — re-checked defensively
// here even though findConfirmedUnreleasedQuarantine's own query already
// filters for this, so a bad/future caller can never accidentally
// release an unconfirmed number through this function.
async function releaseQuarantinedTwilioNumber(quarantineRow, deps = {}) {
  const {
    client = twilioRestClient,
    findSid = findTwilioIncomingNumberSid,
    markReleased = markTwilioNumberQuarantineReleased,
    mutationGuard = decideTelephonyMutation,
    guardEnv = process.env,
    sendAlert = sendCriticalAlert,
    blocksRelease = householdBlocksNumberRelease,
  } = deps;

  if (!quarantineRow || !quarantineRow.deactivation_confirmed || quarantineRow.released_at) {
    return { released: false };
  }

  // Environment guard (services/telephony/provisioningGuard.js): only a
  // process with the production signature — or a declared, dedicated
  // non-production provider account — may remove a real number. A staging
  // or local server holding the production credentials (the 2026-09
  // .env fallthrough) is refused BEFORE any provider call, and the row is
  // NOT marked released, so nothing is recorded that did not happen.
  // Guards the real client (same rule as the purchase guard); tests
  // injecting a fake client opt in with deps.enforceGuard.
  if (client && (client === twilioRestClient || deps.enforceGuard)) {
    const decision = mutationGuard(guardEnv, { operation: "release" });
    if (decision.action !== "allow") {
      console.warn("TWILIO NUMBER RELEASE BLOCKED BY ENVIRONMENT GUARD:", quarantineRow.id, decision.reason);
      if (guardEnv.NODE_ENV === "production") {
        sendAlert("twilio_release_blocked_by_guard", `Number release blocked in a production process: ${decision.reason}`, {
          quarantineId: quarantineRow.id,
        }).catch(() => {});
      }
      return { released: false, blocked: true, error: decision.reason };
    }
  }
  // Migration 047: re-read the household's CURRENT entitlement immediately
  // before the provider release. A number quarantined from a household that
  // is entitled now (the real 2026-09-23 case, household 30f01a7a) must not
  // be returned to the provider; the returned error makes the daily runner
  // raise a critical alert so it's investigated, never silently skipped.
  // Fails closed: if the check can't be completed, treat as entitled.
  if (quarantineRow.household_id && (await blocksRelease(quarantineRow.household_id).catch(() => true))) {
    console.error("NUMBER RELEASE BLOCKED (quarantine, household currently entitled):", quarantineRow.household_id);
    return { released: false, blocked: "household_entitled", error: "household currently has an active or scheduled entitlement" };
  }

  try {
    if (client) {
      // Prefers the SID captured on the row at quarantine time (migration
      // 037) — falls back to searching Twilio by phone number only for a
      // row where that wasn't available, so this never depends on the
      // household record still existing (household_id can be null by
      // then — see migration 037's own header on the CASCADE correction).
      const sid = quarantineRow.twilio_sid || (await findSid(client, quarantineRow.twilio_number));
      if (sid) {
        await client.incomingPhoneNumbers(sid).remove();
      } else {
        console.warn(
          "TWILIO NUMBER QUARANTINE RELEASE: no matching Twilio resource found for",
          quarantineRow.twilio_number
        );
      }
    }

    await markReleased(quarantineRow.id);

    console.log(
      "TWILIO NUMBER RELEASED (quarantine, deactivation confirmed):",
      quarantineRow.household_id,
      quarantineRow.twilio_number
    );
    return { released: true, twilioNumber: quarantineRow.twilio_number };
  } catch (err) {
    console.error("TWILIO NUMBER QUARANTINE RELEASE FAILED:", quarantineRow.household_id, err.message);
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
  configureProvisioningAbuseGuard,
  isNumberInUnreleasedQuarantine,
  shouldAttemptProvisioning,
  pickAvailableNumber,
  buildIncomingPhoneNumberParams,
  ensureTwilioNumberProvisioned,
  pickMatchingIncomingNumber,
  findTwilioIncomingNumberSid,
  releaseExpiredTwilioNumber,
  releaseTwilioNumberImmediately,
  releaseQuarantinedTwilioNumber,
  updateTwilioNumberForEntitlementChange,
  isQualifyingSubscriptionStatus,
  handleWebhookProvisioningDecision,
  handleProcessedWebhookEvent,
};
