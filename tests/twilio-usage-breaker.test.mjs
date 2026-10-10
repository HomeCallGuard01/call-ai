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

// Agent 1 2026-10-11: after suspending, the breaker ends the subaccount's LIVE calls.
function liveCtx({ live = { 'in-progress': ['CA1', 'CA2'], ringing: ['CA3'], queued: [] }, failSid = null, env = {} } = {}) {
  const log = [];
  const callsFn = (sid) => ({ update: async (p) => { log.push(['hangup', sid, p.status]); if (sid === failSid) throw new Error('nope'); return { status: 'completed' }; } });
  callsFn.list = async ({ status, limit }) => { log.push(['list', status, limit]); return (live[status] || []).map((sid) => ({ sid })); };
  return {
    log, ACCOUNT_SID: PARENT, HCG_RUNTIME_SUBACCOUNT_SID: SUB, HCG_BREAKER_TRIGGER_SIDS: T1, ...env,
    getTwilioClient: () => ({ api: { v2010: { accounts: (sid) => ({
      fetch: async () => { log.push(['fetch', sid]); return { status: 'active' }; },
      update: async (p) => { log.push(['suspend', sid, p.status]); return { status: p.status }; },
      calls: sid === SUB ? callsFn : null,
    }) } } }),
  };
}
{
  const c = liveCtx();
  const r = await run(c, { UsageTriggerSid: T1, AccountSid: PARENT });
  const order = c.log.map((x) => x[0]);
  check(r.res.body.suspended && r.res.body.liveCalls.found === 3 && r.res.body.liveCalls.ended === 3, 'after suspension, every live call (in-progress, ringing, queued) of the runtime subaccount is ended');
  check(order.indexOf('suspend') < order.indexOf('hangup'), 'default order: suspend first (no new calls), then hang up live calls');
  check(c.log.filter((x) => x[0] === 'hangup').every((x) => x[2] === 'completed'), 'hang-up = status completed (ends the parent leg, child <Client> leg and streams together)');
}
{
  const c = liveCtx({ env: { HCG_BREAKER_HANGUP_BEFORE_SUSPEND: 'true' } });
  const r = await run(c, { UsageTriggerSid: T1, AccountSid: PARENT });
  const order = c.log.map((x) => x[0]);
  check(order.indexOf('hangup') < order.indexOf('suspend') && order.lastIndexOf('hangup') > order.indexOf('suspend') && r.res.body.liveCallsBeforeSuspend.ended === 3, 'HCG_BREAKER_HANGUP_BEFORE_SUSPEND=true: hang up, suspend, hang up again (fallback if a suspended account\'s calls cannot be modified)');
}
{
  const c = liveCtx({ failSid: 'CA2' });
  const r = await run(c, { UsageTriggerSid: T1, AccountSid: PARENT });
  check(!r.err && r.res.body.suspended && r.res.body.liveCalls.failed === 1 && r.res.body.liveCalls.ended === 2, 'one hang-up failing never undoes or hides the suspension (counted, logged)');
}
{
  const c = liveCtx({ env: { HCG_BREAKER_HANGUP_LIVE_CALLS: 'false' } });
  const r = await run(c, { UsageTriggerSid: T1, AccountSid: PARENT });
  check(r.res.body.liveCalls === null && !c.log.some((x) => x[0] === 'hangup' || x[0] === 'list'), 'HCG_BREAKER_HANGUP_LIVE_CALLS=false → suspension only');
}
{
  const many = Array.from({ length: 10 }, (_, i) => `CA${i}`);
  const c = liveCtx({ live: { 'in-progress': many }, env: { HCG_BREAKER_MAX_HANGUPS: '4' } });
  const r = await run(c, { UsageTriggerSid: T1, AccountSid: PARENT });
  check(c.log.find((x) => x[0] === 'list')[2] === 4 && r.res.body.liveCalls.truncated === true, 'bounded per invocation (HCG_BREAKER_MAX_HANGUPS) and reports truncation (10 s Function limit)');
}
{
  const c = liveCtx();
  await run(c, { UsageTriggerSid: T2, AccountSid: PARENT });
  check(!c.log.some((x) => x[0] === 'hangup' || x[0] === 'list'), 'an unknown trigger hangs up nothing');
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
