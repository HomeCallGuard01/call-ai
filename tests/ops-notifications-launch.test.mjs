// Genuine-customer launch notifications (launch sprint 2026-10-05):
// milestones (first 5, 10, 25, 50, 100), the Resend sender with idempotency,
// retry/failure behaviour, the off-by-default schedule, and the startup rules.
// No real email is sent: the sender's transport is injected.
//
// Run with: node tests/ops-notifications-launch.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'x';
delete process.env.STRIPE_SECRET_KEY; // the classifier's deployment-mode rule must not turn these into Stripe test

const { runOpsEventScan, deliverDueOpsEvents, MAX_ATTEMPTS } = require('../services/opsEvents/runner');
const { createMemoryOpsEventStore } = require('../services/opsEvents/store');
const { renderMessage, isGenuineMilestone, TYPES } = require('../services/opsEvents/events');
const { createResendOpsSender } = require('../services/opsEvents/emailSender');
const { startOpsEventSchedule } = require('../services/opsEvents/scheduler');
const { evaluateLaunchConfig } = require('../services/config/launchConfig');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const NOW = new Date('2026-10-09T12:00:00Z');
const iso = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();
const quiet = () => {};

const ent = (o = {}) => ({ id: 'e', entitlement_type: 'paid_subscription', status: 'active', source: 'stripe', starts_at: iso(1), ends_at: null, ...o });
const household = (n, o = {}) => ({ id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, account_number: `HCG-${String(n).padStart(8, '0')}`, email: `c${n}@example.com`, created_at: iso(2), status: 'active', auth_user_id: `a${n}`, twilio_number: `+4410000${String(n).padStart(5, '0')}`, twilio_provisioning_status: 'active', twilio_provisioning_updated_at: iso(1), activation_verified_at: null, delivery_verified_at: null, voice_client_registered_at: null, ...o });
const snap = (n, { e = ent(), classification = null } = {}) => ({ household: household(n), entitlements: [e], subscription: null, quarantineRows: [], financialHold: null, currentNumberAssignedAt: null, failedStripeEvents: [], classification });

