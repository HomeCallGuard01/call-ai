// WS3 (2026-10-10): allowance-state Home UI + honest "Turn off call
// forwarding" path.
//
// Pins: (1) the tolerant parser for WS2's allowanceState (unknown/missing →
// behaviour as before; never "Protected" while unknown callers aren't being
// checked); (2) truthful copy that never claims forwarding turns itself off;
// (3) Google Play Option C — no purchase button/link/price/QR on Android, no
// top-up wording on iOS; (4) the turn-off plan (Android opens the dialer
// pre-filled with %23-encoded '#'; iPhone gets code + Settings path; never a
// landline via this phone's dialer); (5) the wiring.
//
// Run with: node tests/mobile-allowance-state.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAllowanceState, readAllowanceStateObject, suppressesProtected, describeAllowanceBanner, allowanceHeroBody,
  ANDROID_MORE_NOTE, TURN_OFF_EXPLAINER, TURN_OFF_FORWARDING_LABEL,
} from '../mobile/lib/allowanceState.ts';
import { describeProtection, HEADLINES } from '../mobile/lib/protectionView.ts';
import {
  planTurnOffForwarding, buildDialerUrl, STANDARD_FORWARDING_OFF_CODE, STANDARD_CODE_CAVEAT, ANDROID_FORWARDING_SETTINGS_PATH, AFTER_TURN_OFF_NOTE,
} from '../mobile/lib/dialerLink.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.join(__dirname, '..', 'mobile');
const read = (rel) => readFileSync(path.join(mobile, rel), 'utf8');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const st = (state, over = {}) => ({ allowanceState: { version: 1, state, percentUsed: 50, screeningActive: !['screening_paused', 'continuity_low', 'hard_ceiling'].includes(state), resetsAt: '2026-11-01T00:00:00Z', ...over } });

// ── 1. Tolerant parser ─────────────────────────────────────────────────
{
  check(parseAllowanceState({}) === null && parseAllowanceState(null) === null && parseAllowanceState(undefined) === null && parseAllowanceState('x') === null, 'no allowanceState → null (Home exactly as before)');
  check(parseAllowanceState({ allowanceState: 'paused' }) === null && parseAllowanceState({ allowanceState: [] }) === null, 'malformed allowanceState → null');
  check(parseAllowanceState({ allowanceState: { state: 'brand_new_state' } }) === null, 'unknown state with no screeningActive=false → ignored (never guessed)');
  const unk = parseAllowanceState({ allowanceState: { state: 'brand_new_state', screeningActive: false } });
  check(unk && unk.state === 'unknown' && suppressesProtected(unk), 'unknown state + screeningActive=false → generic "not being checked" (never Protected)');
  check(parseAllowanceState({ allowanceState: { version: 2, state: 'normal', screeningActive: true } }) === null, 'a future contract version is not guessed at');
  for (const s of ['normal', 'screening_low', 'screening_paused', 'continuity_low', 'hard_ceiling']) {
    check(parseAllowanceState(st(s))?.state === s, `known state "${s}" parsed`);
  }
  check(parseAllowanceState({ customerAllowance: { allowanceState: { state: 'screening_paused', screeningActive: false } } })?.state === 'screening_paused', 'also accepted nested at customerAllowance.allowanceState');
  check(parseAllowanceState(st('normal', { percentUsed: 140 })).percentUsed === 100 && parseAllowanceState(st('normal', { percentUsed: -3 })).percentUsed === 0 && parseAllowanceState(st('normal', { percentUsed: 'x' })).percentUsed === null, 'percentUsed clamped 0–100; non-number → null');
  check(parseAllowanceState(st('normal', { screeningActive: false })).state === 'unknown', 'contradiction (normal but screeningActive=false) → truthful, less reassuring reading');
  check(readAllowanceStateObject({ state: 'hard_ceiling', trustedCallersContinue: true }).trustedCallersContinue === true, 'trustedCallersContinue read');
}

// ── 2. "Protected" never shown wrongly ──────────────────────────────────
{
  const protectedInput = (allowanceState) => {
    const v = parseAllowanceState(allowanceState);
    return {
      protection: { fullyProtected: true, deliveryReady: true, endToEndDeliveryVerified: true, activationVerifiedAt: '2026-10-01', activationStage: 'protected', protectionBlockers: [] },
      membership: { status: 'active' },
      allowanceSuppression: v && suppressesProtected(v) ? { body: allowanceHeroBody(v) } : null,
    };
  };
  const dev = { canPresentCalls: true };
  check(describeProtection(protectedInput({}), dev).isProtected, 'no allowanceState → still Protected (unchanged)');
  check(describeProtection(protectedInput(st('normal')), dev).isProtected && describeProtection(protectedInput(st('screening_low')), dev).isProtected, 'normal / screening_low (still checking) → Protected');
  for (const s of ['screening_paused', 'continuity_low', 'hard_ceiling']) {
    const v = describeProtection(protectedInput(st(s)), dev);
    check(!v.isProtected && v.tone === 'attention' && v.headline === HEADLINES.attention && v.action === null, `${s} → never Protected; attention; banner (not hero) carries the action`);
  }
  check(!describeProtection(protectedInput({ allowanceState: { state: 'mystery', screeningActive: false } }), dev).isProtected, 'unknown state with screening off → never Protected');
  check(!suppressesProtected(null) && !suppressesProtected(parseAllowanceState(st('normal'))), 'suppression only when the server says so');
  check(allowanceHeroBody(parseAllowanceState(st('screening_paused'))).includes('calls are still reaching you'), 'paused hero: calls still reaching you');
}

