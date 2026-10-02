// forwardingNumber API contract (2026-09-26) — native-Settings carriers
// (giffgaff, Three) get their HCG number as an explicit field, so the
// customer is shown the number to type into Phone Settings instead of an
// impossible "enter the number" step with no number (the Build 19 / RC
// gap: code is null for those carriers, and every client used to parse
// the number OUT of the code).
//
// Covers:
//   1. toUkNationalForwardingNumber: +44 -> 0 conversion, strict, fails safe
//   2. buildActivationInstructions: giffgaff/Three native_settings contract;
//      every dial-code carrier's code UNCHANGED from the previous formula;
//      deactivation per carrier (Sky's #61# withdrawn); landline/Virgin;
//      missing/malformed number throws instead of producing instructions
//   3. GET /api/v1/activation/instructions (real handler, executed) and the
//      web /activation-instructions response both carry forwardingNumber
//   4. mobile lib/forwardingNumber.ts resolveForwardingNumber (executed)
//   5. Build 20 screens: activate.tsx + account/set-up-call-forwarding.tsx
//   6. upload.html native-Settings display (executed against a stub DOM)
//
// Run with: node tests/forwarding-number-api.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveForwardingNumber, extractForwardingNumberFromCode } from '../mobile/lib/forwardingNumber.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = (...p) => readFileSync(path.join(root, ...p), 'utf8');
const require = createRequire(import.meta.url);

for (const [k, v] of Object.entries({
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'dummy',
  SUPABASE_SERVICE_ROLE_KEY: 'dummy',
  TWILIO_ACCOUNT_SID: 'ACdummy00000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'dummy',
})) if (!process.env[k]) process.env[k] = v;

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const {
  toUkNationalForwardingNumber,
  buildActivationInstructions,
} = require('../services/activationInstructions.js');
const { PROVIDER_POLICY } = require('../services/providerPolicy.js');

// ============================================================
// 1. +44 -> UK national conversion, strict
// ============================================================
check(toUkNationalForwardingNumber('+441612345678') === '01612345678', 'converts a geographic +44 number to UK national 0 format (01612345678)');
check(toUkNationalForwardingNumber('+442071234567') === '02071234567', 'converts a London +442 number (02071234567)');
check(toUkNationalForwardingNumber('+447700900123') === '07700900123', 'converts a +447 mobile number (07700900123)');
check(toUkNationalForwardingNumber('+44169772345') === '0169772345', 'accepts a valid 10-digit national geographic number (0169772345)');
for (const bad of [undefined, null, '', '   ', '441612345678', '01612345678', '+4401612345678', '+44161', '+4416123456789012', '+14155550123', '+44 161 234 5678', '+44161234567a', 12345]) {
  check(toUkNationalForwardingNumber(bad) === null, `malformed/missing allocated number ${JSON.stringify(bad)} -> null (never a guessed number)`);
}

// ============================================================
// 2. buildActivationInstructions
// ============================================================
const TW = '+441612345678';
const FN = '01612345678';
const oldFormulaCode = (e164) => `**21*${e164.replace(/^\+44/, '0')}#`; // the pre-2026-09-26 code, unchanged

for (const deviceType of ['android', 'iphone']) {
  for (const carrier of ['giffgaff', 'three']) {
    const r = buildActivationInstructions({ twilioNumber: TW, deviceType, carrier });
    check(r.activationMethod === 'native_settings', `${deviceType}/${carrier}: activationMethod "native_settings"`);
    check(r.forwardingNumber === FN, `${deviceType}/${carrier}: forwardingNumber is the allocated HCG number in UK national format (${FN})`);
    check(r.code === null, `${deviceType}/${carrier}: code is null — no dial code, ever`);
    check(typeof r.activationNote === 'string' && /call forwarding/i.test(r.activationNote), `${deviceType}/${carrier}: Settings instructions (activationNote) present`);
    check(r.cancelCode === null && r.cancelCodeMethod === 'native_settings', `${deviceType}/${carrier}: cancellation also via Settings, no code`);
  }
}

