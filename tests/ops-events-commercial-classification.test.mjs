// Commercial classification + operational events (soft-launch integration
// 2026-10-04, after the 28 Sep 2026 investigation and Andrew's notification
// requirement). Test/reviewer/sandbox activity must never be "Paying", never
// produce a NEW_GENUINE_CUSTOMER event, never count as revenue and never buy
// a real number; events are exactly-once; delivery is off by default, retries
// never duplicate the event, and messages carry no contact/payment data.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { applyAll } from './financial-containment-harness.mjs';
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { classifyCommercialStatus, decideNumberPurchaseByProvenance, STATUS } = require('../services/commercial/commercialStatus');
const { deriveCustomerHealth, summariseCustomerHealth } = require('../services/adminCustomerHealth');
const { householdExceptions } = require('../services/lifecycle/exceptionQueue');
const { detectOpsEvents } = require('../services/opsEvents/detector');
const { assertSafe, renderMessage, TYPES } = require('../services/opsEvents/events');
const { createMemoryOpsEventStore } = require('../services/opsEvents/store');
const { runOpsEventScan, deliverDueOpsEvents, MAX_ATTEMPTS } = require('../services/opsEvents/runner');
const { ensureTwilioNumberProvisioned } = require('../services/twilioProvisioning');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const NOW = new Date('2026-10-04T12:00:00Z');
const iso = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();
const ent = (o = {}) => ({ id: 'e1', household_id: 'hh', entitlement_type: 'paid_subscription', status: 'active', source: 'stripe', starts_at: iso(72), ends_at: null, ...o });

// ── 1. One classifier, every category Andrew listed ──────────────────────
const CASES = [
  ['genuine production paying — Web/Stripe (live)', { currentEntitlement: ent() }, STATUS.GENUINE_PAYING],
  ['genuine production paying — Apple production', { currentEntitlement: ent({ source: 'apple_revenuecat', revenuecat_environment: 'production' }) }, STATUS.GENUINE_PAYING],
  ['Apple sandbox (incl. TestFlight / App Review)', { currentEntitlement: ent({ source: 'apple_revenuecat', revenuecat_environment: 'sandbox' }) }, STATUS.STORE_SANDBOX],
  ['Google test purchase', { currentEntitlement: ent({ source: 'google_revenuecat', revenuecat_environment: 'sandbox' }) }, STATUS.STORE_SANDBOX],
  ['Apple grant with NO recorded environment (the 28 Sep case)', { currentEntitlement: ent({ source: 'apple_revenuecat', revenuecat_environment: null }) }, STATUS.STORE_ENVIRONMENT_UNVERIFIED],
  ['Stripe test mode', { currentEntitlement: ent({ stripe_livemode: false }) }, STATUS.STRIPE_TEST],
  ['complimentary customer', { currentEntitlement: ent({ entitlement_type: 'complimentary', source: 'admin_manual' }) }, STATUS.COMPLIMENTARY],
  ['internal/test account with a paid entitlement', { currentEntitlement: ent(), classification: 'internal_test' }, STATUS.INTERNAL_OR_TEST],
  ['App Review reviewer account', { currentEntitlement: ent({ source: 'apple_revenuecat', revenuecat_environment: 'production' }), classification: 'reviewer' }, STATUS.INTERNAL_OR_TEST],
  ['paid entitlement from an unknown source', { currentEntitlement: ent({ source: 'mystery' }) }, STATUS.STORE_ENVIRONMENT_UNVERIFIED],
];
for (const [name, input, expected] of CASES) {
  const c = classifyCommercialStatus(input);
  check(c.status === expected && c.genuinePaying === (expected === STATUS.GENUINE_PAYING), `${name} → ${expected}`);
}

