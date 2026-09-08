// Unit + structural tests for in-app account deletion (Apple Guideline
// 5.1.1(v)): services/accountDeletion.js's deleteOwnAccount orchestrator,
// and the route wiring in routes/mobileApi.js (DELETE /api/v1/me/account).
//
// deleteOwnAccount is tested here with injected fake collaborators — no
// real Stripe/Twilio/Supabase Auth calls — matching this codebase's
// existing convention (see tests/twilio-provisioning.test.mjs,
// tests/complimentary-invites.test.mjs). Route wiring (auth middleware,
// no client-suppliable household id) is checked structurally against the
// real server.js/routes/mobileApi.js source, matching
// tests/admin-post-login-routing.test.mjs's own stated convention, since
// there's no HTTP test tooling in this project.
//
// Run with: node tests/account-deletion.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
require('dotenv').config();
const { deleteOwnAccount } = require('../services/accountDeletion.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileApiSource = readFileSync(path.join(__dirname, '..', 'routes', 'mobileApi.js'), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

function makeFakeClient() {
  return {}; // never actually touched — every entitlement/anonymize/auth
             // fake below is injected directly, so nothing dereferences this
}

const COMPLIMENTARY_HOUSEHOLD = {
  id: 'household-comp-1',
  auth_user_id: 'auth-user-comp-1',
  twilio_number: '+447700900001',
};

const REVENUECAT_HOUSEHOLD = {
  id: 'household-rc-1',
  auth_user_id: 'auth-user-rc-1',
  twilio_number: '+447700900002',
};

const STRIPE_HOUSEHOLD = {
  id: 'household-stripe-1',
  auth_user_id: 'auth-user-stripe-1',
  twilio_number: '+447700900003',
};

const NO_ENTITLEMENT_HOUSEHOLD = {
  id: 'household-none-1',
  auth_user_id: 'auth-user-none-1',
  twilio_number: null,
};

async function run() {
  // --- 1. authenticated deletion succeeds for the correct household ---
  {
    const calls = { anonymize: [], deleteAuth: [] };
    const result = await deleteOwnAccount(NO_ENTITLEMENT_HOUSEHOLD, {
      client: makeFakeClient(),
      getActiveEntitlement: async () => null,
      releaseTwilio: async (household) => {
        check(household.id === NO_ENTITLEMENT_HOUSEHOLD.id, 'releaseTwilio is called with the exact household passed in, never a different one');
        return { released: false }; // nothing to release for this household
      },
      anonymizeHousehold: async (householdId, reason) => {
        calls.anonymize.push({ householdId, reason });
      },
      deleteAuthUser: async (authUserId) => {
        calls.deleteAuth.push(authUserId);
        return true;
      },
    });

    check(result.householdAnonymized === true, 'a successful deletion reports householdAnonymized: true');
    check(
      calls.anonymize.length === 1 && calls.anonymize[0].householdId === NO_ENTITLEMENT_HOUSEHOLD.id,
      'anonymizeHousehold is called exactly once, with the correct household id'
    );
    check(
      calls.deleteAuth.length === 1 && calls.deleteAuth[0] === NO_ENTITLEMENT_HOUSEHOLD.auth_user_id,
      'the Supabase Auth user for this exact household is deleted'
    );
    check(result.authUserDeleted === true, 'authUserDeleted reports true on success');
  }

  // --- 2/3. auth + cross-household isolation: structural (real HTTP
  // tooling doesn't exist in this project — see file header) ---
  {
    const routeAnchor = 'router.delete("/api/v1/me/account"';
    const routeIdx = mobileApiSource.indexOf(routeAnchor);
    check(routeIdx !== -1, 'DELETE /api/v1/me/account is declared in routes/mobileApi.js');

    if (routeIdx !== -1) {
      // The whole handler, try/catch included — not just its first
      // inner `});` (that would stop at res.json(...)'s own close and
      // silently exclude the catch block entirely).
      const blockEnd = mobileApiSource.indexOf('\nrouter.', routeIdx + routeAnchor.length);
      const block = mobileApiSource.slice(routeIdx, blockEnd);

      check(
        mobileApiSource.slice(routeIdx, routeIdx + routeAnchor.length + 40).includes('requireAuthApi'),
        'the route is gated behind requireAuthApi — an unauthenticated request never reaches the handler (401, per requireAuthApi\'s own tested behavior)'
      );

      check(
        !/req\.(params|body|query)/.test(block),
        'the handler never reads a household id from req.params/req.body/req.query — the household to delete can only ever be req.household, resolved server-side from the caller\'s own verified token, so no request can name a different household'
      );

      check(
        block.includes('deleteOwnAccount(req.household)'),
        'the handler calls deleteOwnAccount with req.household specifically (the token-resolved household), not a client-suppliable value'
      );

      check(
        block.includes('authUserDeleted: result.authUserDeleted') && block.includes('twilioReleaseError: result.twilioReleaseError'),
        'a partial failure on the auth-user delete or Twilio release step is surfaced in the response fields, never hidden behind a bare ok: true'
      );

      check(
        block.includes('err.code || "failed"'),
        'a specific failure code (e.g. stripe_cancel_failed) from a deliberate fail-closed refusal is passed through to the client, not flattened into one generic error'
      );
    }
  }

  // --- 4a. active entitlement handled correctly: complimentary ---
  {
    const revokedCalls = [];
    const result = await deleteOwnAccount(COMPLIMENTARY_HOUSEHOLD, {
      client: makeFakeClient(),
      getActiveEntitlement: async () => ({
        id: 'ent-1',
        source: 'admin_manual',
        entitlement_type: 'complimentary',
        external_reference: null,
      }),
      revokeComplimentary: async (householdId) => {
        revokedCalls.push(householdId);
        return { revoked: true };
      },
      releaseTwilio: async () => ({ released: true, twilioNumber: COMPLIMENTARY_HOUSEHOLD.twilio_number }),
      anonymizeHousehold: async () => {},
      deleteAuthUser: async () => true,
    });

    check(
      revokedCalls.length === 1 && revokedCalls[0] === COMPLIMENTARY_HOUSEHOLD.id,
      'a complimentary entitlement is revoked via the existing revokeComplimentaryEntitlement path'
    );
    check(result.entitlement.source === 'admin_manual' && result.entitlement.action === 'revoked', 'the result reports the complimentary entitlement as revoked');
    check(result.appleManualCancellationRequired === false, 'no Apple manual-cancellation caveat for a complimentary account');
  }

  // --- 4b. active entitlement handled correctly: Apple/RevenueCat —
  // must NOT claim HCG cancelled the Apple subscription ---
  {
    const expireCalls = [];
    const result = await deleteOwnAccount(REVENUECAT_HOUSEHOLD, {
      client: makeFakeClient(),
      getActiveEntitlement: async () => ({
        id: 'ent-2',
        source: 'apple_revenuecat',
        entitlement_type: 'paid_subscription',
        external_reference: 'apple-original-txn-123',
      }),
      expireRevenueCat: async (householdId, originalTransactionId) => {
        expireCalls.push({ householdId, originalTransactionId });
        return { revoked: true };
      },
      releaseTwilio: async () => ({ released: true, twilioNumber: REVENUECAT_HOUSEHOLD.twilio_number }),
      anonymizeHousehold: async () => {},
      deleteAuthUser: async () => true,
    });

    check(
      expireCalls.length === 1 &&
        expireCalls[0].householdId === REVENUECAT_HOUSEHOLD.id &&
        expireCalls[0].originalTransactionId === 'apple-original-txn-123',
      'the RevenueCat entitlement is expired on HCG\'s own side, matched by its real original transaction id'
    );
    check(
      result.appleManualCancellationRequired === true,
      'appleManualCancellationRequired is true for an Apple/RevenueCat entitlement — HCG cannot cancel Apple\'s own billing, so the caller must tell the customer to do it themselves'
    );
    check(
      result.entitlement.action === 'hcg_access_revoked_apple_not_cancelled',
      'the reported action name itself is honest: HCG-side access revoked, Apple\'s subscription NOT cancelled by HCG'
    );
  }

  // --- 4c. active entitlement handled correctly: Stripe — HCG genuinely
  // cancels this one, since Stripe is fully under HCG's own control ---
  {
    const stripeCancelCalls = [];
    const revokeCalls = [];
    const result = await deleteOwnAccount(STRIPE_HOUSEHOLD, {
      client: makeFakeClient(),
      getActiveEntitlement: async () => ({
        id: 'ent-3',
        source: 'stripe',
        entitlement_type: 'paid_subscription',
        external_reference: 'sub_real123',
      }),
      cancelStripeSubscription: async (subscriptionId) => {
        stripeCancelCalls.push(subscriptionId);
        return { cancelled: true };
      },
      revokeStripe: async (householdId) => {
        revokeCalls.push(householdId);
        return { revoked: true };
      },
      releaseTwilio: async () => ({ released: true, twilioNumber: STRIPE_HOUSEHOLD.twilio_number }),
      anonymizeHousehold: async () => {},
      deleteAuthUser: async () => true,
    });

    check(
      stripeCancelCalls.length === 1 && stripeCancelCalls[0] === 'sub_real123',
      'the real Stripe subscription is cancelled via the API (stops the actual recurring charge) — this is the one source HCG genuinely controls'
    );
    check(revokeCalls.length === 1 && revokeCalls[0] === STRIPE_HOUSEHOLD.id, 'the Stripe-sourced entitlement row is also revoked in HCG\'s own database');
    check(result.entitlement.action === 'cancelled_and_revoked', 'the result reports both the real cancellation and the DB revoke');
  }

  // --- 4c-bis. Stripe cancellation FAILS: this must fail closed —
  // nothing else may run, and the account must be left completely
  // untouched (never anonymised/deleted while the real subscription may
  // still be billing) ---
  {
    const revokeCalls = [];
    const releaseTwilioCalls = [];
    const anonymizeCalls = [];
    const deleteAuthCalls = [];
    let threw = false;
    let thrownCode = null;

    try {
      await deleteOwnAccount(STRIPE_HOUSEHOLD, {
        client: makeFakeClient(),
        getActiveEntitlement: async () => ({
          id: 'ent-3b',
          source: 'stripe',
          entitlement_type: 'paid_subscription',
          external_reference: 'sub_real456',
        }),
        cancelStripeSubscription: async () => ({ cancelled: false, error: 'Stripe API unavailable' }),
        revokeStripe: async (householdId) => { revokeCalls.push(householdId); return { revoked: true }; },
        releaseTwilio: async () => { releaseTwilioCalls.push(1); return { released: true }; },
        anonymizeHousehold: async () => { anonymizeCalls.push(1); },
        deleteAuthUser: async () => { deleteAuthCalls.push(1); return true; },
      });
    } catch (err) {
      threw = true;
      thrownCode = err.code;
    }

    check(threw, 'a failed Stripe cancellation makes deleteOwnAccount throw, rather than proceeding with deletion');
    check(thrownCode === 'stripe_cancel_failed', 'the thrown error carries a specific, client-distinguishable code (stripe_cancel_failed), not a generic failure');
    check(revokeCalls.length === 0, 'the entitlement row is NOT revoked in the database — a real, still-possibly-active Stripe subscription must not be hidden by a DB-only revoke');
    check(releaseTwilioCalls.length === 0, 'the Twilio number is never released when the entitlement cancellation itself failed');
    check(anonymizeCalls.length === 0, 'the household is never anonymised — the customer keeps a fully intact, usable account to retry from or manage billing directly');
    check(deleteAuthCalls.length === 0, 'the Supabase Auth user is never deleted — the customer is not locked out while a real subscription may still be charging them');
  }

  // --- 4d. an active entitlement from an unrecognised source is a fail-
  // closed refusal, never a silent delete-while-still-billing ---
  {
    let threw = false;
    try {
      await deleteOwnAccount(
        { id: 'household-weird-1', auth_user_id: 'auth-weird-1', twilio_number: null },
        {
          client: makeFakeClient(),
          getActiveEntitlement: async () => ({ id: 'ent-4', source: 'some_future_payment_provider', entitlement_type: 'paid_subscription' }),
          anonymizeHousehold: async () => { throw new Error('should never be reached'); },
        }
      );
    } catch {
      threw = true;
    }
    check(threw, 'an active entitlement from an unrecognised source makes deleteOwnAccount refuse (throw) rather than delete the account while billing might still be live');
  }

  // --- 5a. Twilio release: soft failure (DB already released, only the
  // Twilio-side API call failed) — deletion still completes, failure is
  // surfaced, never silently swallowed ---
  {
    const result = await deleteOwnAccount(NO_ENTITLEMENT_HOUSEHOLD, {
      client: makeFakeClient(),
      getActiveEntitlement: async () => null,
      releaseTwilio: async () => ({ released: false, error: 'Twilio API unavailable' }),
      anonymizeHousehold: async () => {}, // DB-side twilio_number was already null, so the real RPC's guardrail wouldn't trip here
      deleteAuthUser: async () => true,
    });

    check(result.householdAnonymized === true, 'a Twilio-side-only release failure does not block the rest of the deletion');
    check(result.twilioReleaseError === 'Twilio API unavailable', 'the Twilio failure is surfaced in the result, not silently dropped');
  }

  // --- 5b. Twilio release: hard failure (the database release itself
  // failed, so a real number is still assigned) — must be a clear,
  // blocked failure, never a silent "deleted anyway" ---
  {
    let threw = false;
    let threwMessage = '';
    try {
      await deleteOwnAccount(COMPLIMENTARY_HOUSEHOLD, {
        client: makeFakeClient(),
        getActiveEntitlement: async () => null,
        releaseTwilio: async () => ({ released: false, error: 'database error releasing number' }),
        // Mirrors the real anonymize_inactive_household RPC's own guardrail:
        // it refuses whenever a twilio_number is still genuinely assigned.
        anonymizeHousehold: async () => {
          throw new Error('anonymize_inactive_household: household still has an assigned Twilio number');
        },
      });
    } catch (err) {
      threw = true;
      threwMessage = err.message;
    }
    check(threw, 'a genuine (database-level) Twilio release failure blocks the deletion with a clear, loud error rather than anonymising a household with a live number still attached');
    check(threwMessage.includes('Twilio number'), 'the error clearly names the Twilio number as the reason for the block');
  }

  // --- 6. repeated deletion request is safe/idempotent ---
  {
    const household = { id: 'household-repeat-1', auth_user_id: 'auth-repeat-1', twilio_number: '+447700900099' };
    let entitlementAlreadyGone = false;
    let twilioAlreadyReleased = false;

    const deps = {
      client: makeFakeClient(),
      getActiveEntitlement: async () => (entitlementAlreadyGone ? null : { id: 'ent-5', source: 'admin_manual', entitlement_type: 'complimentary' }),
      revokeComplimentary: async () => {
        entitlementAlreadyGone = true;
        return { revoked: true };
      },
      releaseTwilio: async () => {
        const wasAlreadyReleased = twilioAlreadyReleased;
        twilioAlreadyReleased = true;
        return wasAlreadyReleased ? { released: false } : { released: true, twilioNumber: household.twilio_number };
      },
      anonymizeHousehold: async () => {}, // real RPC is itself idempotent — re-applies the same anonymised values
      deleteAuthUser: async (authUserId, callIndex = { n: 0 }) => {
        // First call succeeds; a second call against an already-deleted
        // auth user is exactly what the real Supabase Admin API returns
        // an error for — defaultDeleteAuthUser already turns that into
        // `false`, never a thrown error, which is what's asserted below.
        return !twilioAlreadyReleased ? true : false;
      },
    };

    const first = await deleteOwnAccount(household, deps);
    let secondThrew = false;
    let second;
    try {
      second = await deleteOwnAccount(household, deps);
    } catch {
      secondThrew = true;
    }

    check(first.householdAnonymized === true, 'the first deletion call succeeds');
    check(!secondThrew, 'calling deleteOwnAccount again for the same (already-deleted) household does not throw');
    check(second && second.householdAnonymized === true, 'a repeated call still reports success rather than a crash — safe to retry after a dropped response');
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
