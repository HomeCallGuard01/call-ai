// LF-2 (real-device finding 2026-10-05; Andrew's decision B + C, 2026-10-06):
// an ordinary inbound call to an HCG number must NOT mark forwarding as
// verified, and a customer must NEVER be shown "Protected" merely because their
// HCG number received a call. Until forwarding is genuinely proven
// (forwarding_proven_at, migration 074 — set by nothing yet; the verification
// call, option A, awaits approval) every surface uses truthful wording.
//
// Run with: node tests/lf2-forwarding-proof.test.mjs

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.join(__dirname, '..');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'x';
delete process.env.STRIPE_SECRET_KEY;

const { deriveActivationState, STAGES } = require('../services/lifecycle/activationState');
const { mergeProtection } = require('../services/lifecycle/canonicalProtection');
const { computeProtectionStatus } = require('../services/callRouting');
const { buildCustomerProtectionSteps } = require('../services/customerProtectionSteps');
const { detectOpsEvents } = require('../services/opsEvents/detector');
const { TYPES } = require('../services/opsEvents/events');
const { householdExceptions } = require('../services/lifecycle/exceptionQueue');
const { describeProtection, buildSetupChecklist, isServerProtected } = await import('../mobile/lib/protectionView.ts');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const NOW = new Date('2026-10-06T12:00:00Z');
const iso = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();

// The exact device-test shape (staging, 5 Oct): a call reached the HCG number
// (any inbound call stamps activation_verified_at), the app registered, a call
// was delivered — but the protected phone forwards nothing.
const deviceTestHousehold = (o = {}) => ({
  id: 'ffc4cfe1-0000-0000-0000-000000000001', status: 'active', email: 'x@example.com', auth_user_id: 'a', created_at: iso(200),
  twilio_number: '+442046521883', twilio_provisioning_status: 'active', twilio_provisioning_updated_at: iso(200),
  activation_verified_at: iso(100), voice_client_registered_at: iso(2), delivery_verified_at: iso(1), ...o,
});
const ent = { id: 'e', household_id: 'h', entitlement_type: 'paid_subscription', status: 'active', source: 'stripe', starts_at: iso(300), ends_at: null };
const snapOf = (household) => ({ household, entitlements: [ent], subscription: null, quarantineRows: [], financialHold: null, currentNumberAssignedAt: null, failedStripeEvents: [], classification: null });

// ── 1. Canonical state ──────────────────────────────────────────────────
const a = deriveActivationState(snapOf(deviceTestHousehold()), NOW);
check(a.protected === false && a.stage === STAGES.FORWARDING_UNCONFIRMED && a.blockers.join() === 'forwardingVerifiedForCurrentNumber', 'device-test shape (call reached HCG + app + delivered call, no proof) ⇒ forwarding_unconfirmed, NOT protected');
const proven = deriveActivationState(snapOf(deviceTestHousehold({ forwarding_proven_at: iso(50) })), NOW);
check(proven.protected === true && proven.stage === STAGES.PROTECTED, 'only genuine forwarding proof (forwarding_proven_at) completes protection');
const merged = mergeProtection(computeProtectionStatus(deviceTestHousehold(), NOW, null), a);
check(merged.fullyProtected === false && merged.forwardingVerified === false && merged.activationStage === 'forwarding_unconfirmed', 'customer API: fullyProtected false, forwardingVerified false (legacy fields too — shipped 1.0.1 apps can never show protected)');