// ── 2. Non-production store activity cannot buy a real number ────────────
{
  const rig = () => {
    const st = { purchased: 0 };
    const client = { availablePhoneNumbers: () => ({ local: { list: async () => [{ phoneNumber: '+441615550123' }] } }), incomingPhoneNumbers: Object.assign(() => ({ remove: async () => {} }), { create: async (p) => { st.purchased++; return { sid: 'PN1', phoneNumber: p.phoneNumber }; }, list: async () => [] }) };
    return { st, client };
  };
  const run = async (rows, extra = {}) => {
    const { st, client } = rig();
    const r = await ensureTwilioNumberProvisioned({ id: 'hh-p', twilio_number: null, twilio_provisioning_attempts: 0 }, { client, assign: async () => true, recordFailure: async () => {}, sendAlert: async () => {}, appUrl: 'https://hcg.test', isQuarantinedNumber: async () => false, readHouseholdNumber: async () => null, env: { NODE_ENV: 'test' }, readActiveEntitlements: typeof rows === 'function' ? rows : async () => rows, ...extra });
    return { r, st };
  };
  const sandbox = await run([ent({ source: 'apple_revenuecat', revenuecat_environment: 'sandbox' })]);
  check(sandbox.st.purchased === 0 && sandbox.r.provenanceRefused, 'Apple sandbox/TestFlight/App Review entitlement → NO real number purchased');
  const sandboxAdmin = await run([ent({ source: 'apple_revenuecat', revenuecat_environment: 'sandbox' })], { abuseOverride: 'admin' });
  check(sandboxAdmin.st.purchased === 0, '… and an admin override cannot force it');
  const unverified = await run([ent({ source: 'apple_revenuecat', revenuecat_environment: null })]);
  check(unverified.st.purchased === 0 && /store_environment_unverified/.test(unverified.r.error), 'environment-unverified store grant → refused (fail closed)');
  const unverifiedAdmin = await run([ent({ source: 'apple_revenuecat', revenuecat_environment: null })], { abuseOverride: 'admin' });
  check(unverifiedAdmin.st.purchased === 1, '… unless an admin explicitly overrides after checking RevenueCat');
  check((await run([ent()])).st.purchased === 1 && (await run([ent({ source: 'apple_revenuecat', revenuecat_environment: 'production' })])).st.purchased === 1 && (await run([ent({ entitlement_type: 'complimentary', source: 'admin_manual' })])).st.purchased === 1, 'Stripe live, Apple production and complimentary entitlements still provision');
  check((await run([])).st.purchased === 0, 'no active entitlement → no purchase');
  check((await run(async () => { throw new Error('db down'); })).st.purchased === 0, 'entitlement provenance unreadable → no purchase');
  check(decideNumberPurchaseByProvenance([ent({ source: 'apple_revenuecat', revenuecat_environment: 'sandbox' }), ent()]).allowed, 'a household with a sandbox grant AND a real Stripe membership can still provision');
  const src = readFileSync(path.join(ROOT, 'services/twilioProvisioning.js'), 'utf8');
  check(src.indexOf('decideNumberPurchaseByProvenance(') < src.indexOf('authorizeNumberPurchase({ householdId') && src.indexOf('decideNumberPurchaseByProvenance(') < src.indexOf('incomingPhoneNumbers.create('), 'the provenance check precedes every spend in the single purchase path (webhook, checkout poll, admin retry, invites)');
}

// ── 3. Admin labels and counts: only genuine money is "Paying" ───────────
{
  const hh = { id: 'hh', created_at: iso(200), twilio_number: '+441000000647', twilio_provisioning_status: 'active' };
  const rows = CASES.map(([, input]) => deriveCustomerHealth({ household: hh, entitlements: [{ ...input.currentEntitlement }], lastCallAt: null, lastDial: null, classification: input.classification || null }, NOW));
  const counts = summariseCustomerHealth(rows);
  check(counts.paying === 2, `exactly the 2 genuine production rows count as paying (got ${counts.paying})`);
  const unverifiedRow = rows[4];
  check(unverifiedRow.account.label !== 'Paying' && unverifiedRow.account.kind === 'payment_unverified', `the 28 Sep shape is labelled "${unverifiedRow.account.label}", not "Paying"`);
  check(rows[2].account.kind === 'store_sandbox' && rows[7].account.kind === 'test_paid', 'sandbox and test-held paid entitlements have their own kinds');
}

