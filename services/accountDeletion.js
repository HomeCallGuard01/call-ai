// User-initiated in-app account deletion (Apple Guideline 5.1.1(v) —
// merely directing a customer to email support or visit a website does
// not satisfy the requirement; the app itself must let them initiate
// deletion). Reuses the existing anonymize_inactive_household RPC
// (supabase/migrations/020_anonymize_inactive_household.sql) and
// releaseTwilioNumberImmediately (services/twilioProvisioning.js,
// already written "intended for a future account-deletion feature —
// none exists in this codebase yet") — no parallel deletion system.
//
// Ordering is deliberate and matters:
//   1. Stop any real recurring billing first — see the per-source
//      handling below, especially the Apple/RevenueCat caveat.
//   2. Release the Twilio number, so no live phone-routing resource is
//      left pointing at an account that's about to disappear.
//   3. Anonymise the household row. This step's own database guardrail
//      (migration 020) hard-refuses if step 1 left an active
//      entitlement, or if step 2 left twilio_number still set — so a
//      bug in either earlier step surfaces here as a clear thrown
//      error instead of a silently-incomplete deletion.
//   4. Delete the Supabase Auth user last, only once every DB-side step
//      above has actually succeeded — this is the point of no return
//      for the customer's ability to sign back in, so it happens after
//      everything else, never before.
//
// IMPORTANT — the fact behind appleManualCancellationRequired below:
// Apple provides no API for a developer to cancel a customer's
// auto-renewable subscription; only the subscriber (Settings > [name] >
// Subscriptions) or Apple itself can do that. RevenueCat cannot do it
// either — it only reflects state Apple already reports, it never
// issues Apple a cancel instruction. So for an apple_revenuecat
// entitlement, this function revokes HCG's own access/entitlement
// immediately but genuinely cannot stop Apple's billing. The caller
// (routes/mobileApi.js) surfaces appleManualCancellationRequired so the
// mobile UI tells the customer the true, complete picture — never a
// false "everything is cancelled" claim.
const {
  getActiveEntitlement,
  revokeComplimentaryEntitlement,
  expireEntitlementFromRevenueCat,
  revokeStripeEntitlementForDeletion,
} = require("../database/billing");
const { releaseTwilioNumberImmediately } = require("./twilioProvisioning");
const { supabaseAdmin } = require("./supabaseClients");
const { stripe } = require("./stripeClient");

async function defaultCancelStripeSubscription(subscriptionId) {
  if (!stripe || !subscriptionId) return { cancelled: false };
  try {
    await stripe.subscriptions.cancel(subscriptionId);
    return { cancelled: true };
  } catch (err) {
    console.error("STRIPE SUBSCRIPTION CANCEL FAILED (account deletion):", subscriptionId, err.message);
    return { cancelled: false, error: err.message };
  }
}

async function defaultAnonymizeHousehold(householdId, reason, client) {
  const { error } = await client.rpc("anonymize_inactive_household", {
    p_household_id: householdId,
    p_reason: reason,
  });
  if (error) throw error;
}

async function defaultDeleteAuthUser(authUserId, client) {
  const { error } = await client.auth.admin.deleteUser(authUserId);
  if (error) {
    console.error("SUPABASE AUTH USER DELETE FAILED (account deletion):", authUserId, error.message);
    return false;
  }
  return true;
}

