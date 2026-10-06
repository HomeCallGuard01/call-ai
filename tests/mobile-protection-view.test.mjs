// Mobile 1.0.2 customer protection view (mobile/lib/protectionView.ts).
//
// Every customer state below is produced by the REAL backend resolver
// (services/lifecycle/canonicalProtection.js + customerProtectionSteps.js),
// shaped like GET /api/v1/me/dashboard's `protection`, and then worded by the
// mobile view model — so this proves the app's headline follows server truth,
// not a fixture someone typed. The view model has no platform input, so iPhone
// and Android cannot disagree (asserted at the end).
//
// Covers the brief's Task 14 matrix (1–13), the September incident (paid,
// forwarding working, app never registered, calls never reached the
// customer), fail-closed unknown state, older backends, device permissions,
// the allowance rule, membership wording and the HCG account number.
//
// Run with: node tests/mobile-protection-view.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeProtection, buildSetupChecklist, isServerProtected, describeMembership, displayAccountNumber, HEADLINES, legacyHomeState,
} from '../mobile/lib/protectionView.ts';
import { computeHomeProtectionState } from '../mobile/lib/homeStatus.ts';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { resolveCanonicalProtection } = require('../services/lifecycle/canonicalProtection');
const { buildCustomerProtectionSteps } = require('../services/customerProtectionSteps');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const NOW = new Date('2026-10-04T12:00:00Z');
const iso = (d) => new Date(NOW.getTime() - d * 86400e3).toISOString();

// Synthetic household — no real customer data.
const HH = {
  id: 'hh-view-test', status: 'active', email: 'test@example.com', auth_user_id: 'auth-test', stripe_customer_id: 'cus_test',
  twilio_number: '+447700900001', twilio_provisioning_status: 'active',
  activation_verified_at: iso(5), forwarding_proven_at: iso(5), delivery_verified_at: iso(4), voice_client_registered_at: iso(3),
};
const ENT = { id: 'e1', household_id: HH.id, entitlement_type: 'paid_subscription', status: 'active', starts_at: iso(20), ends_at: null, source: 'stripe' };
const BASE = { entitlements: [ENT], subscription: null, quarantineRows: [], financialHold: null, currentNumberAssignedAt: iso(10), failedStripeEvents: [] };

// Build the dashboard `protection` object exactly as routes/mobileApi.js does:
// canonical merge + checklist + the raw household fields it passes through.
async function dashboard({ snap = {}, hh = {}, deliveryHealth = null, loader = null } = {}) {
  const household = { ...HH, ...hh };
  const s = { ...BASE, ...snap, household };
  const { protection } = await resolveCanonicalProtection({
    supabase: {}, household, deliveryHealth, now: NOW, log: () => {},
    loadSnapshots: loader || (async () => ({ snapshots: [s] })),
  });
  const { steps, guidance } = buildCustomerProtectionSteps(household, NOW, deliveryHealth, protection);
  return {
    ...protection,
    twilioProvisioningStatus: household.twilio_provisioning_status,
    activationVerifiedAt: household.activation_verified_at,
    recentDeliveryProblem: false,
    steps,
    guidance,
  };
}

const OK_DEVICE = { canPresentCalls: true };
const allOutputs = [];
const view = (input, device = OK_DEVICE) => {
  const v = describeProtection(input, device);
  allOutputs.push(v.headline, v.body, v.action ? v.action.label : '');
  return v;
};
const stepState = (input, key) => buildSetupChecklist(input).find((s) => s.key === key).state;

// ── 1. genuine paying + fully protected ─────────────────────────────────
{
  const input = { protection: await dashboard(), membership: { status: 'active' } };
  const v = view(input);
  check(v.tone === 'protected' && v.isProtected && v.headline === 'YOUR PHONE IS PROTECTED' && v.action === null, '1 paying + fully protected → YOUR PHONE IS PROTECTED, no action');
  check(buildSetupChecklist(input).every((s) => s.state === 'done'), '1 every setup step ticked from server gates');
  check(isServerProtected(input), '1 isServerProtected agrees');
}