// ── 4. Event detection: only genuine customers produce customer events ───
const household = (o = {}) => ({ id: '0ffd9843-0000-0000-0000-000000000001', account_number: 'HCG-00000042', email: 'someone@example.com', created_at: iso(96), status: 'active', auth_user_id: 'a', twilio_number: '+441000000647', twilio_provisioning_status: 'active', twilio_provisioning_updated_at: iso(95), activation_verified_at: null, delivery_verified_at: null, voice_client_registered_at: null, ...o });
const snap = (o = {}, e = ent({ starts_at: iso(95) })) => ({ household: household(o.household), entitlements: [e], subscription: null, quarantineRows: [], financialHold: o.financialHold === undefined ? null : o.financialHold, currentNumberAssignedAt: null, failedStripeEvents: [], classification: o.classification || null });
for (const [name, input] of CASES.filter(([, , s]) => s !== STATUS.GENUINE_PAYING)) {
  const r = detectOpsEvents(snap({ classification: input.classification }, input.currentEntitlement), NOW);
  check(r.events.length === 0, `no customer event for: ${name}`);
}
{
  const fresh = detectOpsEvents(snap({ household: { created_at: iso(2), twilio_provisioning_updated_at: iso(1) } }, ent({ starts_at: iso(1) })), NOW);
  check(fresh.events.map((e) => e.event_type).join() === TYPES.NEW_GENUINE_CUSTOMER, 'genuine customer, just joined → NEW_GENUINE_CUSTOMER only');
  const late = detectOpsEvents(snap(), NOW);
  check(late.events.some((e) => e.event_type === TYPES.CUSTOMER_NEEDS_ATTENTION && e.payload.reason === 'not_protected_within_onboarding_window'), 'genuine customer not protected after the onboarding window → CUSTOMER_NEEDS_ATTENTION');
  const prot = detectOpsEvents(snap({ household: { activation_verified_at: iso(90), delivery_verified_at: iso(89), voice_client_registered_at: iso(91) } }), NOW);
  check(prot.events.map((e) => e.event_type).sort().join() === [TYPES.CUSTOMER_PROTECTED, TYPES.NEW_GENUINE_CUSTOMER].sort().join(), 'genuine customer protected → CUSTOMER_PROTECTED (+ the one-off NEW event key)');
  const held = detectOpsEvents(snap({ financialHold: { held: true, source: 'financial', reason: 'x', heldAt: iso(3) }, household: { activation_verified_at: iso(90), delivery_verified_at: iso(89), voice_client_registered_at: iso(91) } }), NOW);
  check(held.events.some((e) => e.event_type === TYPES.CUSTOMER_NEEDS_ATTENTION && e.payload.reason === 'financial_hold'), 'protected customer placed on a financial hold → NEEDS_ATTENTION (financial_hold)');
  const e = late.events.find((x) => x.event_type === TYPES.NEW_GENUINE_CUSTOMER);
  check(e.account_number === 'HCG-00000042' && e.payload.channelLabel === 'Web (Stripe)' && e.payload.numberState === 'active' && e.payload.onboardingStage && e.payload.protected === false && 'joinedAt' in e.payload, 'event carries account number, joined, channel, number STATE, onboarding stage, protection');
  const text = JSON.stringify(e) + renderMessage(e).text + renderMessage(e).subject;
  check(!/someone@example\.com|\+?44\d{6,}|647\b|cus_|sub_|pi_|20000\d+/.test(text), 'no email, telephone number or payment identifier in the event or the rendered message');
  let threw = false; try { assertSafe({ ...e, payload: { ...e.payload, email: 'x' } }); } catch { threw = true; }
  check(threw, 'assertSafe refuses a payload containing a contact field');
}