// ── 2. Nothing writes forwarding proof today ────────────────────────────
{
  const files = [];
  const walk = (dir) => { for (const f of readdirSync(dir)) { const p = path.join(dir, f); if (statSync(p).isDirectory()) { if (!['node_modules', 'tests'].includes(f)) walk(p); } else if (/\.(js|ts|tsx|html)$/.test(f)) files.push(p); } };
  for (const d of ['services', 'routes', 'database', 'mobile/lib', 'mobile/app', 'mobile/components']) walk(path.join(root, d));
  files.push(path.join(root, 'server.js'));
  const writers = files.filter((f) => /forwarding_proven_at\s*[:=]|forwarding_proven_at['"]?\s*\]\s*=|\.update\([^)]*forwarding_proven_at/.test(readFileSync(f, 'utf8')));
  check(writers.length === 0, `no application code writes forwarding_proven_at (option A not enabled) — found: ${writers.map((f) => path.relative(root, f)).join(', ') || 'none'}`);
  const act = readFileSync(path.join(root, 'services', 'activationVerification.js'), 'utf8');
  check(!/forwarding_proven_at/.test(act), 'the /voice auto-stamp (stampActivationVerifiedOnRealCall) never touches forwarding proof');
}

// ── 3. Shipped-app step list + guidance (server) ────────────────────────
{
  const { steps, guidance } = buildCustomerProtectionSteps(deviceTestHousehold(), NOW, null, merged);
  const fwd = steps.find((s) => s.key === 'forwarding_detected');
  check(fwd.done === false && fwd.label === 'Call forwarding confirmed', 'legacy step "Call forwarding confirmed" stays unticked without proof (no longer ticked by a delivered call)');
  check(steps.find((s) => s.key === 'protection_active').done === false, 'legacy "Protection Active" step stays unticked');
  check(guidance && guidance.key === 'forwarding_unconfirmed' && /haven't been able to confirm/.test(guidance.message), 'guidance tells the truth: calls arrive, forwarding not confirmed');
  const src = readFileSync(path.join(root, 'services', 'customerProtectionSteps.js'), 'utf8');
  check(!/set up correctly/.test(src) && !/has protected you before/.test(src), 'no "your call forwarding is set up correctly" / "has protected you before" claims remain');
}

// ── 4. 1.0.2 app wording ────────────────────────────────────────────────
{
  const input = { protection: merged, membership: { status: 'active' } };
  const v = describeProtection(input, { canPresentCalls: true });
  check(!v.isProtected && !isServerProtected(input) && v.tone === 'setup', 'app: not protected, setup tone (never the green protected hero)');
  check(/can't yet confirm your phone's call forwarding/.test(v.body) && v.action && v.action.kind === 'set_up_forwarding', 'app: plain truthful sentence + "Check call forwarding"');
  check(buildSetupChecklist(input).find((x) => x.key === 'forwarding').state === 'todo', 'app checklist: "Call forwarding on" not ticked without proof');
}

// ── 5. Web dashboard ────────────────────────────────────────────────────
{
  const web = readFileSync(path.join(root, 'upload.html'), 'utf8');
  check(/data\.protection\.activationStage === "forwarding_unconfirmed"/.test(web) && /call forwarding not yet confirmed/.test(web), 'web: dedicated truthful message for forwarding_unconfirmed');
  check(/callForwardingCompleted: data && data\.protection && typeof data\.protection\.activationStage === "string"\s*\? data\.protection\.forwardingVerified === true/.test(web), 'web checklist: forwarding ticks only on canonical proof');
  check(!/Your call forwarding is set up correctly/.test(web), 'web: "set up correctly" claim removed');
}

// ── 6. Operations ───────────────────────────────────────────────────────
{
  const r = detectOpsEvents(snapOf(deviceTestHousehold()), NOW);
  check(!r.events.some((e) => e.event_type === TYPES.CUSTOMER_PROTECTED), 'no CUSTOMER_PROTECTED event without proof');
  check(r.events.some((e) => e.event_type === TYPES.CUSTOMER_NEEDS_ATTENTION && e.payload.reason === 'forwarding_not_proven'), 'CUSTOMER_NEEDS_ATTENTION with its own reason "forwarding_not_proven" (support checks with the customer)');
  const { items } = householdExceptions({ ...snapOf(deviceTestHousehold()) }, NOW);
  check(items.some((i) => i.code === 'FORWARDING_NOT_PROVEN'), 'exception queue: FORWARDING_NOT_PROVEN for a genuine paying customer');
  const comms = readFileSync(path.join(root, 'services', 'lifecycle', 'communicationsPlan.js'), 'utf8');
  check(!/FORWARDING_UNCONFIRMED/.test(comms.slice(comms.indexOf('const settingUp'), comms.indexOf('const settingUp') + 200)), 'customers who did everything are not nagged with "finish setup" reminders');
}

console.log(failures === 0 ? '\nLF-2 forwarding proof: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
