// Unit tests for services/incomingCallTriage.js — the classifier behind
// scripts/triage-incoming-calls.js, written for the 2026-09-28 "normal
// mobile numbers not accepting incoming calls" report. Fixtures mirror
// the shapes of the real production evidence from that investigation
// (numbers are fictional). Pure functions, no network/DB/Twilio.
//
// Run with: node tests/incoming-call-triage.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyIncomingCallHealth,
  isProductionVoiceUrl,
  maskNumber,
  parsePushFailureAlert,
} = require('../services/incomingCallTriage.js');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`PASS ${message}`);
  } else {
    failures++;
    console.error(`FAIL ${message}`);
  }
}

const HCG = '+441632960533';
const household = { id: 'f06bc964-0000', twilio_number: HCG };
const prodNumber = { voice_url: 'https://www.homecallguard.co.uk/voice' };

function parent(sid, at, status, from = '+447700900700') {
  return { sid, parent_call_sid: null, direction: 'inbound', from, to: HCG, status, start_time: at };
}
function clientLeg(sid, parentSid, at, status) {
  return { sid, parent_call_sid: parentSid, direction: 'outbound-dial', from: '+447700900700', to: 'client:household-f06bc964', status, start_time: at };
}

// --- isProductionVoiceUrl ---
check(isProductionVoiceUrl('https://www.homecallguard.co.uk/voice'), 'www production host is production');
check(isProductionVoiceUrl('https://homecallguard.co.uk/voice'), 'apex production host is production');
check(isProductionVoiceUrl('https://call-ai-production-c913.up.railway.app/voice'), 'Railway production host is production');
check(!isProductionVoiceUrl('https://ferret-augmented-distrust.ngrok-free.dev/voice'), 'staging ngrok tunnel is not production');
check(!isProductionVoiceUrl('https://t3-line-test-6980.twil.io/t3'), 'Twilio Function is not production');
check(!isProductionVoiceUrl('http://www.homecallguard.co.uk/voice'), 'plain http is not production');
check(!isProductionVoiceUrl('https://www.homecallguard.co.uk.evil.example/voice'), 'lookalike host is not production');
check(!isProductionVoiceUrl(''), 'empty voice_url is not production');

// --- maskNumber ---
check(maskNumber('+447700900700') === '+4477…700', 'masks E.164 numbers');
check(maskNumber('client:household-f06bc964') === 'client:…c964', 'masks client identities');
check(!maskNumber('+447700900700').includes('900'), 'mask hides the middle digits');

// --- parsePushFailureAlert (real 52103 alert_text shape) ---
const alertText = "bindingType=fcm&primaryCorrelationId=CAchild1&bindingSid=BSx&module=FCMV1OABA&description=FCM+failure='NotRegistered'&isPassthrough=true";
const parsed = parsePushFailureAlert(alertText);
check(parsed && parsed.callSid === 'CAchild1', 'push alert: correlates to the client leg CallSid');
check(parsed && parsed.bindingType === 'fcm' && parsed.failure === 'NotRegistered', 'push alert: extracts FCM NotRegistered');
check(parsePushFailureAlert('Msg=Got+HTTP+500&ErrorCode=11200') === null, 'non-push alert is ignored');
check(parsePushFailureAlert(null) === null, 'missing alert text is ignored');

// --- classifyIncomingCallHealth ---
check(classifyIncomingCallHealth({ household: { id: 'x', twilio_number: null } }).verdict === 'no_hcg_number',
  'household without an HCG number');

check(classifyIncomingCallHealth({ household, inventoryNumber: null }).verdict === 'number_not_owned',
  'released number: diverted calls cannot reach HCG');

const staging = classifyIncomingCallHealth({ household, inventoryNumber: { voice_url: 'https://ferret-augmented-distrust.ngrok-free.dev/voice' } });
check(staging.verdict === 'webhook_not_production', 'number pointed at a staging tunnel is flagged');

// The 2026-09-28 case: nothing reached Twilio in the window → not HCG.
const quiet = classifyIncomingCallHealth({ household, inventoryNumber: prodNumber, calls: [] });
check(quiet.verdict === 'no_traffic_in_window', 'no inbound traffic → calls never reached HCG');

// The 2026-09-25/26 case: client legs no-answer with FCM NotRegistered.
const failing = classifyIncomingCallHealth({
  household,
  inventoryNumber: prodNumber,
  calls: [
    parent('CAp1', '2026-09-25T18:24:26Z', 'no-answer'),
    clientLeg('CAchild1', 'CAp1', '2026-09-25T18:24:28Z', 'no-answer'),
    parent('CAp2', '2026-09-26T14:05:24Z', 'no-answer'),
    clientLeg('CAchild2', 'CAp2', '2026-09-26T14:05:25Z', 'no-answer'),
  ],
  alerts: [{ alert_text: alertText }],
});
check(failing.verdict === 'delivery_failing', 'no-answer client legs → HCG is dropping diverted calls');
check(failing.attempts.length === 2, 'both parent attempts reported, child legs not double-counted');
check(failing.attempts[0].pushFailure === 'fcm:NotRegistered', 'push failure attached to the right attempt');
check(failing.attempts[1].pushFailure === null, 'push failure not attached to an unrelated attempt');
check(failing.findings.some(f => f.includes('2/2 app deliveries failed')), 'failure count reported');
check(failing.findings.some(f => f.includes('fcm:NotRegistered')), 'stale push binding reported');
check(failing.attempts.every(a => !a.from.includes('900')), 'attempt output is masked');

// Recovery: a later completed delivery supersedes earlier failures.
const recovered = classifyIncomingCallHealth({
  household,
  inventoryNumber: prodNumber,
  calls: [
    clientLeg('CAchild1', 'CAp1', '2026-09-25T18:24:28Z', 'no-answer'),
    parent('CAp1', '2026-09-25T18:24:26Z', 'no-answer'),
    parent('CAp3', '2026-09-27T11:34:08Z', 'completed'),
    clientLeg('CAchild3', 'CAp3', '2026-09-27T11:34:09Z', 'completed'),
  ],
});
check(recovered.verdict === 'delivering', 'most recent completed delivery → delivering (order-independent)');

// Calls arrived but none were dialled to the app (e.g. all blocked).
const screened = classifyIncomingCallHealth({
  household,
  inventoryNumber: prodNumber,
  calls: [parent('CAp4', '2026-09-27T11:22:55Z', 'completed')],
});
check(screened.verdict === 'reaching_hcg', 'calls with no client leg → reaching HCG, not delivered');

// Calls to a different number are not attributed to this household.
const other = classifyIncomingCallHealth({
  household,
  inventoryNumber: prodNumber,
  calls: [{ ...parent('CAp5', '2026-09-27T11:00:00Z', 'completed'), to: '+441632960999' }],
});
check(other.verdict === 'no_traffic_in_window', 'calls to another number are ignored');

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll incoming-call triage checks passed');
