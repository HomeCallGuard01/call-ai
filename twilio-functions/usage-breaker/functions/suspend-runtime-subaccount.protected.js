// HCG usage breaker: a Twilio Function (Twilio Serverless), deployed in the
// PARENT Twilio account. NOT deployed anywhere yet (2026-10-10, containment
// design C-7).
//
// A Twilio Usage Trigger (e.g. daily `totalprice` ≥ £X, or `calls-inbound`
// minutes ≥ Y) calls this Function. It SUSPENDS the HCG runtime SUBACCOUNT, so
// no further calls are accepted on its numbers. This runs entirely inside
// Twilio: it works when every HCG server is down or compromised, and the HCG
// backend holds no credential that can undo it (the parent's credentials live
// only in this Function's own environment).
//
// "protected" Functions only run for requests carrying a valid
// X-Twilio-Signature, so the public cannot trigger a suspension.
//
// Environment (set in the Twilio Functions service, never in HCG's backend):
//   HCG_RUNTIME_SUBACCOUNT_SID   the only account this Function may suspend
//   HCG_BREAKER_TRIGGER_SIDS     comma-separated Usage Trigger SIDs allowed to fire it
//
// Deliberately narrow: it never reactivates, never touches any other account,
// and ignores unknown triggers. Reactivation is a manual, audited console step.
// It also ends the runtime subaccount's LIVE calls (see hangUpLiveCalls).
//
// LIMITS (do not present this as a hard cap): Usage Triggers fire on BOOKED
// usage, polled about once a minute; call usage is believed to be booked when
// a call ENDS, so long calls in progress may not move the trigger until they
// finish. A trigger that lives in the runtime subaccount can be deleted by
// anyone holding that subaccount's credentials (i.e. a compromised backend).
'use strict';

const SID = /^AC[0-9a-f]{32}$/i;
const TRIGGER = /^UT[0-9a-f]{32}$/i;

function decide(context, event) {
  const target = String(context.HCG_RUNTIME_SUBACCOUNT_SID || '').trim();
  const allowed = String(context.HCG_BREAKER_TRIGGER_SIDS || '')
    .split(',').map((s) => s.trim()).filter((s) => TRIGGER.test(s));
  const triggerSid = String((event && event.UsageTriggerSid) || '').trim();
  const fromAccount = String((event && event.AccountSid) || '').trim();

  if (!SID.test(target)) return { act: false, reason: 'not_configured' };
  if (target === context.ACCOUNT_SID) return { act: false, reason: 'refuse_parent' };
  if (!TRIGGER.test(triggerSid) || !allowed.includes(triggerSid)) return { act: false, reason: 'unknown_trigger' };
  // The trigger may live on the parent or on the runtime subaccount; nothing else.
  if (fromAccount !== context.ACCOUNT_SID && fromAccount !== target) return { act: false, reason: 'foreign_account' };
  return { act: true, target, triggerSid };
}

exports.decide = decide;

// Agent 1 2026-10-11: suspension does NOT end calls already in progress
// (Twilio-confirmed). After suspending, the breaker therefore also ends the
// runtime subaccount's live calls with the PARENT's credentials. Bounded per
// invocation (Twilio Functions have a 10 s execution limit), parallel, and
// best effort: every failure is counted, never thrown. Whether Twilio lets the
// parent update calls of a SUSPENDED subaccount is UNVERIFIED — runbook
// docs/launch/2026-10-11-USAGE-BREAKER-DEPLOY-RUNBOOK.md step V4 tests it; if
// it does not, set HCG_BREAKER_HANGUP_BEFORE_SUSPEND=true (hang up, suspend,
// hang up again). HCG_BREAKER_HANGUP_LIVE_CALLS=false disables this.
const LIVE_STATUSES = ['in-progress', 'ringing', 'queued'];
const DEFAULT_MAX_HANGUPS = 200;

async function hangUpLiveCalls(client, target, { max = DEFAULT_MAX_HANGUPS } = {}) {
  const out = { found: 0, ended: 0, failed: 0, truncated: false };
  const acct = client.api.v2010.accounts(target);
  const sids = [];
  for (const status of LIVE_STATUSES) {
    if (sids.length >= max) { out.truncated = true; break; }
    let list = [];
    try { list = await acct.calls.list({ status, limit: max - sids.length }); } catch (err) { out.failed++; continue; }
    for (const c of list) if (c && c.sid && !sids.includes(c.sid)) sids.push(c.sid);
  }
  out.found = sids.length;
  if (out.found >= max) out.truncated = true;
  const results = await Promise.allSettled(sids.map((sid) => acct.calls(sid).update({ status: 'completed' })));
  for (const r of results) { if (r.status === 'fulfilled') out.ended++; else out.failed++; }
  return out;
}

exports.hangUpLiveCalls = hangUpLiveCalls;

exports.handler = async function handler(context, event, callback) {
  const d = decide(context, event);
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');
  if (!d.act) {
    console.log(`usage-breaker: no action (${d.reason})`);
    response.setBody({ suspended: false, reason: d.reason });
    return callback(null, response);
  }
  try {
    const client = context.getTwilioClient();
    const hangup = String(context.HCG_BREAKER_HANGUP_LIVE_CALLS || 'true').toLowerCase() !== 'false';
    const before = String(context.HCG_BREAKER_HANGUP_BEFORE_SUSPEND || '').toLowerCase() === 'true';
    const max = Number.isInteger(Number(context.HCG_BREAKER_MAX_HANGUPS)) && Number(context.HCG_BREAKER_MAX_HANGUPS) > 0 ? Number(context.HCG_BREAKER_MAX_HANGUPS) : DEFAULT_MAX_HANGUPS;
    let first = null;
    if (hangup && before) first = await hangUpLiveCalls(client, d.target, { max });
    const acct = await client.api.v2010.accounts(d.target).fetch();
    if (acct.status !== 'suspended') {
      await client.api.v2010.accounts(d.target).update({ status: 'suspended' });
    }
    const live = hangup ? await hangUpLiveCalls(client, d.target, { max }) : null;
    console.log(`usage-breaker: runtime subaccount suspended by trigger ${d.triggerSid} (current=${event.CurrentValue} trigger=${event.TriggerValue} category=${event.UsageCategory}); live calls ${live ? `found=${live.found} ended=${live.ended} failed=${live.failed}${live.truncated ? ' TRUNCATED' : ''}` : 'not touched'}`);
    response.setBody({ suspended: true, alreadySuspended: acct.status === 'suspended', liveCalls: live, liveCallsBeforeSuspend: first });
    return callback(null, response);
  } catch (err) {
    // Fail loudly: Twilio logs the error and the trigger's own email/console
    // notification still reaches the operator.
    console.error(`usage-breaker: SUSPEND FAILED: ${err.message}`);
    return callback(err);
  }
};