// ── 1. Milestones ───────────────────────────────────────────────────────
{
  check([1, 2, 3, 4, 5, 10, 25, 50, 100].every(isGenuineMilestone) && ![6, 7, 9, 11, 26, 99, 101, 0, null].some(isGenuineMilestone), 'milestones are exactly #1–5, 10, 25, 50, 100');
  const store = createMemoryOpsEventStore();
  const genuine = [1, 2, 3, 4, 5, 6].map((n) => snap(n));
  const notGenuine = [
    snap(90, { classification: 'reviewer' }),
    snap(91, { classification: 'internal_test' }),
    snap(92, { e: ent({ source: 'apple_revenuecat', revenuecat_environment: 'sandbox' }) }),
    snap(93, { e: ent({ source: 'apple_revenuecat', revenuecat_environment: null }) }),
    snap(94, { e: ent({ stripe_livemode: false }) }),
    snap(95, { e: ent({ entitlement_type: 'complimentary', source: 'admin_manual' }) }),
  ];
  const s1 = await runOpsEventScan({ loadSnapshots: async () => ({ snapshots: [...notGenuine, ...genuine] }), store, env: {}, now: NOW, log: quiet });
  const news = [...store.events.values()].filter((e) => e.event_type === TYPES.NEW_GENUINE_CUSTOMER);
  check(news.length === 6 && s1.errors === 0, `exactly the 6 genuine customers produce NEW_GENUINE_CUSTOMER (got ${news.length})`);
  check(!news.some((e) => /-0000000009[0-5]$/.test(e.household_id)), 'reviewer / internal test / Apple sandbox / unverified store / Stripe test / complimentary: no genuine-customer event');
  check(news.map((e) => e.payload.genuineCustomerOrdinal).join() === '1,2,3,4,5,6', 'genuine customers are numbered 1…6 in join order');
  const subjects = news.map((e) => renderMessage(e).subject);
  check(subjects.slice(0, 5).every((t, i) => t === `[HCG ops] MILESTONE: genuine customer #${i + 1} — HCG-${String(i + 1).padStart(8, '0')}`), 'each of the first five is flagged MILESTONE in the subject, with the account number');
  check(subjects[5] === '[HCG ops] genuine customer #6 — HCG-00000006', '#6 is numbered but not a milestone');
  check(!subjects.join(' ').match(/@|\+44|cus_|pi_/), 'subjects carry no email, phone or payment id');

  const s2 = await runOpsEventScan({ loadSnapshots: async () => ({ snapshots: [...genuine, snap(7)] }), store, env: {}, now: NOW, log: quiet });
  const after = [...store.events.values()].filter((e) => e.event_type === TYPES.NEW_GENUINE_CUSTOMER);
  check(after.length === 7 && after.find((e) => e.account_number === 'HCG-00000007').payload.genuineCustomerOrdinal === 7 && s2.recorded >= 1, 're-scan: nobody renumbered or duplicated; the next new customer is #7');
  check(after.filter((e) => e.account_number === 'HCG-00000001').length === 1, 'customer #1 is recorded exactly once across scans');
  const ten = renderMessage({ ...after[0], payload: { ...after[0].payload, genuineCustomerOrdinal: 10 } }).subject;
  check(/MILESTONE: genuine customer #10/.test(ten), '#10 renders as a milestone');
}

// ── 2. Resend sender ────────────────────────────────────────────────────
{
  const calls = [];
  const post = async (req) => { calls.push(req); return { status: 200, body: JSON.stringify({ id: 'em_1' }) }; };
  const msg = { to: 'operations@example.com', subject: 's', text: 't', idempotencyKey: 'new_genuine_customer:hh:email:operations' };
  check((await createResendOpsSender({ env: {}, post }).send(msg)).disabled === true && calls.length === 0, 'email switch off → disabled, nothing sent');
  check((await createResendOpsSender({ env: { OPS_NOTIFY_EMAIL_ENABLED: 'true' }, post }).send(msg)).disabled === true && calls.length === 0, 'no Resend key → disabled, nothing sent');
  const on = createResendOpsSender({ env: { OPS_NOTIFY_EMAIL_ENABLED: 'true', Resend_API_Key: 're_test_key' }, post });
  const r = await on.send(msg);
  check(r.sent === true && r.id === 'em_1' && calls.length === 1 && calls[0].headers['Idempotency-Key'] === msg.idempotencyKey && calls[0].hostname === 'api.resend.com', 'enabled → one POST to Resend carrying the delivery idempotency key');
  check(JSON.parse(calls[0].body).to[0] === 'operations@example.com' && !/re_test_key/.test(calls[0].body), 'recipient from the role; the API key is never in the body');
  let threw = null;
  try { await createResendOpsSender({ env: { OPS_NOTIFY_EMAIL_ENABLED: 'true', Resend_API_Key: 're_test_key' }, post: async () => ({ status: 503, body: 'x' }) }).send(msg); } catch (e) { threw = e; }
  check(threw && /HTTP 503/.test(threw.message) && !/re_test_key/.test(threw.message), 'provider error → throws (so the runner retries); no secret in the error');
}

// ── 3. End-to-end delivery: retry, idempotency, failure isolation ────────
{
  const store = createMemoryOpsEventStore();
  const env = { OPS_NOTIFY_EMAIL_ENABLED: 'true', Resend_API_Key: 're_test_key', OPS_NOTIFY_ROLE_OPERATIONS_EMAIL: 'operations@example.com', OPS_NOTIFY_FOUNDER_EARLY_LAUNCH: 'true', OPS_NOTIFY_ROLE_FOUNDER_EMAIL: 'founder@example.com' };
  await runOpsEventScan({ loadSnapshots: async () => ({ snapshots: [snap(1)] }), store, env, now: NOW, log: quiet });
  const keys = [];
  let status = 503;
  const sender = createResendOpsSender({ env, post: async (req) => { keys.push(req.headers['Idempotency-Key']); return { status, body: '{}' }; } });
  const d1 = await deliverDueOpsEvents({ store, sender, env, now: NOW, log: quiet });
  check(d1.retried === 2 && d1.sent === 0, 'provider down → both role deliveries (operations + founder) scheduled for retry, no exception');
  status = 200;
  const later = new Date(NOW.getTime() + 10 * 60e3);
  const d2 = await deliverDueOpsEvents({ store, sender, env, now: later, log: quiet });
  check(d2.sent === 2, 'provider back → both delivered on retry');
  const opsKeys = keys.filter((k) => /:operations$/.test(k));
  check(opsKeys.length === 2 && opsKeys[0] === opsKeys[1], 'the retry reuses the SAME idempotency key (provider de-duplicates a lost response)');
  const d3 = await deliverDueOpsEvents({ store, sender, env, now: new Date(later.getTime() + 3600e3), log: quiet });
  check(d3.claimed === 0, 'delivered notifications are never sent again');
  check(store.events.size === 1, 'retries never create a second event');

  const failStore = createMemoryOpsEventStore();
  await runOpsEventScan({ loadSnapshots: async () => ({ snapshots: [snap(2)] }), store: failStore, env, now: NOW, log: quiet });
  const bad = createResendOpsSender({ env, post: async () => { throw new Error('ECONNRESET'); } });
  let t = NOW.getTime();
  let last;
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) { last = await deliverDueOpsEvents({ store: failStore, sender: bad, env, now: new Date(t), log: quiet }); t += 7 * 3600e3; }
  check(failStore.deliveries.filter((d) => d.channel === 'email').every((d) => d.status === 'failed'), `after ${MAX_ATTEMPTS} attempts the delivery is FAILED (visible in admin), never silently dropped`);
}