// Every dial-code carrier: forwardingNumber added, code byte-for-byte what it was.
const mmiCarriers = Object.keys(PROVIDER_POLICY).filter((k) => PROVIDER_POLICY[k].method !== 'native_settings');
check(mmiCarriers.length >= 10 && mmiCarriers.includes('ee') && mmiCarriers.includes('o2') && mmiCarriers.includes('vodafone'), `regression set covers every non-native-Settings carrier in PROVIDER_POLICY (${mmiCarriers.length}: ${mmiCarriers.join(', ')})`);
for (const carrier of [...mmiCarriers, undefined]) {
  const r = buildActivationInstructions({ twilioNumber: TW, deviceType: 'android', carrier });
  check(
    r.activationMethod === 'mmi' && r.code === oldFormulaCode(TW) && r.forwardingNumber === FN,
    `android/${carrier ?? '(no carrier on record)'}: activation code unchanged (${r.code}), activationMethod mmi, forwardingNumber ${FN} added`
  );
}

// Deactivation per carrier — exactly the intended values (only Sky changed).
const EXPECTED_CANCEL = {
  o2: ['mmi', '##002#'], vodafone: ['mmi', '##002#'], smarty: ['mmi', '#002#'], id_mobile: ['mmi', '##002#'],
  ee: ['unknown', null], tesco: ['unknown', null], voxi: ['unknown', null], lebara: ['unknown', null],
  sky: ['native_settings', null], giffgaff: ['native_settings', null], three: ['native_settings', null],
};
for (const [carrier, [method, code]] of Object.entries(EXPECTED_CANCEL)) {
  const r = buildActivationInstructions({ twilioNumber: TW, deviceType: 'android', carrier });
  check(r.cancelCodeMethod === method && r.cancelCode === code, `android/${carrier}: cancel instruction is ${method}${code ? ' ' + code : ''}`);
}
{
  const r = buildActivationInstructions({ twilioNumber: TW, deviceType: 'android', carrier: 'sky' });
  check(r.cancelCode !== '#61#' && !JSON.stringify(r).includes('#61#'), 'Sky Mobile: #61# is not exposed anywhere in the response (service code 61 = no-reply forwarding; HCG sets up unconditional 21)');
  check(r.activationMethod === 'mmi' && r.code === oldFormulaCode(TW), 'Sky Mobile: activation is untouched (still the dial code) — only cancellation moved to Settings');
}

// Landline: forwardingNumber is the real number; Virgin's extra zero stays in the code only.
{
  const bt = buildActivationInstructions({ twilioNumber: TW, deviceType: 'landline', provider: 'bt' });
  check(bt.code === '**21*01612345678#' && bt.forwardingNumber === FN && bt.cancelCode === '#21#', 'landline/BT: code, forwardingNumber and #21# cancel unchanged/correct');
  const virgin = buildActivationInstructions({ twilioNumber: TW, deviceType: 'landline', provider: 'virgin' });
  check(virgin.code === '**21*001612345678#' && virgin.forwardingNumber === FN, 'landline/Virgin: code keeps the extra leading zero; forwardingNumber is the real number without it');
}

// Missing / malformed allocated number fails safely — no instructions at all.
for (const bad of [undefined, null, '', '441612345678', '+1415555012']) {
  for (const carrier of ['giffgaff', 'o2']) {
    let threw = false;
    try { buildActivationInstructions({ twilioNumber: bad, deviceType: 'android', carrier }); } catch { threw = true; }
    check(threw, `android/${carrier} with allocated number ${JSON.stringify(bad)}: refuses to build instructions (no wrong number, no malformed code)`);
  }
}