// ── 3. Banner copy: truthful ────────────────────────────────────────────
{
  check(describeAllowanceBanner(null, 'android') === null && describeAllowanceBanner(parseAllowanceState(st('normal')), 'android') === null, 'normal / none → no banner');
  const low = describeAllowanceBanner(parseAllowanceState(st('screening_low', { percentUsed: 82 })), 'android');
  check(low.tone === 'notice' && low.body.includes('82%') && low.body.includes('still being checked') && !low.offerTurnOffForwarding, 'screening_low: percentage, still checking, no turn-off push');
  const paused = describeAllowanceBanner(parseAllowanceState(st('screening_paused')), 'android');
  check(paused.body.startsWith('Screening paused — calls are still reaching you, but unknown callers are not being checked') && paused.body.includes('1 November'), 'screening_paused: the agreed sentence + reset date');
  check(paused.offerTurnOffForwarding && paused.turnOffExplainer === TURN_OFF_EXPLAINER, 'screening_paused offers Turn off call forwarding');
  const cont = describeAllowanceBanner(parseAllowanceState(st('continuity_low')), 'android');
  check(cont.tone === 'critical' && cont.offerTurnOffForwarding && /may soon stop/.test(cont.body), 'continuity_low: calls may soon stop + turn-off offered');
  const hard = describeAllowanceBanner(parseAllowanceState(st('hard_ceiling')), 'android');
  check(hard.tone === 'critical' && hard.offerTurnOffForwarding && /may not reach you/.test(hard.body) && !/trust/.test(hard.body), 'hard_ceiling: may not reach you; no trusted claim unless the server says so');
  const hardT = describeAllowanceBanner(parseAllowanceState(st('hard_ceiling', { trustedCallersContinue: true })), 'android');
  check(/people you trust still get through/i.test(hardT.body), 'hard_ceiling + trustedCallersContinue → trusted callers still get through');
  const all = ['screening_low', 'screening_paused', 'continuity_low', 'hard_ceiling'].flatMap((s) => ['android', 'ios'].map((p) => describeAllowanceBanner(parseAllowanceState(st(s)), p)));
  const allText = all.map((b) => [b.title, b.body, b.moreNote, b.turnOffExplainer].filter(Boolean).join(' ')).join(' ') + ' ' + TURN_OFF_EXPLAINER + ' ' + AFTER_TURN_OFF_NOTE;
  check(!/automatic|automatically|we('ll| will) turn (it )?off|switch(es)? itself|turns itself/i.test(allText), 'never claims forwarding turns off automatically');
  check(/press Call/i.test(TURN_OFF_EXPLAINER) && /can't do it for you/.test(TURN_OFF_EXPLAINER), 'says plainly the customer must press Call');
  check(!/Twilio|Fortress|entitlement|quarantine|reservation|ledger/i.test(allText), 'no internal vocabulary');
  check(TURN_OFF_FORWARDING_LABEL === 'Turn off call forwarding', 'action label');
}

// ── 4. Google Play Option C / App Store ─────────────────────────────────
{
  const android = ['screening_low', 'screening_paused', 'continuity_low', 'hard_ceiling'].map((s) => describeAllowanceBanner(parseAllowanceState(st(s)), 'android'));
  const ios = ['screening_low', 'screening_paused', 'continuity_low', 'hard_ceiling'].map((s) => describeAllowanceBanner(parseAllowanceState(st(s)), 'ios'));
  check(ios.every((b) => b.moreNote === null), 'iOS: no top-up / "get more" wording at all');
  check(android.every((b) => b.moreNote === ANDROID_MORE_NOTE), 'Android: one plain note');
  const strings = [ANDROID_MORE_NOTE, TURN_OFF_EXPLAINER, STANDARD_CODE_CAVEAT, ANDROID_FORWARDING_SETTINGS_PATH, AFTER_TURN_OFF_NOTE, ...android.flatMap((b) => [b.title, b.body])].join(' ');
  check(!/£|\$|€|\bprice|\bbuy\b|purchase|subscribe|checkout|top[- ]?up now|https?:|www\.|homecallguard\.co\.uk\/|QR/i.test(strings), 'no price, buy/purchase/subscribe, URL or QR in any new string');
  check(!/website/i.test(ANDROID_MORE_NOTE), 'no "on our website" claim (no web top-up exists yet)');
  const banner = read('components/AllowanceStatusBanner.tsx');
  check(!/Linking|openURL|mailto|https?:/.test(banner), 'banner component opens no URL / mailto (plain text only)');
  check(!/purchases|subscriptionPrice|createCheckoutSession|createPortalSession/.test(banner + read('lib/allowanceState.ts')), 'no purchase / checkout / portal code reachable from the banner');
}

// ── 5. Turn off call forwarding plan ────────────────────────────────────
{
  const p = (o) => planTurnOffForwarding({ deviceType: 'android', platform: 'android', cancelCode: null, cancelCodeMethod: null, ...o });
  const carrier = p({ cancelCode: '##002#', cancelCodeMethod: 'mmi' });
  check(carrier.mode === 'carrier_code' && carrier.code === '##002#' && carrier.openDialer && carrier.caveat === null, 'Android + server code → that code, Open Phone app');
  check(buildDialerUrl('##002#') === 'tel:%23%23002%23' && buildDialerUrl(STANDARD_FORWARDING_OFF_CODE) === 'tel:%23%2321%23', 'dialer URL encodes # as %23');
  const std = p({});
  check(std.mode === 'standard_code' && std.code === '##21#' && std.openDialer && std.caveat === STANDARD_CODE_CAVEAT, 'Android, no confirmed code (EE/Lebara) → standard ##21# with an honest caveat');
  check(/haven't confirmed/.test(STANDARD_CODE_CAVEAT) && /settings/.test(STANDARD_CODE_CAVEAT) && /support/.test(STANDARD_CODE_CAVEAT), 'caveat: unconfirmed, with Settings and support fallbacks');
  check(p({ cancelCodeMethod: 'native_settings' }).mode === 'settings' && !p({ cancelCodeMethod: 'native_settings' }).openDialer, 'native-settings carrier (Three/giffgaff/Sky) → Settings path, no code');
  const iosCode = planTurnOffForwarding({ deviceType: 'iphone', platform: 'ios', cancelCode: '##002#', cancelCodeMethod: 'mmi' });
  check(iosCode.mode === 'carrier_code' && !iosCode.openDialer, 'iPhone + code → code shown, no pre-fill (iOS cannot pre-fill MMI)');
  const iosNone = planTurnOffForwarding({ deviceType: 'iphone', platform: 'ios', cancelCode: null, cancelCodeMethod: null });
  check(iosNone.mode === 'settings' && iosNone.code === null, 'iPhone without a confirmed code → Settings path, never a guessed code');
  const land = planTurnOffForwarding({ deviceType: 'landline', platform: 'android', cancelCode: '#21#', cancelCodeMethod: 'mmi' });
  check(land.mode === 'carrier_code' && !land.openDialer, 'landline code shown but NEVER dialled from this phone');
  check(planTurnOffForwarding({ deviceType: 'landline', platform: 'android', cancelCode: null, cancelCodeMethod: null }).mode === 'support', 'landline without a code → support (no standard mobile code)');
  check(planTurnOffForwarding({ deviceType: null, platform: 'android', cancelCode: null, cancelCodeMethod: null }).mode === 'support', 'unknown device → support, nothing dialled');
}

// ── 6. Wiring (source) ─────────────────────────────────────────────────
{
  const home = read('app/(tabs)/index.tsx');
  check(/const allowanceState = parseAllowanceState\(data\);/.test(home) && /allowanceSuppression: allowanceState && suppressesProtected\(allowanceState\)/.test(home), 'Home parses allowanceState and feeds the hero suppression');
  check(/<AllowanceStatusBanner banner=\{allowanceBanner\} \/>/.test(home) && /describeAllowanceBanner\(allowanceState, Platform\.OS\)/.test(home), 'Home renders the banner (platform-aware copy)');
  const banner = read('components/AllowanceStatusBanner.tsx');
  check(/TURN_OFF_FORWARDING_ROUTE = "\/\(tabs\)\/account\/turn-off-protection"/.test(banner) && /router\.push\(TURN_OFF_FORWARDING_ROUTE/.test(banner), 'banner action opens the guided turn-off screen');
  const turnOff = read('app/(tabs)/account/turn-off-protection.tsx');
  check(/planTurnOffForwarding\(\{ deviceType, platform: Platform\.OS, cancelCode, cancelCodeMethod \}\)/.test(turnOff), 'turn-off screen uses the tested plan');
  check(/if \(!plan\.openDialer \|\| !plan\.code\) return;/.test(turnOff) && /buildDialerUrl\(plan\.code\)/.test(turnOff) && /Linking\.openURL\(url\)/.test(turnOff), 'Open Phone app only when the plan allows; tel: with %23');
  check(/Press Call\. Home Call Guard can't press it for you/.test(turnOff), 'screen tells the customer to press Call');
  check(!/ACTION_CALL|CALL_PHONE/.test(turnOff.replace(/\/\/.*$/gm, '')), 'never places the call itself');
  check(/settingsForwardingNote\("deactivate", cancelCodeNote, Platform\.OS\)/.test(turnOff), 'native-settings note unchanged');
}

console.log(failures === 0 ? '\nAllowance state UI + turn-off forwarding: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