// ── 4. Isolation from customer paths (source) ───────────────────────────
{
  const root = path.join(__dirname, '..');
  const customerPaths = ['routes/billing.js', 'routes/mobileApi.js', 'middleware/requireEntitlement.js', 'services/twilioProvisioning.js', 'database/billing.js'];
  check(customerPaths.every((f) => !/opsEvents/.test(readFileSync(path.join(root, f), 'utf8'))), 'no billing, entitlement, webhook or provisioning file imports the notification code');
  const server = readFileSync(path.join(root, 'server.js'), 'utf8');
  check(/startOpsEventSchedule\(\{/.test(server) && (server.match(/startOpsEventSchedule/g) || []).length === 2, 'server starts the schedule in exactly one place (gated inside the scheduler)');
}

// ── 5. Schedule: off by default; no overlap; errors contained ───────────
{
  const noTimers = { setTimeoutFn: () => 0, setIntervalFn: () => 0 };
  check(startOpsEventSchedule({ env: {}, loadSnapshots: async () => ({ snapshots: [] }), store: createMemoryOpsEventStore(), sender: null, ...noTimers }) === null, 'OPS_EVENTS_SCHEDULE_ENABLED unset → no schedule');
  const store = createMemoryOpsEventStore();
  let release;
  // The schedule runs on the real clock: use a membership that started well in the past.
  const realSnap = { ...snap(3, { e: ent({ starts_at: '2026-01-01T00:00:00Z' }) }), household: household(3, { created_at: '2026-01-01T00:00:00Z' }) };
  const slow = () => new Promise((r) => { release = () => r({ snapshots: [realSnap] }); });
  const sched = startOpsEventSchedule({ env: { OPS_EVENTS_SCHEDULE_ENABLED: 'true' }, loadSnapshots: slow, store, sender: undefined, log: quiet, ...noTimers });
  const first = sched.tick();
  const overlap = await sched.tick();
  check(overlap.skipped === true, 'a tick never overlaps the previous one');
  release();
  const res = await first;
  check(res.scan.recorded >= 1 && [...store.events.values()].some((e) => e.account_number === 'HCG-00000003'), 'enabled tick: scan records the new genuine customer (dashboard alert) even with email off');
  const broken = startOpsEventSchedule({ env: { OPS_EVENTS_SCHEDULE_ENABLED: 'true' }, loadSnapshots: async () => { throw new Error('db down'); }, store: createMemoryOpsEventStore(), sender: undefined, log: quiet, ...noTimers });
  const br = await broken.tick();
  check(br && !br.error && br.scan.aborted === true, 'unreadable database → tick reports aborted, never throws');
  sched.stop(); broken.stop();
}

// ── 6. Startup configuration rules ──────────────────────────────────────
{
  const run = (env) => evaluateLaunchConfig({ HCG_DEPLOYMENT: 'production', ...env });
  const has = (list, id) => list.some((f) => f.id === id);
  check(has(run({ OPS_NOTIFY_EMAIL_ENABLED: 'true' }).fatal, 'ops_email_configured'), 'production refuses email ON without Resend + an operations recipient');
  const ok = run({ OPS_NOTIFY_EMAIL_ENABLED: 'true', Resend_API_Key: 'k', OPS_NOTIFY_ROLE_OPERATIONS_EMAIL: 'operations@homecallguard.co.uk' });
  check(!has(ok.fatal, 'ops_email_configured') && !has(ok.warnings, 'ops_email_configured'), 'email ON with Resend + operations@ → no finding');
  check(!has(run({}).fatal, 'ops_email_configured'), 'email OFF (the default) is never fatal');
  check(has(run({}).warnings, 'ops_events_schedule') && !has(run({ OPS_EVENTS_SCHEDULE_ENABLED: 'true' }).warnings, 'ops_events_schedule'), 'schedule off → warning ("Andrew is not told when a genuine customer joins"); on → none');
}

console.log(failures === 0 ? '\nLaunch notifications: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