// ── 2. paying + app not registered — THE SEPTEMBER INCIDENT ─────────────
{
  // Forwarding works (calls reached HCG → activation_verified_at), the app
  // never registered, no call was ever delivered.
  const p = await dashboard({ hh: { voice_client_registered_at: null, delivery_verified_at: null } });
  const input = { protection: p, membership: { status: 'active' } };
  const v = view(input);
  check(p.activationStage === 'awaiting_app' && p.fullyProtected === false, '2 server stages the incident as awaiting_app, not protected');
  check(v.tone === 'attention' && v.headline === HEADLINES.attention, '2 incident → PROTECTION NEEDS ATTENTION (prominent), never reassuring');
  check(v.action && v.action.kind === 'reconnect_app' && v.action.label === 'Reconnect this phone', '2 incident → the one action is "Reconnect this phone"');
  check(/can't reach you/.test(v.body) && !/set up correctly|almost there|automatically/i.test(v.body), '2 incident body says calls cannot reach them; no "set up correctly / completes automatically"');
  check(stepState(input, 'forwarding') === 'done' && stepState(input, 'app') === 'todo' && stepState(input, 'first_call') === 'todo', '2 checklist: forwarding ✓, this phone ○, first call ○');
  // Same incident, after a delivery had worked once (reconnect_needed).
  const r = await dashboard({ hh: { voice_client_registered_at: null } });
  const vr = view({ protection: r, membership: { status: 'active' } });
  check(r.activationStage === 'reconnect_needed' && vr.tone === 'attention' && vr.action.kind === 'reconnect_app', '2b delivered before, app now unreachable → attention + reconnect');
  // Registered once but the server's delivery evidence says UNREACHABLE.
  const u = await dashboard({ deliveryHealth: { state: 'UNREACHABLE' } });
  const vu = view({ protection: u, membership: { status: 'active' } });
  check(u.fullyProtected === false && vu.tone === 'attention' && vu.action.kind === 'reconnect_app', '2c delivery health UNREACHABLE → attention + reconnect');
}

// ── 3. paying + forwarding incomplete ───────────────────────────────────
{
  const p = await dashboard({ hh: { activation_verified_at: null, forwarding_proven_at: null, delivery_verified_at: null, voice_client_registered_at: iso(1) } });
  const input = { protection: p, membership: { status: 'active' } };
  const v = view(input);
  check(p.activationStage === 'awaiting_forwarding' && v.tone === 'setup' && v.headline === HEADLINES.setup, '3 forwarding incomplete → FINISH SETTING UP PROTECTION');
  check(v.action.kind === 'set_up_forwarding' && v.action.label === 'Turn on call forwarding', '3 action: Turn on call forwarding');
  check(stepState(input, 'membership') === 'done' && stepState(input, 'number') === 'done' && stepState(input, 'forwarding') === 'todo', '3 checklist: membership ✓ number ✓ forwarding ○');
}

// ── 4. membership active + number not ready ─────────────────────────────
{
  const p = await dashboard({ hh: { twilio_provisioning_status: 'pending', activation_verified_at: null, forwarding_proven_at: null, delivery_verified_at: null } });
  const input = { protection: p, membership: { status: 'active' } };
  const v = view(input);
  check(p.activationStage === 'awaiting_number' && v.tone === 'setup' && /number ready/.test(v.body), '4 number not ready → setup, "getting your protected number ready"');
  check(stepState(input, 'membership') === 'done' && stepState(input, 'number') === 'todo', '4 checklist: membership ✓ number ○');
  const f = await dashboard({ hh: { twilio_provisioning_status: 'failed', twilio_number: null, activation_verified_at: null, forwarding_proven_at: null, delivery_verified_at: null } });
  const vf = view({ protection: f, membership: { status: 'active' } });
  check(f.activationStage === 'number_failed' && vf.tone === 'attention' && vf.action.kind === 'contact_support', '4b number provisioning failed → attention + contact support');
}

// ── 5. payment issue ────────────────────────────────────────────────────
{
  const input = { protection: await dashboard(), membership: { status: 'payment_issue' } };
  const v = view(input);
  check(v.tone === 'attention' && !v.isProtected && v.action.kind === 'update_payment', '5 payment issue → attention + Update payment (not the green protected hero)');
  const m = describeMembership({ status: 'payment_issue' }, (d) => d);
  check(m.label === 'Payment needs attention' && m.tone === 'warning', '5 membership label: Payment needs attention');
}

// ── 6. cancelled but protected until end date ───────────────────────────
{
  const input = { protection: await dashboard(), membership: { status: 'cancelled', accessUntil: '2026-10-28T00:00:00Z' } };
  const v = view(input);
  check(v.tone === 'protected', '6 cancelled-at-period-end, still entitled → still protected (server says so)');
  const m = describeMembership({ status: 'cancelled', accessUntil: '2026-10-28T00:00:00Z' }, () => '28 October 2026');
  check(m.label === 'Cancelled — protection continues until 28 October 2026', '6 membership label: Cancelled — protection continues until [date]');
}

// ── 7. financial hold ───────────────────────────────────────────────────
{
  const p = await dashboard({ snap: { financialHold: { held: true, source: 'financial', reason: 'spend anomaly', heldAt: iso(0) } } });
  const input = { protection: p, membership: { status: 'active' } };
  const v = view(input);
  check(p.activationStage === 'on_hold' && v.tone === 'attention' && v.action.kind === 'contact_support', '7 financial hold → attention + contact support');
  check(!/financ|hold|spend|fortress/i.test(v.body), '7 hold wording never mentions finance/hold internals');
  check(v.body === "Protection is paused on your account, so forwarded calls can't reach you right now. Callers hear a busy tone. Contact us and we'll sort it out. If you need your calls straight away, turn off call forwarding." && v.action.label === 'Contact support', '7 D-C5 approved wording, exactly: says calls are not reaching them, the busy tone, and how to get calls back');
  check(!isServerProtected(input), '7 a held household is never shown as protected');
  check(stepState(input, 'membership') === 'todo', '7 checklist: membership step not ticked while held');
}

// ── 8. quarantined number ───────────────────────────────────────────────
{
  const p = await dashboard({ snap: { quarantineRows: [{ id: 'q1', household_id: HH.id, twilio_number: HH.twilio_number, quarantined_at: iso(1), released_at: null }] } });
  const input = { protection: p, membership: { status: 'active' } };
  const v = view(input);
  check(p.activationStage === 'number_conflict' && v.tone === 'attention' && v.action.kind === 'contact_support', '8 quarantined number → attention + contact support');
  check(!/quarantin/i.test(v.body) && stepState(input, 'number') === 'todo', '8 no "quarantine" wording; number step not ticked');
}

// ── 9. old-number mismatch ──────────────────────────────────────────────
{
  const p = await dashboard({ snap: { currentNumberAssignedAt: iso(1) } });
  const input = { protection: p, membership: { status: 'active' } };
  const v = view(input);
  check(p.activationStage === 'awaiting_forwarding' && p.fullyProtected === false, '9 server: evidence predates current number → awaiting_forwarding');
  check(v.tone === 'attention' && v.action.kind === 'set_up_forwarding' && v.action.label === 'Update call forwarding' && /old number/.test(v.body), '9 old number → attention + Update call forwarding');
  check(stepState(input, 'forwarding') === 'todo' && stepState(input, 'first_call') === 'todo', '9 checklist: forwarding and first call NOT ticked for the old number');
}

// ── 10. no entitlement ──────────────────────────────────────────────────
{
  // In production /me/dashboard answers 402 here (Home's not_entitled
  // screen); the view model still words it safely if a stage ever arrives.
  for (const [name, snap] of [['never had one', { entitlements: [] }], ['ended', { entitlements: [{ ...ENT, status: 'expired', ends_at: iso(1) }] }]]) {
    const p = await dashboard({ snap });
    const v = view({ protection: p, membership: null });
    check(['signed_up', 'membership_ended'].includes(p.activationStage) && v.tone === 'setup' && !v.isProtected && v.action.kind === 'resume_setup', `10 no entitlement (${name}) → setup, Start protection`);
  }
  check(describeMembership(null, (d) => d).label === 'Protection unavailable', '10 membership label: Protection unavailable');
  const home = readFileSync(path.join(ROOT, 'mobile/app/(tabs)/index.tsx'), 'utf8');
  check(/state === "not_entitled"[\s\S]{0,400}FINISH SETTING UP PROTECTION/.test(home), '10 Home not_entitled screen uses the setup headline, never protected');
}

// ── 11. complimentary customer ──────────────────────────────────────────
{
  const p = await dashboard({ snap: { entitlements: [{ ...ENT, entitlement_type: 'complimentary', source: 'admin_manual' }] } });
  const v = view({ protection: p, membership: { status: 'active' } });
  check(p.fullyProtected === true && v.tone === 'protected', '11 complimentary with real evidence → protected (same rule as paying)');
  const m = describeMembership({ status: 'active', complimentary: true }, (d) => d);
  check(m.label === 'Active — complimentary' && /No payment/.test(m.detail), '11 membership label: Active — complimentary');
}

// ── 12. sandbox Apple entitlement ───────────────────────────────────────
{
  // Sandbox grants get no real number (services/twilioProvisioning.js).
  const p = await dashboard({ snap: { entitlements: [{ ...ENT, source: 'apple_revenuecat' }] }, hh: { twilio_provisioning_status: 'pending', twilio_number: null, activation_verified_at: null, forwarding_proven_at: null, delivery_verified_at: null } });
  const v = view({ protection: p, membership: { status: 'active' }, testPurchase: true });
  check(p.activationStage === 'awaiting_number' && v.tone === 'setup' && /test purchase/.test(v.body) && v.action === null, '12 sandbox Apple purchase → setup, explains test purchase, no endless "check again"');
  check(describeMembership({ status: 'active', testPurchase: true }, (d) => d).label === 'Test purchase', '12 membership label: Test purchase');
}

// ── 13. reviewer / test account ─────────────────────────────────────────
{
  // A pre-provisioned complimentary household (routes/mobileApi.js). Its
  // classification is admin-only and never sent to the app, so it follows
  // exactly the same evidence rules as any customer.
  const fresh = await dashboard({ snap: { entitlements: [{ ...ENT, entitlement_type: 'complimentary', source: 'admin_manual' }] }, hh: { activation_verified_at: null, forwarding_proven_at: null, delivery_verified_at: null, voice_client_registered_at: null } });
  const v = view({ protection: fresh, membership: { status: 'active' } });
  check(v.tone === 'setup' && v.action.kind === 'set_up_forwarding' && !v.isProtected, '13 reviewer account before forwarding → setup (never shown protected without evidence)');
}

// ── Fail closed: state unknown ──────────────────────────────────────────
{
  const p = await dashboard({ loader: async () => { throw new Error('db down'); } });
  const input = { protection: p, membership: { status: 'active' } };
  const v = view(input);
  check(p.protectionBlockers.length === 1 && v.tone === 'unknown' && !v.isProtected, 'unreadable state → WE CAN\'T CONFIRM, never protected');
  check(buildSetupChecklist(input).every((s) => s.state === 'unknown'), 'unreadable state → NO checklist step ticked (blockers=[stateKnown] must not read as "everything else done")');
  const held = await dashboard({ snap: { financialHold: { unreadable: true } } });
  check(view({ protection: held }).tone === 'unknown', 'hold table unreadable → unknown');
  const future = view({ protection: { ...(await dashboard()), fullyProtected: false, activationStage: 'some_future_stage', protectionBlockers: ['x'] } });
  check(future.tone === 'unknown', 'a stage this app does not know → unknown, never guessed');
  const disagree = { protection: { ...(await dashboard()), fullyProtected: true, activationStage: 'awaiting_app', protectionBlockers: ['appReachable'] } };
  check(!isServerProtected(disagree) && !view(disagree).isProtected, 'fullyProtected=true but stage disagrees → fail closed');
}

// ── This phone cannot present calls ─────────────────────────────────────
{
  const v = view({ protection: await dashboard(), membership: { status: 'active' } }, { canPresentCalls: false });
  check(v.tone === 'attention' && !v.isProtected && v.action.kind === 'open_settings', 'server-protected but mic/notifications denied on this phone → attention + Open Settings');
  const incident = await dashboard({ hh: { voice_client_registered_at: null, delivery_verified_at: null } });
  check(view({ protection: incident }, { canPresentCalls: false }).action.kind === 'open_settings', 'incident + permission denied → fix the permission first');
}

// ── Allowance honesty ───────────────────────────────────────────────────
{
  const p = await dashboard();
  const off = view({ protection: p, membership: { status: 'active' }, allowance: { status: 'used_up', monitoringActive: false, callsContinue: true } });
  check(!off.isProtected && /aren't being checked/.test(off.body), 'monitoringActive=false → not shown as protected; says calls aren\'t being checked');
  const inactive = view({ protection: p, membership: { status: 'active' }, allowance: { status: 'inactive', monitoringActive: false } });
  check(inactive.isProtected, 'allowance status "inactive" (no allowance product) does not override protection');
}

// ── Older backend (no activationStage) ──────────────────────────────────
{
  const legacy = { fullyProtected: false, deliveryReady: false, endToEndDeliveryVerified: false, activationVerifiedAt: iso(2) };
  const v = view({ protection: legacy });
  check(v.tone === 'attention' && v.action.kind === 'reconnect_app', 'older backend, incident shape → attention + reconnect (was "Almost there")');
  check(view({ protection: { ...legacy, fullyProtected: true, deliveryReady: true, endToEndDeliveryVerified: true } }).isProtected, 'older backend, fully protected → protected');
  check(buildSetupChecklist({ protection: legacy }).find((s) => s.key === 'app').state === 'todo', 'older backend checklist uses reported facts only');
}

{
  let agree = true;
  for (const av of [null, iso(1)]) for (const e2e of [false, true]) for (const ready of [false, true]) for (const full of [false, true]) for (const prob of [false, true]) for (const done of [false, true]) {
    const p = { activationVerifiedAt: av, endToEndDeliveryVerified: e2e, deliveryReady: ready, fullyProtected: full, recentDeliveryProblem: prob };
    if (legacyHomeState(p, done) !== computeHomeProtectionState({ protection: p }, done)) agree = false;
  }
  check(agree, 'legacy fallback is identical to homeStatus.ts computeHomeProtectionState for all 64 input combinations');
}

// ── HCG account number ──────────────────────────────────────────────────
check(displayAccountNumber('HCG-00010017') === 'HCG-00010017', 'account number in migration 062 format is shown');
check([null, undefined, '', '+447700900001', '07700900001', 'hh-view-test', 'HCG-1234', 'hcg-00010017', 'HCG-0001001X'].every((x) => displayAccountNumber(x) === null), 'routing numbers, ids and malformed values are never shown as the account number');

// ── No internal vocabulary reaches the customer ─────────────────────────
{
  const text = allOutputs.join(' | ');
  const banned = /twilio|supabase|openai|quarantin|entitle|fortress|blocker|routing|uuid|provision|webhook|revenuecat|stripe/i;
  check(!banned.test(text), 'no provider/internal vocabulary in any headline, body or action label');
}

// ── iPhone and Android cannot disagree ──────────────────────────────────
{
  const src = readFileSync(path.join(ROOT, 'mobile/lib/protectionView.ts'), 'utf8').replace(/\/\/.*$/gm, '');
  check(!/Platform|"ios"|"android"|react-native/.test(src), 'protectionView.ts has no platform input — one verdict for both apps');
  const home = readFileSync(path.join(ROOT, 'mobile/app/(tabs)/index.tsx'), 'utf8');
  check(/describeProtection\(protectionInput/.test(home) && /buildSetupChecklist\(protectionInput\)/.test(home), 'Home renders the hero and checklist from the view model');
  check(!/You're protected/.test(home), 'Home no longer has its own "You\'re protected" wording outside the view model');
}

console.log(failures === 0 ? '\nMobile protection view: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