// deps injection follows this file's existing codebase convention
// (services/twilioProvisioning.js, database/billing.js) so every
// external side effect (Stripe, Twilio, Supabase Auth admin, the
// anonymise RPC) is fully fakeable in tests with zero live network
// calls — see tests/account-deletion.test.mjs.
async function deleteOwnAccount(household, deps = {}) {
  const {
    client = supabaseAdmin,
    getActiveEntitlement: getActiveEntitlementFn = getActiveEntitlement,
    revokeComplimentary = revokeComplimentaryEntitlement,
    expireRevenueCat = expireEntitlementFromRevenueCat,
    revokeStripe = revokeStripeEntitlementForDeletion,
    cancelStripeSubscription = defaultCancelStripeSubscription,
    releaseTwilio = releaseTwilioNumberImmediately,
    anonymizeHousehold = defaultAnonymizeHousehold,
    deleteAuthUser = defaultDeleteAuthUser,
  } = deps;

  if (!household || !household.id) {
    throw new Error("deleteOwnAccount: household is required");
  }

  const entitlement = await getActiveEntitlementFn(household.id);

  let entitlementOutcome = { source: null, action: "none" };
  let appleManualCancellationRequired = false;

  if (entitlement) {
    if (entitlement.source === "admin_manual" && entitlement.entitlement_type === "complimentary") {
      await revokeComplimentary(household.id, { client });
      entitlementOutcome = { source: "admin_manual", action: "revoked" };
    } else if (entitlement.source === "apple_revenuecat") {
      // See the file header: HCG genuinely cannot cancel this — only
      // HCG's own side of the entitlement is revoked here.
      await expireRevenueCat(household.id, entitlement.external_reference, { client });
      entitlementOutcome = { source: "apple_revenuecat", action: "hcg_access_revoked_apple_not_cancelled" };
      appleManualCancellationRequired = true;
    } else if (entitlement.source === "stripe") {
      const cancelResult = await cancelStripeSubscription(entitlement.external_reference);

      // Unlike Apple/RevenueCat, HCG genuinely controls Stripe billing —
      // which is exactly why a failure here must fail closed rather than
      // proceed. Revoking the DB row and anonymising anyway would
      // delete the account while the real, still-active Stripe
      // subscription keeps charging the customer, with no account left
      // for them to notice or cancel it from. Nothing has been touched
      // yet at this point (no DB write, no Twilio release, no
      // anonymise) — the household is left exactly as it was, so the
      // customer can simply retry, or use the existing Billing Portal
      // (Account > Membership > Manage Membership) to cancel directly.
      if (!cancelResult.cancelled) {
        const err = new Error(
          `deleteOwnAccount: failed to cancel Stripe subscription ${entitlement.external_reference} for household ${household.id} — refusing to delete while it may still be active`
        );
        err.code = "stripe_cancel_failed";
        throw err;
      }

      await revokeStripe(household.id, { client });
      entitlementOutcome = { source: "stripe", action: "cancelled_and_revoked" };
    } else {
      // An entitlement source this function doesn't know how to safely
      // stop billing for must never be silently deleted through — fail
      // closed rather than risk leaving a customer paying with no
      // account left from which to notice.
      throw new Error(
        `deleteOwnAccount: household ${household.id} has an active entitlement from an unrecognised source "${entitlement.source}" — refusing to delete`
      );
    }
  }

  // No client override forwarded here deliberately: releaseTwilio's own
  // deps.client means its Twilio REST client, not this function's
  // Supabase client — passing the wrong one through would silently
  // replace its real Twilio client with a Postgres client. Tests inject
  // a whole fake releaseTwilio instead of reaching into its internals.
  const twilioResult = await releaseTwilio(household);

  // Deliberately not wrapped in try/catch: migration 020's own guardrail
  // (refuses while twilio_number is still set) is exactly the "clear,
  // blocked state" a genuine release failure should produce — letting
  // it throw here, rather than swallowing it, is what turns "the number
  // didn't actually release" into a loud 500 instead of a silently
  // incomplete deletion.
  await anonymizeHousehold(household.id, "user-initiated account deletion", client);

  let authUserDeleted = false;
  if (household.auth_user_id) {
    authUserDeleted = await deleteAuthUser(household.auth_user_id, client);
  }

  return {
    entitlement: entitlementOutcome,
    twilioReleased: !!twilioResult?.released,
    twilioReleaseError: twilioResult?.error || null,
    householdAnonymized: true,
    authUserDeleted,
    appleManualCancellationRequired,
  };
}

module.exports = {
  deleteOwnAccount,
  defaultCancelStripeSubscription,
  defaultAnonymizeHousehold,
  defaultDeleteAuthUser,
};
