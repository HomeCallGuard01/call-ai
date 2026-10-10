// WS5 (trusted-caller bypass) runbook helper, 2026-10-10.
//
// Pure logic, no I/O. Builds the exact GSM supplementary-service strings the
// WS5 Test A/B runbooks hand to Andrew, so that a restore string is generated
// from the RECORDED gate values rather than typed from memory, and so that no
// runbook ever emits an erasure code (##61#, ##002#, ##004#) that would wipe
// the customer's voicemail-on-no-answer.
//
// 3GPP TS 22.030 / 22.082: CFNRy = service code 61; the no-reply timer is
// 5..30 s in 5 s steps; "**SC*<number>**<T>#" registers with no basic-service
// group, "**SC*<number>*11*<T>#" registers for telephony only (BS 11).
//
// Run: node tests/ws5-forwarding-codes.test.mjs

const TIMERS = [5, 10, 15, 20, 25, 30];
const ERASURE = /^##(61|67|62|21|002|004)#$/;

function normaliseUkNumber(raw) {
  const digits = String(raw || '').replace(/[\s()-]/g, '');
  if (/^\+44[1-9]\d{8,9}$/.test(digits)) return digits;
  if (/^0[1-9]\d{8,9}$/.test(digits)) return `+44${digits.slice(1)}`;
  if (/^\+?\d{3,15}$/.test(digits)) return digits; // short voicemail codes etc.: keep verbatim
  throw new Error(`not a dialable number: ${raw}`);
}

function cfnryRegister(number, seconds, { basicService = null } = {}) {
  if (!TIMERS.includes(seconds)) throw new Error(`CFNRy timer must be one of ${TIMERS.join('/')} s, got ${seconds}`);
  const n = normaliseUkNumber(number);
  return basicService ? `**61*${n}*${basicService}*${seconds}#` : `**61*${n}**${seconds}#`;
}

function cfuRegister(number) {
  return `**21*${normaliseUkNumber(number)}#`;
}

const INTERROGATE = ['*#21#', '*#61#', '*#62#', '*#67#', '*#43#'];
const CFU_DEACTIVATE = '#21#'; // deactivates, keeps the registered number

// Restore plan from gate readings. Never returns an erasure code.
function restorePlan(gate) {
  const steps = [];
  if (gate.cfnry && gate.cfnry.active) steps.push(cfnryRegister(gate.cfnry.number, gate.cfnry.seconds));
  else steps.push('CFNRy was NOT active at the gate: STOP and ask Andrew (do not erase; restoring "off" needs a decision)');
  if (gate.cfu && gate.cfu.active) steps.push(cfuRegister(gate.cfu.number));
  steps.push(...INTERROGATE);
  return steps;
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`✓ ${msg}`);
  else { console.log(`✗ ${msg}`); failures += 1; }
}
function throws(fn) { try { fn(); return false; } catch { return true; } }

check(cfnryRegister('020 4652 1883', 15) === '**61*+442046521883**15#', 'CFNRy to staging …1883 (national form) with 15 s');
check(cfnryRegister('+442046521883', 20, { basicService: 11 }) === '**61*+442046521883*11*20#', 'BS-11 variant');
check(throws(() => cfnryRegister('+442046521883', 12)), 'rejects a timer that is not a 5 s step');
check(throws(() => cfnryRegister('+442046521883', 35)), 'rejects a timer above 30 s');
check(throws(() => cfnryRegister('+442046521883', 0)), 'rejects 0 s');
check(cfuRegister('07700 900123') === '**21*+447700900123#', 'CFU restore string from national mobile form');
check(throws(() => cfnryRegister('', 15)), 'rejects an empty number');

const plan = restorePlan({ cfnry: { active: true, number: '+447700900000', seconds: 25 }, cfu: { active: true, number: '+441632960000' } });
check(plan[0] === '**61*+447700900000**25#', 'restore re-registers CFNRy to the RECORDED voicemail number and timer');
check(plan[1] === '**21*+441632960000#', 'restore re-registers CFU to the RECORDED number when it was on at the gate');
check(plan.every((s) => !ERASURE.test(s)), 'restore plan never contains an erasure code');
check(INTERROGATE.every((s) => /^\*#\d+#$/.test(s)), 'interrogation codes are read-only (*#..#)');
check(CFU_DEACTIVATE === '#21#' && !ERASURE.test(CFU_DEACTIVATE), 'CFU is deactivated with #21#, never erased with ##21#');
const off = restorePlan({ cfnry: { active: false }, cfu: { active: false } });
check(/STOP/.test(off[0]) && off.every((s) => !ERASURE.test(s)), 'CFNRy inactive at the gate → STOP, not an erasure');

console.log(failures === 0 ? '\nALL WS5 CODE CHECKS PASSED' : `\n${failures} WS5 CODE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