// ── 5. Exactly once; delivery off by default; retries never duplicate ────
{
  const store = createMemoryOpsEventStore();
  const load = async () => ({ snapshots: [snap(), snap({ classification: 'reviewer' }), snap({}, ent({ source: 'apple_revenuecat', revenuecat_environment: 'sandbox' }))] });
  const s1 = await runOpsEventScan({ loadSnapshots: load, store, env: {}, now: NOW, log: () => {} });
  const s2 = await runOpsEventScan({ loadSnapshots: load, store, env: {}, now: NOW, log: () => {} });
  check(s1.recorded === 2 && s2.recorded === 0 && s2.alreadyRecorded === 2 && store.events.size === 2, `scan twice → events recorded once (${store.events.size}); reviewer + sandbox produced none`);
  check(store.deliveries.length === 4 && store.deliveries.every((d) => d.status === 'disabled'), 'deliveries created once per event (2 events × email+push), all DISABLED by default');
  let sends = 0;
  const d0 = await deliverDueOpsEvents({ store, sender: { send: async () => { sends++; return {}; } }, env: {}, now: NOW, log: () => {} });
  check(sends === 0 && d0.claimed === 0, 'default configuration: nothing is sent');

  const store2 = createMemoryOpsEventStore();
  const env = { OPS_NOTIFY_EMAIL_ENABLED: 'true', OPS_NOTIFY_ROLE_OPERATIONS_EMAIL: 'ops-role@example.invalid', OPS_NOTIFY_FOUNDER_EARLY_LAUNCH: 'true', OPS_NOTIFY_ROLE_FOUNDER_EMAIL: 'founder-role@example.invalid' };
  await runOpsEventScan({ loadSnapshots: async () => ({ snapshots: [snap()] }), store: store2, env, now: NOW, log: () => {} });
  let calls = 0; let fail = true;
  const flaky = { send: async (m) => { calls++; if (fail) throw new Error('provider down'); check(!/someone@example/.test(m.text), 'sent body has no customer email'); return { id: 'x' }; } };
  let t = NOW.getTime();
  for (let i = 0; i < 3; i++) { await deliverDueOpsEvents({ store: store2, sender: flaky, env, now: new Date(t), log: () => {} }); t += 7 * 3600e3; }
  const evCount = store2.events.size;
  check(evCount === 2 && store2.deliveries.filter((d) => d.channel === 'email').every((d) => d.status === 'retry' && d.attempts === 3), 'provider failures → deliveries retried (attempts 3), events NOT duplicated');
  fail = false;
  await deliverDueOpsEvents({ store: store2, sender: flaky, env, now: new Date(t), log: () => {} });
  const before = calls;
  await deliverDueOpsEvents({ store: store2, sender: flaky, env, now: new Date(t + 7 * 3600e3), log: () => {} });
  check(store2.deliveries.filter((d) => d.channel === 'email').every((d) => d.status === 'sent') && calls === before, 'recovery → each email sent exactly once; later runs send nothing');
  check(store2.deliveries.filter((d) => d.channel === 'email').map((d) => d.recipient_role).sort().join() === 'founder,founder,operations,operations', 'operations role always; founder role only when early-launch flag is on');
  const store3 = createMemoryOpsEventStore();
  await runOpsEventScan({ loadSnapshots: async () => ({ snapshots: [snap()] }), store: store3, env: { OPS_NOTIFY_EMAIL_ENABLED: 'true', OPS_NOTIFY_ROLE_OPERATIONS_EMAIL: 'o@example.invalid' }, now: NOW, log: () => {} });
  let tt = NOW.getTime();
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) { await deliverDueOpsEvents({ store: store3, sender: { send: async () => { throw new Error('down'); } }, env: { OPS_NOTIFY_EMAIL_ENABLED: 'true', OPS_NOTIFY_ROLE_OPERATIONS_EMAIL: 'o@example.invalid' }, now: new Date(tt), log: () => {} }); tt += 7 * 3600e3; }
  check(store3.deliveries.filter((d) => d.channel === 'email').every((d) => d.status === 'failed'), `after ${MAX_ATTEMPTS} attempts a delivery is FAILED (visible on the dashboard), never silently dropped`);
  const broken = await runOpsEventScan({ loadSnapshots: async () => { throw new Error('db down'); }, store, now: NOW, log: () => {} });
  check(broken.aborted === true, 'scan with an unreadable database reports and returns — never throws');
}

