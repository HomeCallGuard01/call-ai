// Mobile 1.0.2 customer experience — iOS-priority pass (2026-10-04).
// Behavioural checks run the pure view model; wiring checks read the real
// screen sources (this project's established convention for RN screens — see
// tests/home-screen-error-handling.test.mjs).
//
// Run with: node tests/mobile-102-ios-experience.test.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeProtection } from '../mobile/lib/protectionView.ts';
import { readinessMessage, readinessProblem, buildIosReadiness, buildAndroidReadiness, canPresentCalls } from '../mobile/lib/callReadinessModel.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const PROTECTED = { protection: { fullyProtected: true, deliveryReady: true, endToEndDeliveryVerified: true, activationVerifiedAt: '2026-10-01T00:00:00Z', activationStage: 'protected', protectionBlockers: [] }, membership: { status: 'active' } };

// ── 1. Device problem wording is platform-accurate; the verdict is not ────
{
  const ios = buildIosReadiness(18, 'denied');
  const android = buildAndroidReadiness(34, false, true);
  const iosMsg = readinessMessage(readinessProblem(ios), 'ios');
  const andMsg = readinessMessage(readinessProblem(android), 'android');
  const vi = describeProtection(PROTECTED, { canPresentCalls: canPresentCalls(ios), problemMessage: iosMsg });
  const va = describeProtection(PROTECTED, { canPresentCalls: canPresentCalls(android), problemMessage: andMsg });
  check(vi.tone === 'attention' && va.tone === 'attention' && vi.action.kind === 'open_settings' && va.action.kind === 'open_settings', 'mic denied: iPhone and Android reach the SAME verdict and action');
  check(/will ring, but callers won't be able to hear you/.test(vi.body), 'iPhone wording: the call still rings (CallKit) but the caller cannot hear you');
  check(/can't ring/.test(va.body), "Android wording: protected calls can't ring");
  check(describeProtection(PROTECTED, { canPresentCalls: false }).body.length > 0, 'no device message → generic wording, still attention');
  const home = read('mobile', 'app', '(tabs)', 'index.tsx');
  check(/problemMessage: deviceProblemMessage/.test(home) && /readinessMessage\(readinessProblem\(r\), Platform\.OS === "ios" \? "ios" : "android"\)/.test(home), 'Home passes the device-specific readiness sentence into the view model');
}

// ── 2. End of setup never claims "nothing else to do" without the server ──
{
  const complete = code(read('mobile', 'app', '(setup)', 'complete.tsx'));
  check(!/Home Call Guard is set up/.test(complete) && !/don't need to do anything else/.test(complete), 'complete.tsx: no unconditional "set up / nothing else to do"');
  check(/describeProtection\(input/.test(complete) && /buildSetupChecklist\(input\)/.test(complete) && /<ProtectionChecklist steps=\{steps\}/.test(complete), 'complete.tsx: shows the server verdict and the gate-driven checklist');
  check(/verdict\?\.isProtected \? "Your phone is protected" : "Your setup steps are done"/.test(complete), 'complete.tsx: "protected" only when the server says so');
  check(/verdict\?\.tone === "attention"\s*\?\s*verdict\.body/.test(complete), 'complete.tsx: an attention state (e.g. app not connected) is shown at the end of setup, not hidden');
}

// ── 3. HCG account number in Help & support ─────────────────────────────
{
  const support = code(read('mobile', 'app', '(tabs)', 'account', 'support.tsx'));
  check(/displayAccountNumber\(d\.account\?\.accountNumber\)/.test(support), 'Help: account number only via displayAccountNumber (never a routing number)');
  check(/subject=\$\{encodeURIComponent\(`Help with \$\{accountNumber\}`\)\}/.test(support), 'Help: support email is pre-addressed with the account number when known');
  check(/What is my HCG account number\?/.test(support) && /Protection needs attention/.test(support), 'Help: FAQs explain the account number and the needs-attention state');
}

// ── 4. First impression matches the approved store story ───────────────
{
  const welcome = code(read('mobile', 'app', '(auth)', 'welcome.tsx'));
  check(/Scam call protection that goes beyond blocking numbers/.test(welcome) && /Trusted people ring straight through/.test(welcome) && /Know when you're protected/.test(welcome), 'sign-in carousel uses the approved screenshot messages');
  check(!/Stop scam calls/i.test(welcome) && !/every scam|guarantee|before they reach/i.test(welcome), 'sign-in carousel makes no overclaim');
  check(!/Android|Google/.test(welcome), 'sign-in carousel never mentions another platform (2.3.10)');
}

// ── 5. Navigation after the tab change ──────────────────────────────────
{
  const activity = code(read('mobile', 'app', '(tabs)', 'activity.tsx'));
  check(/<BackLink label="‹ Home" onPress=\{\(\) => router\.navigate\("\/\(tabs\)"\)\} \/>/.test(activity), 'Activity (no longer a tab) has its own way back to Home');
  const tabs = code(read('mobile', 'app', '(tabs)', '_layout.tsx'));
  const order = ['name="index"', 'name="contacts"', 'name="membership"', 'name="account"'].map((n) => tabs.indexOf(n));
  check(order.every((i, k) => i !== -1 && (k === 0 || i > order[k - 1])), 'tabs in order: Home · Contacts · Membership · Help & Account');
  check(/name="activity" options=\{\{ href: null/.test(tabs), 'Activity is a route, hidden from the tab bar');
  const contacts = code(read('mobile', 'app', '(tabs)', 'contacts', 'index.tsx'));
  check(/Their calls ring straight through and are never monitored\./.test(contacts), 'Contacts explains what a trusted contact means (matches store frame 07)');
}

// ── 6. Price positioning stays dynamic on every 1.0.2 surface ───────────
{
  for (const f of [['(tabs)', 'index.tsx'], ['(tabs)', 'membership.tsx'], ['(setup)', 'complete.tsx'], ['(auth)', 'welcome.tsx'], ['(tabs)', 'account', 'support.tsx']]) {
    check(!/£\s?\d|5\.99|4\.99/.test(code(read('mobile', 'app', ...f))), `${f.join('/')}: no hard-coded price (App Store / Stripe supplies it)`);
  }
  check(!/£\s?\d|5\.99|4\.99/.test(code(read('mobile', 'lib', 'protectionView.ts'))), 'protectionView.ts: no hard-coded price');
}

console.log(failures === 0 ? '\nMobile 1.0.2 iOS experience: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
