// Unit tests for services/twilioProvisioning.js — the Severity 1 fix for
// "no new customer is ever assigned a Twilio number" (see
// docs/launch/KNOWN_ISSUES.md). Pure functions and the orchestrator are
// tested here with injected fake Twilio/database collaborators — no real
// Twilio API calls or Supabase writes. The RPC-level guarantees (the
// actual idempotent, race-safe database write) are covered separately in
// tests/migrations.pglite.test.mjs against a real Postgres-compatible
// engine, since that's a SQL-level guarantee this file cannot exercise.
//
// Run with: node tests/twilio-provisioning.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const {
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
} = require('../services/twilioProvisioning.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- shouldAttemptProvisioning ---

check(
  shouldAttemptProvisioning({ twilio_number: null, twilio_provisioning_attempts: 0 }) === true,
  'a household with no number and no failed attempts should be provisioned'
);

check(
  shouldAttemptProvisioning({ twilio_number: '+447700900123', twilio_provisioning_attempts: 0 }) === false,
  'a household that already has a number is never re-provisioned (duplicate prevention)'
);

check(
  shouldAttemptProvisioning({ twilio_number: null, twilio_provisioning_attempts: 5 }, { maxAttempts: 5 }) === false,
  'a household at the attempt cap stops being retried automatically (flagged for admin attention instead)'
);

check(
  shouldAttemptProvisioning({ twilio_number: null, twilio_provisioning_attempts: 4 }, { maxAttempts: 5 }) === true,
  'a household just under the attempt cap is still retried'
);

check(
  shouldAttemptProvisioning(null) === false,
  'a missing household is handled without throwing'
);

// --- pickAvailableNumber ---

check(
  pickAvailableNumber([{ phoneNumber: '+447700900111' }, { phoneNumber: '+447700900222' }]).phoneNumber === '+447700900111',
  'pickAvailableNumber chooses the first search result'
);

check(
  pickAvailableNumber([]) === null,
  'pickAvailableNumber returns null when no numbers are available'
);

// --- buildIncomingPhoneNumberParams ---

const params = buildIncomingPhoneNumberParams({
  phoneNumber: '+447700900123',
  appUrl: 'https://www.homecallguard.co.uk',
});

check(
  params.phoneNumber === '+447700900123' &&
    params.voiceUrl === 'https://www.homecallguard.co.uk/voice' &&
    params.voiceMethod === 'POST',
  'a purchased number is configured to send voice webhooks to this app\'s own /voice route'
);

check(
  !('addressSid' in params),
  'addressSid is omitted entirely (not sent as null/undefined) when not supplied — behaviour is unchanged from before this fix while TWILIO_ADDRESS_SID remains unset'
);

const paramsWithAddress = buildIncomingPhoneNumberParams({
  phoneNumber: '+447700900123',
  appUrl: 'https://www.homecallguard.co.uk',
  addressSid: 'AD1234567890abcdef1234567890abcdef',
});

check(
  paramsWithAddress.addressSid === 'AD1234567890abcdef1234567890abcdef',
  'addressSid is included in the purchase params when supplied'
);

check(
  !('bundleSid' in params),
  'bundleSid is omitted entirely (not sent as null/undefined) when not supplied — behaviour is unchanged from before this fix while TWILIO_BUNDLE_SID remains unset'
);

const paramsWithBundle = buildIncomingPhoneNumberParams({
  phoneNumber: '+447700900123',
  appUrl: 'https://www.homecallguard.co.uk',
  bundleSid: 'BU1234567890abcdef1234567890abcdef',
});

check(
  paramsWithBundle.bundleSid === 'BU1234567890abcdef1234567890abcdef',
  'bundleSid is included in the purchase params when supplied'
);

const paramsWithBoth = buildIncomingPhoneNumberParams({
  phoneNumber: '+447700900123',
  appUrl: 'https://www.homecallguard.co.uk',
  addressSid: 'AD1234567890abcdef1234567890abcdef',
  bundleSid: 'BU1234567890abcdef1234567890abcdef',
});

check(
  paramsWithBoth.addressSid === 'AD1234567890abcdef1234567890abcdef' &&
    paramsWithBoth.bundleSid === 'BU1234567890abcdef1234567890abcdef',
  'addressSid and bundleSid are both passed together when both are configured — the actual UK regulatory requirement (Address alone was proven insufficient)'
);

// --- ensureTwilioNumberProvisioned (orchestration, fake collaborators) ---

// Build a client shaped closely enough to the real Twilio SDK for this
// orchestrator's exact call sites: `client.incomingPhoneNumbers.create(...)`
// and `client.incomingPhoneNumbers(sid).remove()`.
function makeFakeTwilioClient({ available = [{ phoneNumber: '+447700900456' }], purchaseThrows = null } = {}) {
  const calls = { list: 0, create: 0, remove: 0, lastCreateParams: null };

  const incomingPhoneNumbers = (sid) => ({
    remove: async () => {
      calls.remove++;
      return true;
    },
  });
  incomingPhoneNumbers.create = async (params) => {
    calls.create++;
    calls.lastCreateParams = params;
    if (purchaseThrows) throw purchaseThrows;
    return { sid: 'PN_test_123', phoneNumber: params.phoneNumber };
  };

  return {
    calls,
    availablePhoneNumbers: () => ({
      local: { list: async () => { calls.list++; return available; } },
    }),
    incomingPhoneNumbers,
  };
}

function makeFakeAssign(result) {
  const calls = [];
  return {
    calls,
    fn: async (householdId, twilioNumber) => {
      calls.push({ householdId, twilioNumber });
      return typeof result === 'function' ? result(householdId, twilioNumber) : result;
    },
  };
}

function makeFakeCancelPendingRelease() {
  const calls = [];
  return {
    calls,
    fn: async (householdId) => {
      calls.push({ householdId });
    },
  };
}

function makeFakeMarkPendingRelease(result) {
  const calls = [];
  return {
    calls,
    fn: async (householdId, gracePeriodDays) => {
      calls.push({ householdId, gracePeriodDays });
      return result;
    },
  };
}

function makeFakeRecordFailure() {
  const calls = [];
  return {
    calls,
    fn: async (householdId, message) => {
      calls.push({ householdId, message });
    },
  };
}

// No-op fake for the injectable alert dependency (2026-09 fix) — a
// real, un-injected sendCriticalAlert call here would make a genuine
// HTTPS request to Resend whenever a real Resend_API_Key happens to be
// configured (this file's own `require('dotenv').config()` above loads
// exactly that from a real .env). Every call is recorded so tests can
// assert what would have been sent, without ever sending it.
function makeFakeSendAlert() {
  const calls = [];
  return {
    calls,
    fn: async (type, message, context) => {
      calls.push({ type, message, context });
      return true;
    },
  };
}

async function run() {
  // --- successful provisioning ---
  {
    const client = makeFakeTwilioClient();
    const assign = makeFakeAssign(true);
    const recordFailure = makeFakeRecordFailure();

    const result = await ensureTwilioNumberProvisioned(
      { id: 'household-1', twilio_number: null, twilio_provisioning_attempts: 0 },
      { client, assign: assign.fn, recordFailure: recordFailure.fn, appUrl: 'https://app.example.com' }
    );

    check(
      result.success === true && result.twilioNumber === '+447700900456',
      'successful provisioning purchases a number and reports it back'
    );
    check(
      assign.calls.length === 1 && assign.calls[0].twilioNumber === '+447700900456',
      'successful provisioning assigns the purchased number to the correct household'
    );
    check(
      recordFailure.calls.length === 0,
      'successful provisioning never records a failure'
    );
    check(
      !('addressSid' in client.calls.lastCreateParams),
      'with no addressSid configured (matching production today), the real Twilio purchase call is sent without one — zero behaviour change from before this fix'
    );
    check(
      !('bundleSid' in client.calls.lastCreateParams),
      'with no bundleSid configured, the real Twilio purchase call is sent without one — zero behaviour change from before this fix'
    );
  }

  // --- backwards-compatibility regression: both TWILIO_ADDRESS_SID and
  // TWILIO_BUNDLE_SID unset (this codebase's actual state before either
  // fix was configured in production) — the request Twilio receives must
  // be byte-for-byte identical to before either fix existed. ---
  {
    const previousAddress = process.env.TWILIO_ADDRESS_SID;
    const previousBundle = process.env.TWILIO_BUNDLE_SID;
    delete process.env.TWILIO_ADDRESS_SID;
    delete process.env.TWILIO_BUNDLE_SID;

    const client = makeFakeTwilioClient();
    const assign = makeFakeAssign(true);
    const recordFailure = makeFakeRecordFailure();

    const result = await ensureTwilioNumberProvisioned(
      { id: 'household-backcompat', twilio_number: null, twilio_provisioning_attempts: 0 },
      { client, assign: assign.fn, recordFailure: recordFailure.fn, appUrl: 'https://app.example.com' }
    );

    check(
      result.success === true,
      'backwards compatibility: provisioning still succeeds when both TWILIO_ADDRESS_SID and TWILIO_BUNDLE_SID are unset'
    );
    check(
      JSON.stringify(Object.keys(client.calls.lastCreateParams).sort()) === JSON.stringify(['phoneNumber', 'voiceMethod', 'voiceUrl'].sort()),
      'backwards compatibility: with both env vars unset, the exact set of keys sent to Twilio is phoneNumber/voiceUrl/voiceMethod only — identical to the request shape before either fix was introduced'
    );

    if (previousAddress === undefined) delete process.env.TWILIO_ADDRESS_SID; else process.env.TWILIO_ADDRESS_SID = previousAddress;
    if (previousBundle === undefined) delete process.env.TWILIO_BUNDLE_SID; else process.env.TWILIO_BUNDLE_SID = previousBundle;
  }

  // --- addressSid pass-through: the actual fix this test file was extended for ---
  {
    const client = makeFakeTwilioClient();
    const assign = makeFakeAssign(true);
    const recordFailure = makeFakeRecordFailure();

    const result = await ensureTwilioNumberProvisioned(
      { id: 'household-addresssid', twilio_number: null, twilio_provisioning_attempts: 0 },
      {
        client, assign: assign.fn, recordFailure: recordFailure.fn,
        appUrl: 'https://app.example.com', addressSid: 'ADfeedfacefeedfacefeedfacefeedface',
      }
    );

    check(
      result.success === true,
      'providing an addressSid does not change the success path'
    );
    check(
      client.calls.lastCreateParams.addressSid === 'ADfeedfacefeedfacefeedfacefeedface',
      'when an addressSid is configured, it is forwarded to the real Twilio purchase call — this is the actual fix for "Phone Number Requires an Address"'
    );
  }

  // --- addressSid defaults from process.env.TWILIO_ADDRESS_SID when not passed explicitly ---
  {
    const previous = process.env.TWILIO_ADDRESS_SID;
    process.env.TWILIO_ADDRESS_SID = 'ADenvvalueenvvalueenvvalueenvvalue01';

    const client = makeFakeTwilioClient();
    const assign = makeFakeAssign(true);
    const recordFailure = makeFakeRecordFailure();

    const result = await ensureTwilioNumberProvisioned(
      { id: 'household-addresssid-env', twilio_number: null, twilio_provisioning_attempts: 0 },
      { client, assign: assign.fn, recordFailure: recordFailure.fn, appUrl: 'https://app.example.com' }
    );

    check(
      client.calls.lastCreateParams.addressSid === 'ADenvvalueenvvalueenvvalueenvvalue01',
      'addressSid defaults from process.env.TWILIO_ADDRESS_SID, matching every other Twilio credential in this file (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN) — this is the only line production needs to configure once a real Address object exists'
    );

    if (previous === undefined) {
      delete process.env.TWILIO_ADDRESS_SID;
    } else {
      process.env.TWILIO_ADDRESS_SID = previous;
    }
  }

  // --- bundleSid pass-through: the actual fix this block was added for ---
  {
    const client = makeFakeTwilioClient();
    const assign = makeFakeAssign(true);
    const recordFailure = makeFakeRecordFailure();

    const result = await ensureTwilioNumberProvisioned(
      { id: 'household-bundlesid', twilio_number: null, twilio_provisioning_attempts: 0 },
      {
        client, assign: assign.fn, recordFailure: recordFailure.fn,
        appUrl: 'https://app.example.com', bundleSid: 'BUfeedfacefeedfacefeedfacefeedface',
      }
    );

    check(
      result.success === true,
      'providing a bundleSid does not change the success path'
    );
    check(
      client.calls.lastCreateParams.bundleSid === 'BUfeedfacefeedfacefeedfacefeedface',
      'when a bundleSid is configured, it is forwarded to the real Twilio purchase call — this is the fix for "Bundle required and not provided for country: [GB] and numberType: [LOCAL]"'
    );
  }

  // --- bundleSid defaults from process.env.TWILIO_BUNDLE_SID when not passed explicitly ---
  {
    const previous = process.env.TWILIO_BUNDLE_SID;
    process.env.TWILIO_BUNDLE_SID = 'BUenvvalueenvvalueenvvalueenvvalue01';

    const client = makeFakeTwilioClient();
    const assign = makeFakeAssign(true);
    const recordFailure = makeFakeRecordFailure();

    const result = await ensureTwilioNumberProvisioned(
      { id: 'household-bundlesid-env', twilio_number: null, twilio_provisioning_attempts: 0 },
      { client, assign: assign.fn, recordFailure: recordFailure.fn, appUrl: 'https://app.example.com' }
    );

    check(
      client.calls.lastCreateParams.bundleSid === 'BUenvvalueenvvalueenvvalueenvvalue01',
      'bundleSid defaults from process.env.TWILIO_BUNDLE_SID, matching TWILIO_ADDRESS_SID\'s pattern — this is the only line production needs to configure once the approved bundle SID is known'
    );

    if (previous === undefined) {
      delete process.env.TWILIO_BUNDLE_SID;
    } else {
      process.env.TWILIO_BUNDLE_SID = previous;
    }
  }

  // --- addressSid and bundleSid both configured together: the actual UK
  // regulatory requirement — Address alone was proven insufficient by a
  // real Twilio purchase attempt, so this combination is what production
  // must send. ---
  {
    const client = makeFakeTwilioClient();
    const assign = makeFakeAssign(true);
    const recordFailure = makeFakeRecordFailure();

    const result = await ensureTwilioNumberProvisioned(
      { id: 'household-both-sids', twilio_number: null, twilio_provisioning_attempts: 0 },
      {
        client, assign: assign.fn, recordFailure: recordFailure.fn,
        appUrl: 'https://app.example.com',
        addressSid: 'ADbothbothbothbothbothbothbothboth',
        bundleSid: 'BUbothbothbothbothbothbothbothboth',
      }
    );

    check(
      result.success === true,
      'providing both addressSid and bundleSid together does not change the success path'
    );
    check(
      client.calls.lastCreateParams.addressSid === 'ADbothbothbothbothbothbothbothboth' &&
        client.calls.lastCreateParams.bundleSid === 'BUbothbothbothbothbothbothbothboth',
      'when both addressSid and bundleSid are configured, both are forwarded together to the real Twilio purchase call'
    );
  }

  // --- duplicate prevention: household already has a number ---
  {
    const client = makeFakeTwilioClient();
    const assign = makeFakeAssign(true);
    const recordFailure = makeFakeRecordFailure();

    const result = await ensureTwilioNumberProvisioned(
      { id: 'household-2', twilio_number: '+447700900999', twilio_provisioning_attempts: 0 },
      { client, assign: assign.fn, recordFailure: recordFailure.fn, appUrl: 'https://app.example.com' }
    );

    check(
      result.attempted === false,
      'a household that already has a number is skipped entirely (no Twilio API call at all)'
    );
    check(
      client.calls.list === 0 && client.calls.create === 0,
      'duplicate prevention never touches the Twilio API for an already-provisioned household'
    );
  }

  // --- retry behaviour: Twilio purchase fails, then a later call succeeds ---
  {
    const client = makeFakeTwilioClient({ purchaseThrows: new Error('Twilio account suspended') });
    const assign = makeFakeAssign(true);
    const recordFailure = makeFakeRecordFailure();
    const sendAlert = makeFakeSendAlert();

    const household = { id: 'household-3', twilio_number: null, twilio_provisioning_attempts: 0 };
    const firstAttempt = await ensureTwilioNumberProvisioned(household, {
      client, assign: assign.fn, recordFailure: recordFailure.fn, sendAlert: sendAlert.fn, appUrl: 'https://app.example.com',
    });

    check(
      firstAttempt.success === false && firstAttempt.error === 'Twilio account suspended',
      'a Twilio API failure is reported, not thrown'
    );
    check(
      recordFailure.calls.length === 1 && recordFailure.calls[0].message === 'Twilio account suspended',
      'a failed attempt is recorded (attempt count / last error) rather than silently dropped'
    );

    // Regression test (2026-09): proves the alert dependency is
    // genuinely injected — not just present as an unused parameter —
    // and confirms this is the ONLY way to observe the alert in a test:
    // no real network/email call happens here at all.
    check(
      sendAlert.calls.length === 1,
      'the injected fake alert function is called exactly once on a Twilio provisioning failure — never the real sendCriticalAlert during a test'
    );
    check(
      sendAlert.calls[0] &&
        sendAlert.calls[0].type === 'twilio_provisioning_failed' &&
        sendAlert.calls[0].message === 'Twilio number provisioning failed: Twilio account suspended' &&
        sendAlert.calls[0].context &&
        sendAlert.calls[0].context.householdId === 'household-3',
      'the alert call carries the expected type, message, and householdId context'
    );

    // Simulate the next webhook/reconcile call retrying, now with a
    // working Twilio client — mirrors how attempts accumulate across
    // real calls in database/households.js.
    const workingClient = makeFakeTwilioClient();
    const retriedHousehold = { ...household, twilio_provisioning_attempts: 1 };
    const secondAttempt = await ensureTwilioNumberProvisioned(retriedHousehold, {
      client: workingClient, assign: assign.fn, recordFailure: recordFailure.fn, sendAlert: sendAlert.fn, appUrl: 'https://app.example.com',
    });

    check(
      secondAttempt.success === true,
      'a subsequent retry succeeds once the underlying Twilio issue is resolved'
    );
    check(
      sendAlert.calls.length === 1,
      'no additional alert is sent on the successful retry — only the original failure triggered one'
    );
  }

  // --- retry cutoff: a household at the attempt cap is never retried automatically ---
  {
    const client = makeFakeTwilioClient();
    const assign = makeFakeAssign(true);
    const recordFailure = makeFakeRecordFailure();

    const result = await ensureTwilioNumberProvisioned(
      { id: 'household-4', twilio_number: null, twilio_provisioning_attempts: 5 },
      { client, assign: assign.fn, recordFailure: recordFailure.fn, appUrl: 'https://app.example.com', maxAttempts: 5 }
    );

    check(
      result.attempted === false && client.calls.list === 0,
      'a household that has exhausted its retry budget is left flagged rather than retried forever'
    );
  }

  // --- race: two concurrent attempts, this one loses and releases its purchase ---
  {
    const client = makeFakeTwilioClient();
    const assign = makeFakeAssign(false); // RPC reports a different number already assigned
    const recordFailure = makeFakeRecordFailure();

    const result = await ensureTwilioNumberProvisioned(
      { id: 'household-5', twilio_number: null, twilio_provisioning_attempts: 0 },
      { client, assign: assign.fn, recordFailure: recordFailure.fn, appUrl: 'https://app.example.com' }
    );

    check(
      result.success === false && client.calls.remove === 1,
      'losing a provisioning race releases the redundant purchased number rather than leaving it orphaned'
    );
    check(
      recordFailure.calls.length === 0,
      'a resolved race is not recorded as a failure — the household ends up correctly provisioned by the other attempt'
    );
  }

  // --- Twilio not configured at all ---
  {
    const assign = makeFakeAssign(true);
    const recordFailure = makeFakeRecordFailure();

    const result = await ensureTwilioNumberProvisioned(
      { id: 'household-6', twilio_number: null, twilio_provisioning_attempts: 0 },
      { client: null, assign: assign.fn, recordFailure: recordFailure.fn, appUrl: 'https://app.example.com' }
    );

    check(
      result.success === false && recordFailure.calls.length === 1,
      'a missing Twilio configuration is recorded as a failure rather than crashing the caller'
    );
  }

  // --- pickMatchingIncomingNumber / findTwilioIncomingNumberSid ---

  check(
    pickMatchingIncomingNumber([{ sid: 'PN_a' }, { sid: 'PN_b' }]).sid === 'PN_a',
    'pickMatchingIncomingNumber chooses the first match'
  );
  check(
    pickMatchingIncomingNumber([]) === null,
    'pickMatchingIncomingNumber returns null when nothing matches'
  );

  {
    const client = {
      incomingPhoneNumbers: Object.assign(() => {}, {
        list: async ({ phoneNumber }) => (phoneNumber === '+447700900001' ? [{ sid: 'PN_found' }] : []),
      }),
    };
    const sid = await findTwilioIncomingNumberSid(client, '+447700900001');
    check(sid === 'PN_found', 'findTwilioIncomingNumberSid resolves a phone number to its Twilio resource SID');

    const missingSid = await findTwilioIncomingNumberSid(client, '+447700900999');
    check(missingSid === null, 'findTwilioIncomingNumberSid returns null when no resource matches');
  }

  // --- releaseExpiredTwilioNumber (P0 Batch 1, component D: now
  // QUARANTINES rather than genuinely releasing — see migration 037) ---

  function makeFakeReleaseClient() {
    const calls = { remove: [] };
    const incomingPhoneNumbers = (sid) => ({
      remove: async () => { calls.remove.push(sid); return true; },
    });
    incomingPhoneNumbers.list = async ({ phoneNumber }) => [{ sid: `SID-${phoneNumber}` }];
    return { calls, incomingPhoneNumbers };
  }

  {
    // household not actually eligible (no pending deadline at all) — must
    // not even ask the database, since there's nothing to do.
    const release = async () => { throw new Error('should not be called'); };
    const quarantine = async () => { throw new Error('should not be called'); };

    const result = await releaseExpiredTwilioNumber(
      { id: 'household-10', twilio_number: '+447700900001', twilio_number_pending_release_at: null },
      { release, quarantine }
    );

    check(result.released === false, 'a household with no pending-release deadline is left alone');
  }

  {
    // database says not yet eligible (deadline hasn't passed) — nothing
    // is quarantined.
    const release = async () => false;
    const quarantineCalls = [];
    const quarantine = async (...args) => { quarantineCalls.push(args); };

    const result = await releaseExpiredTwilioNumber(
      { id: 'household-11', twilio_number: '+447700900001', twilio_number_pending_release_at: new Date(Date.now() + 86400000).toISOString() },
      { release, quarantine }
    );

    check(
      result.released === false && quarantineCalls.length === 0,
      'the database is the sole authority on eligibility — nothing is quarantined when it says not yet'
    );
  }

  {
    // database confirms eligibility — quarantine begins correctly. This
    // is the explicit correction (2026-09-10): the number must NOT be
    // released to Twilio just because the grace period elapsed — it
    // must never call Twilio's real .remove() at this stage at all.
    const quarantineCalls = [];
    const release = async () => true;
    const quarantine = async (householdId, twilioNumber, releaseReason, sid) => {
      quarantineCalls.push({ householdId, twilioNumber, releaseReason, sid });
    };

    const result = await releaseExpiredTwilioNumber(
      { id: 'household-12', twilio_number: '+447700900001', twilio_number_pending_release_at: new Date(Date.now() - 1000).toISOString() },
      { release, quarantine, client: undefined }
    );

    check(
      result.released === false && result.quarantined === true && result.twilioNumber === '+447700900001',
      'once the database confirms eligibility, the number is quarantined (result.quarantined), never genuinely released (result.released stays false)'
    );
    check(
      quarantineCalls.length === 1 &&
        quarantineCalls[0].householdId === 'household-12' &&
        quarantineCalls[0].twilioNumber === '+447700900001' &&
        quarantineCalls[0].releaseReason === 'subscription_grace_expired',
      'the quarantine insert is called exactly once, with the correct household, number, and release reason'
    );
  }

  {
    // .remove() must never be called from this path — findSid (a
    // read-only .list() lookup, to capture the SID onto the quarantine
    // row up front, migration 037) is allowed and best-effort; a failure
    // there is swallowed and never blocks the quarantine itself.
    const release = async () => true;
    const quarantineCalls = [];
    const quarantine = async (householdId, twilioNumber, releaseReason, sid) => {
      quarantineCalls.push({ sid });
      return { id: 'q-1' };
    };
    const client = {
      incomingPhoneNumbers: Object.assign(
        () => { throw new Error('.remove() must never be reachable from this path'); },
        { list: async ({ phoneNumber }) => [{ sid: `SID-${phoneNumber}` }] }
      ),
    };

    const result = await releaseExpiredTwilioNumber(
      { id: 'household-12b', twilio_number: '+447700900001', twilio_number_pending_release_at: new Date(Date.now() - 1000).toISOString() },
      { release, quarantine, client }
    );

    check(result.quarantined === true, 'quarantining still succeeds when a real client is present and findSid succeeds');
    check(quarantineCalls[0].sid === 'SID-+447700900001', 'the SID found via the read-only lookup is passed through to the quarantine insert, captured up front rather than relying solely on a later re-search');
  }

  {
    // the SID lookup itself failing (e.g. Twilio API briefly down) must
    // never block the quarantine — the DB-first write already succeeded,
    // and the SID can still be found later via the release-time fallback
    // search (see releaseQuarantinedTwilioNumber's own test below).
    const release = async () => true;
    const quarantineCalls = [];
    const quarantine = async (householdId, twilioNumber, releaseReason, sid) => {
      quarantineCalls.push({ sid });
    };
    const client = {
      incomingPhoneNumbers: Object.assign(
        () => { throw new Error('.remove() must never be reachable from this path'); },
        { list: async () => { throw new Error('Twilio API unavailable'); } }
      ),
    };

    const result = await releaseExpiredTwilioNumber(
      { id: 'household-12c', twilio_number: '+447700900001', twilio_number_pending_release_at: new Date(Date.now() - 1000).toISOString() },
      { release, quarantine, client }
    );

    check(result.quarantined === true, 'a failed SID lookup never blocks quarantining the number');
    check(quarantineCalls[0].sid === null, 'the SID is simply null when the lookup failed, not a thrown error');
  }

  // --- releaseTwilioNumberImmediately (used by services/accountDeletion.js
  // — also now QUARANTINES rather than genuinely releasing, closing the
  // same unsafe-release gap for account deletion, not just subscription
  // cancellation) ---

  {
    const releaseImmediately = async () => null;
    const quarantine = async () => { throw new Error('should not be called'); };

    const result = await releaseTwilioNumberImmediately(
      { id: 'household-13', twilio_number: null },
      { releaseImmediately, quarantine }
    );

    check(
      result.released === false,
      'immediate release on a household with nothing to release never quarantines anything'
    );
  }

  {
    const quarantineCalls = [];
    const releaseImmediately = async () => '+447700900042';
    const quarantine = async (householdId, twilioNumber, releaseReason, sid) => {
      quarantineCalls.push({ householdId, twilioNumber, releaseReason, sid });
    };

    const result = await releaseTwilioNumberImmediately(
      { id: 'household-14', twilio_number: '+447700900042' },
      { releaseImmediately, quarantine, client: undefined }
    );

    check(
      result.released === false && result.quarantined === true && result.twilioNumber === '+447700900042',
      'account deletion: the number is quarantined, never genuinely released via Twilio at this stage — an explicit, deliberate account-deletion request does not by itself prove carrier-level forwarding was removed'
    );
    check(
      quarantineCalls.length === 1 && quarantineCalls[0].releaseReason === 'account_deletion',
      'the quarantine row is tagged with release_reason "account_deletion", distinguishing it from the subscription-cancellation path'
    );
  }

  // --- releaseQuarantinedTwilioNumber: stage 2 — the ONLY path that may
  // still call Twilio's real .remove() ---

  {
    // unconfirmed deactivation must NEVER be released, no matter how the
    // function is called — this is the core safety property of the whole
    // quarantine design, re-checked defensively even though the caller
    // (findConfirmedUnreleasedQuarantine) already filters for this.
    const client = makeFakeReleaseClient();
    const result = await releaseQuarantinedTwilioNumber(
      { id: 'q-1', household_id: 'household-20', twilio_number: '+447700900050', deactivation_confirmed: false, released_at: null },
      { client }
    );
    check(
      result.released === false && client.calls.remove.length === 0,
      'an UNCONFIRMED quarantine row is never released, even when passed directly to the release function — Twilio is never called'
    );
  }

  {
    // already-released rows are never released twice.
    const client = makeFakeReleaseClient();
    const result = await releaseQuarantinedTwilioNumber(
      { id: 'q-2', household_id: 'household-21', twilio_number: '+447700900051', deactivation_confirmed: true, released_at: '2026-09-01T00:00:00.000Z' },
      { client }
    );
    check(
      result.released === false && client.calls.remove.length === 0,
      'an already-released quarantine row is never released again'
    );
  }

  {
    // confirmed deactivation IS eligible for the defined release pathway
    // — Twilio's real API is genuinely called here, only here.
    const client = makeFakeReleaseClient();
    const markReleasedCalls = [];
    const markReleased = async (id) => { markReleasedCalls.push(id); };

    const result = await releaseQuarantinedTwilioNumber(
      { id: 'q-3', household_id: 'household-22', twilio_number: '+447700900052', deactivation_confirmed: true, released_at: null },
      { client, markReleased }
    );

    check(
      result.released === true && client.calls.remove.length === 1 && client.calls.remove[0] === 'SID-+447700900052',
      'a CONFIRMED, not-yet-released quarantine row is genuinely released via Twilio\'s real API'
    );
    check(
      markReleasedCalls.length === 1 && markReleasedCalls[0] === 'q-3',
      'the quarantine row is marked released in the database after the Twilio call succeeds'
    );
  }

  {
    // a null/missing row is handled defensively, never throws.
    const result = await releaseQuarantinedTwilioNumber(null, {});
    check(result.released === false, 'a null quarantine row is handled defensively — never released, never throws');
  }

  {
    // when the row already carries a twilio_sid (captured up front at
    // quarantine time, migration 037), it is used directly — the
    // phone-number search (findSid/.list()) is never even attempted, so
    // this genuinely does not depend on household_id or the household
    // row still existing at all.
    const listCalls = [];
    const removeCalls = [];
    const client = {
      incomingPhoneNumbers: Object.assign(
        (sid) => ({ remove: async () => { removeCalls.push(sid); return true; } }),
        { list: async (args) => { listCalls.push(args); return []; } }
      ),
    };
    const markReleased = async () => {};

    const result = await releaseQuarantinedTwilioNumber(
      { id: 'q-4', household_id: null, twilio_number: '+447700900053', twilio_sid: 'PN_captured_up_front', deactivation_confirmed: true, released_at: null },
      { client, markReleased }
    );

    check(result.released === true, 'a row with a pre-captured SID and a null household_id (e.g. after a future household hard-delete) still releases correctly');
    check(removeCalls.length === 1 && removeCalls[0] === 'PN_captured_up_front', 'the pre-captured SID is used directly for the Twilio .remove() call');
    check(listCalls.length === 0, 'no phone-number search is performed at all when the SID is already known — this never depends on the household record');
  }

  // --- updateTwilioNumberForEntitlementChange: the single policy switchboard ---

  {
    // entitled + no number yet -> provisions
    const client = makeFakeTwilioClient();
    const assign = makeFakeAssign(true);
    const cancelPendingRelease = makeFakeCancelPendingRelease();
    const markPendingRelease = makeFakeMarkPendingRelease(true);

    const result = await updateTwilioNumberForEntitlementChange(
      { id: 'household-20', twilio_number: null, twilio_provisioning_attempts: 0 },
      true,
      { client, assign: assign.fn, cancelPendingRelease: cancelPendingRelease.fn, markPendingRelease: markPendingRelease.fn, appUrl: 'https://app.example.com' }
    );

    check(
      result.action === 'provision' && result.success === true,
      'entitled + no number yet -> provisions a new number'
    );
    check(
      cancelPendingRelease.calls.length === 1,
      'becoming entitled always cancels any pending release, even if none was actually pending'
    );
  }

  {
    // entitled + already has a number -> cancels pending release, does not re-purchase
    const client = makeFakeTwilioClient();
    const cancelPendingRelease = makeFakeCancelPendingRelease();
    const markPendingRelease = makeFakeMarkPendingRelease(true);

    const result = await updateTwilioNumberForEntitlementChange(
      { id: 'household-21', twilio_number: '+447700900001', twilio_provisioning_attempts: 0 },
      true,
      { client, cancelPendingRelease: cancelPendingRelease.fn, markPendingRelease: markPendingRelease.fn }
    );

    check(
      result.action === 'provision' && result.attempted === false && client.calls.create === 0,
      'entitled + already has a number -> no re-purchase (still provisioning-idempotent)'
    );
    check(
      cancelPendingRelease.calls.length === 1,
      'a household reactivating before its grace-period deadline gets that deadline cancelled, keeping the same number'
    );
  }

  {
    // not entitled + has a number -> marks for release
    const markPendingRelease = makeFakeMarkPendingRelease(true);

    const result = await updateTwilioNumberForEntitlementChange(
      { id: 'household-22', twilio_number: '+447700900001' },
      false,
      { markPendingRelease: markPendingRelease.fn }
    );

    check(
      result.action === 'mark-pending-release' && result.marked === true,
      'not entitled + has a number -> starts the grace-period clock rather than releasing immediately'
    );
    check(
      markPendingRelease.calls.length === 1 && markPendingRelease.calls[0].householdId === 'household-22',
      'the correct household is passed to the pending-release mark'
    );
  }

  {
    // not entitled + never had a number -> no-op
    const markPendingRelease = makeFakeMarkPendingRelease(true);

    const result = await updateTwilioNumberForEntitlementChange(
      { id: 'household-23', twilio_number: null },
      false,
      { markPendingRelease: markPendingRelease.fn }
    );

    check(
      result.action === 'none' && markPendingRelease.calls.length === 0,
      'not entitled + never had a number -> nothing to release, nothing attempted'
    );
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