// ── 6. Isolation and configuration ───────────────────────────────────────
{
  const server = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const users = ['server.js', 'routes/billing.js', 'routes/mobileApi.js', 'services/twilioProvisioning.js'].filter((f) => /opsEvents\/(runner|detector)/.test(readFileSync(path.join(ROOT, f), 'utf8')));
  check(users.length === 0 && !/runOpsEventScan|deliverDueOpsEvents/.test(server), 'the event runner is not wired into any entitlement/call/webhook path and is NOT scheduled');
  const dir = path.join(ROOT, 'services/opsEvents');
  const hardcoded = readdirSync(dir).filter((f) => /['"`][^'"`\s]+@[a-z0-9-]+\.[a-z.]+['"`]/i.test(readFileSync(path.join(dir, f), 'utf8')));
  check(hardcoded.length === 0, 'no email address is hard-coded in services/opsEvents (roles come from configuration)');
}

// ── 7. The 28 Sep 2026 account, replayed through the candidate ──────────
{
  const s = snap({ household: { id: '0ffd9843-0000-4000-8000-000000000028', account_number: null, created_at: '2026-09-28T04:46:40Z', twilio_provisioning_updated_at: '2026-09-28T04:48:31Z' } }, ent({ source: 'apple_revenuecat', revenuecat_environment: null, starts_at: '2026-09-28T04:48:29Z', ends_at: '2026-10-05T04:49:49Z' }));
  const q = householdExceptions(s, NOW);
  const ev = detectOpsEvents(s, NOW);
  check(q.items.some((i) => i.code === 'PAYMENT_ENVIRONMENT_UNVERIFIED') && !q.items.some((i) => i.code === 'SETUP_STALLED') && ev.events.length === 0, '28 Sep account: queue says PAYMENT_ENVIRONMENT_UNVERIFIED (verify in RevenueCat), no "paid customer" claim, no new-customer event');
}

// ── 8. Migration 072 on PGlite ───────────────────────────────────────────
{
  const db = new PGlite();
  await applyAll(db);
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const hh = (await q("insert into public.households (auth_user_id, email) values (null, 'ops@test') returning id"))[0].id;
  const event = { event_key: `new_genuine_customer:${hh}`, event_type: 'new_genuine_customer', household_id: hh, account_number: null, severity: 'info', payload: { numberState: 'active' }, occurred_at: NOW.toISOString() };
  const dels = [{ channel: 'email', recipient_role: 'operations', status: 'pending' }, { channel: 'push', recipient_role: 'operations', status: 'disabled' }];
  const r = await Promise.all([1, 2, 3].map(() => q('select public.ops_record_event($1::jsonb, $2::jsonb) as r', [JSON.stringify(event), JSON.stringify(dels)]).then((x) => x[0].r)));
  check(r.filter((x) => x.inserted).length === 1 && (await q('select count(*)::int n from public.ops_events'))[0].n === 1 && (await q('select count(*)::int n from public.ops_event_deliveries'))[0].n === 2, '072: same event recorded 3× → 1 event, 2 deliveries');
  let bad = false; try { await q('select public.ops_record_event($1::jsonb, $2::jsonb)', [JSON.stringify({ ...event, event_key: 'k2', payload: { email: 'x@y.z' } }), '[]']); } catch { bad = true; }
  check(bad, '072: a payload with a contact field is rejected by the table constraint');
  const claimed = (await q('select public.ops_claim_due_deliveries($1, 10, 60) as r', ['2099-01-01T00:00:00Z']))[0].r;
  check(claimed.length === 1 && claimed[0].delivery.channel === 'email', '072: claim returns only the pending email delivery (disabled push never claimed)');
  await q('select public.ops_complete_delivery($1, $2, null, null)', [claimed[0].delivery.id, 'sent']);
  let back = false; try { await q('select public.ops_complete_delivery($1, $2, null, null)', [claimed[0].delivery.id, 'retry']); } catch { back = true; }
  check(back, '072: a sent delivery is terminal');
  const seen = (await q("select public.ops_mark_event_seen($1, 'admin:test') as r", [r[0].event.id]))[0].r;
  check(seen.seen_at && seen.seen_by === 'admin:test', '072: mark seen is recorded with the admin actor');
  let rb = false; try { await db.exec(readFileSync(path.join(ROOT, 'supabase/migrations/_rollbacks/072_rollback_operational_events.sql'), 'utf8')); } catch { rb = true; }
  check(rb, '072 rollback refuses while event history exists');
}

console.log(failures === 0 ? '\nCommercial classification + operational events: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
