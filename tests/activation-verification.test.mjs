// Unit tests for services/activationVerification.js — the "is this call
// recent enough to count as proof call forwarding actually works" check
// used by both POST /activation-verify (server.js, web) and
// POST /api/v1/activation/verify (routes/mobileApi.js, mobile). Pure
// function, no network/DB involved.
//
// Run with: node tests/activation-verification.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  ACTIVATION_VERIFY_WINDOW_MS,
  isCallWithinVerificationWindow,
  stampActivationVerifiedOnRealCall,
} = require('../services/activationVerification.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
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

check(ACTIVATION_VERIFY_WINDOW_MS === 30 * 60 * 1000, 'the verification window is 30 minutes');

const now = new Date('2026-08-15T12:00:00.000Z');

check(
  isCallWithinVerificationWindow({ created_at: '2026-08-15T11:59:00.000Z' }, now) === true,
  'a call one minute ago is within the window'
);
check(
  isCallWithinVerificationWindow({ created_at: '2026-08-15T11:30:00.000Z' }, now) === true,
  'a call exactly 30 minutes ago is within the window (inclusive boundary)'
);
check(
  isCallWithinVerificationWindow({ created_at: '2026-08-15T11:29:59.000Z' }, now) === false,
  'a call 30 minutes and 1 second ago is outside the window — a stale, possibly abandoned setup attempt must not count as current proof'
);
check(
  isCallWithinVerificationWindow({ created_at: '2026-08-15T09:00:00.000Z' }, now) === false,
  'a call from hours ago is outside the window'
);
check(
  isCallWithinVerificationWindow(undefined, now) === false,
  'no call at all is never treated as verified'
);
check(
  isCallWithinVerificationWindow(null, now) === false,
  'a null call is never treated as verified'
);
check(
  isCallWithinVerificationWindow({}, now) === false,
  'a call object with no created_at is never treated as verified'
);
check(
  isCallWithinVerificationWindow({ created_at: 'not a real date' }, now) === false,
  'an unparseable created_at never throws and is never treated as verified'
);

// --- stampActivationVerifiedOnRealCall (P0 Batch 1, component C) ---
//
// The automatic replacement for the client-driven check above. Only ever
// reachable from server.js's POST /voice handler, with `household`
// already resolved from Twilio's own request body — see the structural
// tests further down for the "never reachable from client activity
// alone" half of this guarantee.

await (async () => {
  // genuine /voice call stamps activation
  {
    const calls = [];
    const result = await stampActivationVerifiedOnRealCall(
      { id: 'household-1', activation_verified_at: null },
      { markActivationVerified: async (id) => { calls.push(id); return '2026-09-10T12:00:00.000Z'; } }
    );
    check(result.stamped === true, 'a household with no prior activation_verified_at is stamped');
    check(calls.length === 1 && calls[0] === 'household-1', 'markActivationVerified is called exactly once, for the correct household');
    check(result.verifiedAt === '2026-09-10T12:00:00.000Z', 'the resulting verified timestamp is returned');
  }

  // idempotent — an already-verified household is never re-stamped (RPC
  // is itself idempotent DB-side too, but this avoids a redundant call on
  // every subsequent call to an already-verified household)
  {
    const calls = [];
    const result = await stampActivationVerifiedOnRealCall(
      { id: 'household-2', activation_verified_at: '2026-09-01T00:00:00.000Z' },
      { markActivationVerified: async (id) => { calls.push(id); return 'should-not-be-used'; } }
    );
    check(result.stamped === false && result.alreadyVerified === true, 'an already-verified household is not re-stamped');
    check(calls.length === 0, 'markActivationVerified is never called for an already-verified household');
  }

  // no household resolved (unmatched Twilio number) — never throws, never stamps
  {
    const result = await stampActivationVerifiedOnRealCall(null, { markActivationVerified: async () => { throw new Error('should not be called'); } });
    check(result.stamped === false, 'no household resolved: nothing is stamped, no error thrown');
  }

  {
    const result = await stampActivationVerifiedOnRealCall(undefined, { markActivationVerified: async () => { throw new Error('should not be called'); } });
    check(result.stamped === false, 'undefined household: nothing is stamped, no error thrown');
  }
})();

// --- structural: only server.js's /voice handler auto-stamps — client
// activity alone can never stamp activation_verified_at ---
//
// No HTTP test tooling exists in this project (matches
// tests/account-deletion.test.mjs's own established convention) — so
// this is checked directly against the real server.js source.

{
  const voiceAnchor = 'app.post("/voice", async (req, res) => {';
  const voiceIdx = serverSource.indexOf(voiceAnchor);
  check(voiceIdx !== -1, 'POST /voice is declared in server.js');

  if (voiceIdx !== -1) {
    const blockEnd = serverSource.indexOf('\napp.', voiceIdx + voiceAnchor.length);
    const block = serverSource.slice(voiceIdx, blockEnd);

    check(
      block.includes('getHouseholdByTwilioNumber(req.body.To)'),
      '/voice resolves the household from Twilio\'s own POST body, not from any client-suppliable value'
    );
    check(
      block.includes('stampActivationVerifiedOnRealCall('),
      '/voice calls the automatic activation stamp'
    );
    check(
      block.includes('isGenuineTwilioRequest(') && block.includes('genuineTwilioRequest') &&
        block.indexOf('isGenuineTwilioRequest(') < block.indexOf('stampActivationVerifiedOnRealCall('),
      '/voice checks isGenuineTwilioRequest BEFORE calling the auto-stamp — an unsigned/invalid request can never stamp activation, closing the "unauthenticated webhook as authoritative evidence" contradiction'
    );
    check(
      block.includes('buildWebhookUrl(APP_URL,'),
      '/voice builds the signature-check URL from APP_URL, not from req.protocol/req.hostname (unreliable behind Railway\'s proxy with no trust proxy configured)'
    );
  }
}

check(
  !mobileApiSource.includes('stampActivationVerifiedOnRealCall'),
  'stampActivationVerifiedOnRealCall is never called from any mobile client-facing route (routes/mobileApi.js) — it is reachable only from the genuine Twilio webhook in server.js'
);

// The client-invoked verify endpoint still exists as a separate, faster-
// feedback mechanism (immediate UI feedback right after a customer dials
// the forwarding code) — but must not itself call the new webhook-only
// stamp function, keeping the two mechanisms clearly separate.
{
  const verifyAnchor = 'app.post("/activation-verify"';
  const verifyIdx = serverSource.indexOf(verifyAnchor);
  check(verifyIdx !== -1, 'POST /activation-verify (client-invoked) still exists');

  if (verifyIdx !== -1) {
    const blockEnd = serverSource.indexOf('\napp.', verifyIdx + verifyAnchor.length);
    const block = serverSource.slice(verifyIdx, blockEnd);
    check(
      !block.includes('stampActivationVerifiedOnRealCall'),
      'POST /activation-verify does not itself call stampActivationVerifiedOnRealCall — it remains its own, separate, still-client-triggered path (markActivationVerified directly), not a wrapper around the webhook-only stamp'
    );
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
