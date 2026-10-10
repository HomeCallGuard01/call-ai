// Containment design C-6/C-7 (2026-10-10): (1) the Twilio-hosted usage
// breaker suspends ONLY the configured runtime subaccount, only for allowlisted
// triggers, never the parent, and is idempotent; (2) the REST client can run on
// a scoped API key so the backend needs no master auth token. Mocked Twilio;
// nothing deployed or called.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

globalThis.Twilio = { Response: class { constructor() { this.body = null; this.headers = {}; } appendHeader(k, v) { this.headers[k] = v; } setBody(b) { this.body = b; } } };
const breaker = require('../twilio-functions/usage-breaker/functions/suspend-runtime-subaccount.protected.js');

const PARENT = 'AC' + 'a'.repeat(32);
const SUB = 'AC' + 'b'.repeat(32);
const OTHER = 'AC' + 'c'.repeat(32);
const T1 = 'UT' + '1'.repeat(32);
const T2 = 'UT' + '2'.repeat(32);
function ctx({ status = 'active', target = SUB, triggers = T1 } = {}) {
  const calls = [];
  return {
    calls,
    ACCOUNT_SID: PARENT,
    HCG_RUNTIME_SUBACCOUNT_SID: target,
    HCG_BREAKER_TRIGGER_SIDS: triggers,
    getTwilioClient: () => ({ api: { v2010: { accounts: (sid) => ({
      fetch: async () => { calls.push(['fetch', sid]); return { status }; },
      update: async (p) => { calls.push(['update', sid, p.status]); return { status: p.status }; },
    }) } } }),
  };
}
const run = (c, ev) => new Promise((resolve) => breaker.handler(c, ev, (err, res) => resolve({ err, res })));

{
  const c = ctx();
  const r = await run(c, { UsageTriggerSid: T1, AccountSid: PARENT, CurrentValue: '12.1', TriggerValue: '10', UsageCategory: 'totalprice' });
  check(!r.err && r.res.body.suspended === true && c.calls.some((x) => x[0] === 'update' && x[1] === SUB && x[2] === 'suspended'), 'allowlisted trigger → runtime subaccount suspended');
  check(!c.calls.some((x) => x[1] !== SUB), 'only the configured subaccount is touched');
}
{
  const c = ctx({ status: 'suspended' });
  const r = await run(c, { UsageTriggerSid: T1, AccountSid: SUB });
  check(r.res.body.suspended === true && r.res.body.alreadySuspended === true && !c.calls.some((x) => x[0] === 'update'), 'already suspended → idempotent, no second update (trigger on the subaccount itself accepted)');
}
for (const [label, c, ev, reason] of [
  ['unknown trigger', ctx(), { UsageTriggerSid: T2, AccountSid: PARENT }, 'unknown_trigger'],
  ['malformed trigger', ctx(), { UsageTriggerSid: 'UTxyz', AccountSid: PARENT }, 'unknown_trigger'],
  ['foreign account', ctx(), { UsageTriggerSid: T1, AccountSid: OTHER }, 'foreign_account'],
  ['not configured', ctx({ target: '' }), { UsageTriggerSid: T1, AccountSid: PARENT }, 'not_configured'],
  ['target is the parent', ctx({ target: PARENT }), { UsageTriggerSid: T1, AccountSid: PARENT }, 'refuse_parent'],
  ['empty allowlist', ctx({ triggers: '' }), { UsageTriggerSid: T1, AccountSid: PARENT }, 'unknown_trigger'],
]) {
  const r = await run(c, ev);
  check(!r.err && r.res.body.suspended === false && r.res.body.reason === reason && c.calls.length === 0, `${label} → no action (${reason}), no Twilio call`);
}
{
  const c = ctx();
  c.getTwilioClient = () => ({ api: { v2010: { accounts: () => ({ fetch: async () => { throw new Error('boom'); } }) } } });
  const r = await run(c, { UsageTriggerSid: T1, AccountSid: PARENT });
  check(r.err && /boom/.test(r.err.message), 'Twilio API failure surfaces as an error (logged by Twilio), never a silent success');
}

// REST client credential mode
const { createTwilioRestClient, twilioRestCredentialMode } = require('../services/twilioClient.js');
check(twilioRestCredentialMode({ TWILIO_ACCOUNT_SID: SUB, TWILIO_API_KEY_SID: 'SK' + 'd'.repeat(32), TWILIO_API_KEY_SECRET: 'x', TWILIO_AUTH_TOKEN: 't' }) === 'api_key', 'API key preferred over the auth token when both are present');
check(twilioRestCredentialMode({ TWILIO_ACCOUNT_SID: SUB, TWILIO_AUTH_TOKEN: 't' }) === 'auth_token', 'auth-token fallback unchanged');
check(twilioRestCredentialMode({}) === 'none' && createTwilioRestClient({}) === null, 'no account SID → no client');
const keyClient = createTwilioRestClient({ TWILIO_ACCOUNT_SID: SUB, TWILIO_API_KEY_SID: 'SK' + 'd'.repeat(32), TWILIO_API_KEY_SECRET: 'x' });
check(keyClient && keyClient.accountSid === SUB, 'API-key client targets the runtime (sub)account SID');

console.log(failures === 0 ? '\nTwilio usage breaker + credential isolation: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