// ============================================================
// 3. Routes carry forwardingNumber
// ============================================================
const mobileRouter = require('../routes/mobileApi.js');
const layer = mobileRouter.stack.find((l) => l.route && l.route.path === '/api/v1/activation/instructions' && l.route.methods.get);
const instructionsHandler = layer.route.stack[layer.route.stack.length - 1].handle;
function makeRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function callInstructions(household, deviceType = 'android') {
  const res = makeRes();
  const origError = console.error; console.error = () => {};
  try { await instructionsHandler({ query: { deviceType }, household }, res); } finally { console.error = origError; }
  return res;
}
{
  const g = await callInstructions({ id: 'h1', twilio_number: TW, carrier_provider_key: 'giffgaff', phone_number: null });
  check(g.statusCode === 200 && g.body.activationMethod === 'native_settings' && g.body.forwardingNumber === FN && g.body.code === null,
    'GET /api/v1/activation/instructions (real handler), giffgaff household: 200, native_settings, forwardingNumber from the household\'s allocated number, code null');
  check(!('twilioNumber' in g.body) && !JSON.stringify(g.body).includes('+44'), 'the response never includes the raw E.164 number');
  const t = await callInstructions({ id: 'h2', twilio_number: '+442071234567', carrier_provider_key: 'three', phone_number: null }, 'iphone');
  check(t.body.activationMethod === 'native_settings' && t.body.forwardingNumber === '02071234567' && t.body.code === null, 'real handler, Three household: native_settings, its own allocated number (02071234567), code null');
  const o = await callInstructions({ id: 'h3', twilio_number: TW, carrier_provider_key: 'o2', phone_number: null });
  check(o.body.activationMethod === 'mmi' && o.body.code === oldFormulaCode(TW) && o.body.forwardingNumber === FN && o.body.cancelCode === '##002#',
    'real handler, O2 household: dial code unchanged, forwardingNumber present, ##002# cancel');
  const missing = await callInstructions({ id: 'h4', twilio_number: null, carrier_provider_key: 'giffgaff', phone_number: null });
  check(missing.statusCode === 409 && missing.body.error === 'not_provisioned', 'real handler, no number allocated yet: 409 not_provisioned (unchanged)');
  const malformed = await callInstructions({ id: 'h5', twilio_number: '441612345678', carrier_provider_key: 'giffgaff', phone_number: null });
  check(malformed.statusCode === 500 && malformed.body.error === 'failed' && malformed.body.forwardingNumber === undefined, 'real handler, malformed allocated number: 500 "failed" — no number, no instructions');
}
{
  const server = read('server.js');
  const webRoute = server.slice(server.indexOf('app.get("/activation-instructions"'), server.indexOf('// GET /deactivation-instructions'));
  check(webRoute.length > 0 && /forwardingNumber: instructions\.forwardingNumber/.test(webRoute), 'web GET /activation-instructions response includes forwardingNumber: instructions.forwardingNumber');
}

// ============================================================
// 4. mobile resolveForwardingNumber (executed)
// ============================================================
check(resolveForwardingNumber({ forwardingNumber: FN, code: null }) === FN, 'app: native_settings response (code null) -> number comes from forwardingNumber');
check(resolveForwardingNumber({ forwardingNumber: FN, code: '**21*01612345678#' }) === FN, 'app: dial-code response -> forwardingNumber used directly');
check(resolveForwardingNumber({ forwardingNumber: '01612345678', code: '**21*001612345678#' }) === '01612345678', 'app: Virgin landline shows the real number, not the extra-zero code form');
check(resolveForwardingNumber({ code: '**21*01612345678#' }) === FN, 'app: older backend without forwardingNumber -> falls back to extracting from the code');
check(resolveForwardingNumber({ code: null }) === null, 'app: older backend + native_settings (no field, no code) -> null (screen shows retry, not an impossible step)');
check(resolveForwardingNumber({ forwardingNumber: '+441612345678', code: null }) === null && resolveForwardingNumber({ forwardingNumber: 'abc', code: '**21*01612345678#' }) === null, 'app: a malformed forwardingNumber is never shown (and not overridden by code parsing)');
check(resolveForwardingNumber(null) === null && extractForwardingNumberFromCode(null) === null, 'app: null instructions -> null, no crash');

