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
    const acct = await client.api.v2010.accounts(d.target).fetch();
    if (acct.status !== 'suspended') {
      await client.api.v2010.accounts(d.target).update({ status: 'suspended' });
    }
    console.log(`usage-breaker: runtime subaccount suspended by trigger ${d.triggerSid} (current=${event.CurrentValue} trigger=${event.TriggerValue} category=${event.UsageCategory})`);
    response.setBody({ suspended: true, alreadySuspended: acct.status === 'suspended' });
    return callback(null, response);
  } catch (err) {
    // Fail loudly: Twilio logs the error and the trigger's own email/console
    // notification still reaches the operator.
    console.error(`usage-breaker: SUSPEND FAILED: ${err.message}`);
    return callback(err);
  }
};