// ============================================================
// 5. Build 20 screens
// ============================================================
function nativeBranch(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a + startMarker.length);
  return a === -1 || b === -1 ? '' : src.slice(a, b);
}
{
  const src = read('mobile', 'app', '(setup)', 'activate.tsx');
  const nat = nativeBranch(src, 'if (instructions.activationMethod === "native_settings") {', '\n  return (\n    <Screen>');
  check(nat !== '', 'activate.tsx: native_settings branch located');
  check(src.includes('const forwardingNumber = resolveForwardingNumber(instructions);') && !src.includes('extractForwardingNumberFromCode(instructions'), 'activate.tsx: number comes from resolveForwardingNumber (API field first), not code parsing');
  check(/if \(!forwardingNumber\) \{[\s\S]*?Banner variant="error"[\s\S]*?label="Try again" onPress=\{load\}[\s\S]*?\n    \}/.test(nat), 'activate.tsx native: no number -> error + Try again, never the Settings step without a number');
  const guardEnd = nat.indexOf('    return (\n      <Screen>', nat.indexOf('if (!forwardingNumber)') + 40);
  const main = nat.slice(guardEnd);
  check(main.includes('Enter this Home Call Guard number:') && main.includes('formatUkPhoneForDisplay(forwardingNumber)') && /numberValue\} selectable/.test(main), 'activate.tsx native: shows "Enter this Home Call Guard number:" and the number (selectable)');
  check(main.includes('onPress={handleCopyNumber}') && main.includes('"Copy number"') && /Clipboard\.setStringAsync\(forwardingNumber\)/.test(src), 'activate.tsx native: "Copy number" copies the plain number');
  check(main.indexOf('Enter this Home Call Guard number:') < main.indexOf('instructions.activationNote'), 'activate.tsx native: the number is shown BEFORE the Settings instructions');
  check(!/codeBox|Copy code|Activate protection|handleActivate|buildDialerUrl|instructions\.code\b/.test(main), 'activate.tsx native: no code box, no "Copy code", no Connect Now/"Activate protection", no dial URL');
  check(main.includes(`label="I've done this — continue"`), 'activate.tsx native: a real next step ("I\'ve done this — continue")');
  const mmi = src.slice(src.indexOf('\n  return (\n    <Screen>', src.indexOf('if (instructions.activationMethod === "native_settings")')));
  check(mmi.includes('styles.codeBox') && mmi.includes('label="Activate protection" onPress={handleActivate}') && src.includes('const url = buildDialerUrl(instructions.code);'), 'activate.tsx dial-code branch: code box + Connect Now ("Activate protection" -> dialler) retained');
}
{
  const src = read('mobile', 'app', '(tabs)', 'account', 'set-up-call-forwarding.tsx');
  check(src.includes('const forwardingNumber = resolveForwardingNumber(instructions);') && !src.includes('extractForwardingNumberFromCode(instructions'), 'Account set-up-call-forwarding: number from resolveForwardingNumber');
  check(/if \(isNativeSettings && !forwardingNumber\) \{[\s\S]*?couldn't load your Home Call Guard number/.test(src), 'Account set-up-call-forwarding: native + no number -> "couldn\'t load" notice, not impossible instructions');
  check(src.includes('"Enter this Home Call Guard number:"') && /isNativeSettings && forwardingNumber && \([\s\S]*?Copy number/.test(src), 'Account set-up-call-forwarding: native shows "Enter this Home Call Guard number:" + number + Copy number');
  const nat = src.slice(src.indexOf('{isNativeSettings && instructions ? ('), src.indexOf(') : (', src.indexOf('{isNativeSettings && instructions ? (')));
  check(nat.includes('instructions.activationNote') && !/codeBox|Open Phone app|handleOpenPhone|instructions\.code/.test(nat), 'Account set-up-call-forwarding native branch: Settings instructions, no code box, no "Open Phone app"');
  check(src.includes('{canAutoDial && <PrimaryButton label="Open Phone app" onPress={handleOpenPhone} />}') && src.includes('styles.codeBox'), 'Account set-up-call-forwarding dial-code branch: code + "Open Phone app" retained');
}
{
  const types = read('mobile', 'lib', 'types.ts');
  check(/forwardingNumber\?: string \| null;/.test(types), 'ActivationInstructionsResponse declares optional forwardingNumber (older backends omit it)');
}

// ============================================================
// 6. upload.html native-Settings display (executed)
// ============================================================
{
  const html = read('upload.html');
  const start = html.indexOf('        const mmiBlockEl = document.getElementById("callForwardingMmiBlock");');
  const endMarker = '        if (callForwardingInstructionsEl) callForwardingInstructionsEl.hidden = false;';
  const end = html.indexOf(endMarker, start);
  check(start !== -1 && end !== -1, 'upload.html: activation display block located');
  const block = html.slice(start, end + endMarker.length);
  const markup = html.slice(html.indexOf('<div id="callForwardingNativeSettingsBlock" hidden>'), html.indexOf('<p id="nativeSettingsNote"'));
  check(markup.includes('Enter this Home Call Guard number:') && markup.includes('id="nativeSettingsForwardingNumber"') && markup.includes('id="copyForwardingNumberButton"'), 'upload.html: native block shows "Enter this Home Call Guard number:" + the number + Copy number, BEFORE the Settings note');

  function run(instructions) {
    const els = {};
    const el = (id) => (els[id] ||= { id, hidden: false, textContent: '', dataset: {} });
    ['callForwardingMmiBlock', 'callForwardingNativeSettingsBlock', 'nativeSettingsNote', 'nativeSettingsCancelNote', 'nativeSettingsForwardingNumber', 'copyForwardingNumberButton', 'copyForwardingNumberConfirmation', 'forwardingCancelLine', 'forwardingCancelNote'].forEach(el);
    const ctx = { forwardingCodeEl: el('forwardingCode'), forwardingCancelCodeEl: el('forwardingCancelCode'), copyCodeButtonEl: el('copyCodeButton'), copyCodeConfirmationEl: el('copyCodeConfirmation'), preliminaryCallNoteEl: el('preliminaryCallNote'), callForwardingInstructionsEl: el('callForwardingInstructions'), callForwardingErrorEl: el('callForwardingError') };
    ctx.callForwardingInstructionsEl.hidden = true; ctx.callForwardingErrorEl.hidden = true;
    const document = { getElementById: (id) => els[id] || null };
    new Function('document', 'navigator', 'instructions', ...Object.keys(ctx), block)(document, { clipboard: {} }, instructions, ...Object.values(ctx));
    return els;
  }
  const base = { requiresPreliminaryCall: false, preliminaryCallNumber: null, preliminaryCallNote: null };
  const g = run({ ...base, code: null, activationMethod: 'native_settings', activationNote: 'Phone app > Settings > Calls > Call forwarding', forwardingNumber: FN, cancelCode: null, cancelCodeMethod: 'native_settings', cancelCodeNote: null });
  check(g.callForwardingInstructions.hidden === false && g.callForwardingNativeSettingsBlock.hidden === false && g.callForwardingMmiBlock.hidden === true, 'website executed, native_settings: Settings block shown, dial-code block hidden');
  check(g.nativeSettingsForwardingNumber.textContent === '01612 345678' && g.nativeSettingsForwardingNumber.dataset.copyValue === FN && g.copyForwardingNumberButton.hidden === false, 'website executed, native_settings: displays the forwarding number (01612 345678) and copies the plain 01612345678');
  check(g.copyCodeButton.hidden === true && g.forwardingCode.textContent === '', 'website executed, native_settings: no dial code, no Copy code');
  const noNum = run({ ...base, code: null, activationMethod: 'native_settings', activationNote: 'x', cancelCode: null, cancelCodeMethod: 'native_settings', cancelCodeNote: null });
  check(noNum.callForwardingInstructions.hidden === true && noNum.callForwardingError.hidden === false && /couldn't load your Home Call Guard number/.test(noNum.callForwardingError.textContent), 'website executed, native_settings WITHOUT a number: error shown, instructions hidden (no "enter the number" without a number)');
  const o2 = run({ ...base, code: '**21*01612345678#', activationMethod: 'mmi', activationNote: null, forwardingNumber: FN, cancelCode: '##002#', cancelCodeMethod: 'mmi', cancelCodeNote: null });
  check(o2.callForwardingMmiBlock.hidden === false && o2.forwardingCode.textContent === '**21*01612345678#' && o2.forwardingCancelCode.textContent === '##002#' && o2.forwardingCancelLine.hidden === false && o2.forwardingCancelNote.hidden === true, 'website executed, dial-code carrier (O2): code and ##002# shown exactly as before');
  const sky = run({ ...base, code: '**21*01612345678#', activationMethod: 'mmi', activationNote: null, forwardingNumber: FN, cancelCode: null, cancelCodeMethod: 'native_settings', cancelCodeNote: "turn off 'Always forward'" });
  check(sky.forwardingCancelLine.hidden === true && sky.forwardingCancelNote.hidden === false && /Always forward/.test(sky.forwardingCancelNote.textContent), 'website executed, Sky: no "dial:" with a blank code — the Settings cancellation note instead');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
