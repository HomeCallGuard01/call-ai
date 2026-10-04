// Provider usage alert → HCG latching kill switch (soft-launch integration
// 2026-10-04; containment T11). Unit cases on the handler, then end-to-end
// against the REAL 067 SQL (PGlite) through the REAL database adapter:
// a verified designated alert latches the switch, refuses trusted + unknown
// calls + SMS, ends live calls at renewal, survives replay/forgery, and only
// an admin reset reopens. This is an APPLICATION stop — not a provider cap.
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { applyAll, pinTestProfiles, rpcs, rpcClient, at, PERIOD, T0 } from './financial-containment-harness.mjs';
const require = createRequire(import.meta.url);
const { createProviderUsageAlertHandler } = require('../services/containment/providerUsageAlert');
const financialContainmentDb = require('../database/financialContainment');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const ACC = 'AC00000000000000000000000000000001';
const UT = 'UT00000000000000000000000000000001';
const fired = (sec) => new Date(T0 + sec * 1000).toISOString();
const body = (o = {}) => ({ AccountSid: ACC, UsageTriggerSid: UT, UsageCategory: 'totalprice', CurrentValue: '51.20', TriggerValue: '50', TriggerBy: 'price', DateFired: fired(0), IdempotencyToken: 'tok-1', ...o });

// ── Unit: authentication, designation, replay ────────────────────────────
{
  const kills = []; const alerts = []; const audits = [];
  const mk = (env, over = {}) => createProviderUsageAlertHandler({
    env: { TWILIO_ACCOUNT_SID: ACC, ...env }, now: () => new Date(T0 + 60e3),
    setKillSwitch: async (a) => kills.push(a), sendCriticalAlert: async (t) => alerts.push(t), recordIntervention: async (e) => audits.push(e), ...over,
  });
  const h = mk({ PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS: `UTother, ${UT}` });
  check((await h({ genuine: false, body: body() })).status === 403 && kills.length === 0 && audits.length === 0, 'forged/unsigned alert → 403, no record, no trip');
  check((await h({ genuine: true, body: body({ AccountSid: 'ACevil' }) })).status === 403 && kills.length === 0, 'signed for a different account → 403, no trip');
  const notDesignated = await mk({})({ genuine: true, body: body() });
  check(notDesignated.reason === 'alert_only' && kills.length === 0 && audits.length === 1, 'verified alert, no trip designation → recorded, alert only (previous behaviour)');
  const other = await h({ genuine: true, body: body({ UsageTriggerSid: 'UTnotlisted' }) });
  check(other.reason === 'alert_only' && kills.length === 0, 'verified alert for an undesignated trigger → alert only');
  const t1 = await h({ genuine: true, body: body() });
  check(t1.tripped && kills.length === 1 && kills[0].on === true && kills[0].actor === 'system:provider-usage-alert' && alerts.includes('provider_usage_alert_tripped'), 'verified designated alert → kill switch latched (on=true, system actor), critical alert');
  check((await h({ genuine: true, body: body() })).reason === 'duplicate_alert' && kills.length === 1, 'exact replay (same IdempotencyToken) → not re-tripped');
  check((await h({ genuine: true, body: body({ IdempotencyToken: 'tok-old', DateFired: fired(-7200) }) })).reason === 'stale_alert_not_tripped' && kills.length === 1, 'captured alert older than the window → not tripped (cannot re-latch after an admin reset)');
  const undated = await h({ genuine: true, body: body({ IdempotencyToken: 'tok-u', DateFired: undefined }) });
  check(undated.tripped && undated.reason === 'tripped_undated', 'no DateFired → trips anyway (financial fail-closed), flagged undated');
  const all = await mk({ PROVIDER_USAGE_ALERT_TRIP_ALL: 'true' })({ genuine: true, body: body({ UsageTriggerSid: 'UTany', IdempotencyToken: 'tok-all' }) });
  check(all.tripped, 'PROVIDER_USAGE_ALERT_TRIP_ALL=true → any verified alert trips');
  const down = await mk({ PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS: UT }, { setKillSwitch: async () => { throw new Error('db down'); } })({ genuine: true, body: body({ IdempotencyToken: 'tok-d' }) });
  check(down.status === 500 && !down.tripped && alerts.includes('provider_usage_alert_trip_failed'), 'kill switch unavailable → 500 (provider may retry) + critical "stop spend manually" alert');
  let threw = false; try { createProviderUsageAlertHandler({}); } catch { threw = true; }
  check(threw, 'handler refuses to construct without a kill-switch writer');
}

// ── End to end: real 067 SQL through the real adapter ────────────────────
{
  const db = new PGlite();
  await applyAll(db);
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  await pinTestProfiles(q);
  const R = rpcs(q);
  const client = rpcClient(q);
  const hh = (await q("insert into public.households (auth_user_id, email) values (null, 'ua@test') returning id"))[0].id;
  await q(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at) values ($1, 'paid_subscription', 'active', 'stripe', $2)`, [hh, PERIOD[0]]);

  const live = await R.authorize(hh, 'CA-ua-live', { now: at(0), known: true });
  check(live.allowed, 'before the alert: a trusted call is admitted');

  const handler = createProviderUsageAlertHandler({
    env: { TWILIO_ACCOUNT_SID: ACC, PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS: UT }, now: () => new Date(T0 + 30e3),
    setKillSwitch: (a) => financialContainmentDb.setKillSwitch(a, client),
  });
  // A forged alert first: nothing changes.
  await handler({ genuine: false, body: body({ DateFired: fired(10) }) });
  check((await R.authorize(hh, 'CA-ua-0', { now: at(15) })).allowed, 'forged alert → service unaffected');
  await R.settle('CA-ua-0', 3, at(18));

  const out = await handler({ genuine: true, body: body({ DateFired: fired(20), IdempotencyToken: 'e2e-1' }) });
  check(out.tripped, 'verified designated alert → handler reports tripped');
  const gs = await R.globalStatus(at(31));
  check((await q('select kill_switch from public.fc_global_state where id = 1'))[0].kill_switch === true, 'fc_global_state: kill switch ON');
  const trusted = await R.authorize(hh, 'CA-ua-t', { now: at(32), known: true });
  const unknown = await R.authorize(hh, 'CA-ua-u', { now: at(33), mon: true });
  const sms = await R.spend('sms-ua-1', hh, 'sms', 1, at(34));
  check(!trusted.allowed && trusted.reason === 'kill_switch', 'latched: trusted caller refused (no bypass)');
  check(!unknown.allowed && unknown.reason === 'kill_switch', 'latched: unknown caller refused');
  check(!sms.allowed && sms.reason === 'kill_switch', 'latched: SMS spend refused');
  const renew = await R.renew('CA-ua-live', at(300));
  check(renew && renew.action === 'terminate' && renew.reason === 'kill_switch', 'latched: the live call is told to terminate at renewal (reason kill_switch)');
  const audit = await q("select actor, target from public.fc_policy_audit where target = 'kill_switch' order by 1");
  check(audit.some((a) => a.actor === 'system:provider-usage-alert'), 'the trip is in the append-only policy audit with the system actor');

  // Admin reset, then replays: neither the same token nor a stale capture re-latches.
  await R.kill(false, 'admin: provider spend investigated, resuming', 'admin:andrew');
  check((await R.authorize(hh, 'CA-ua-2', { now: at(400) })).allowed, 'only the admin reset reopens the service');
  await R.settle('CA-ua-2', 3, at(403));
  const replay = await handler({ genuine: true, body: body({ DateFired: fired(20), IdempotencyToken: 'e2e-1' }) });
  check(!replay.tripped && (await R.authorize(hh, 'CA-ua-3', { now: at(410) })).allowed, 'replay of the same signed alert after the reset → not re-latched');
  await R.settle('CA-ua-3', 3, at(413));
  const staleHandler = createProviderUsageAlertHandler({
    env: { TWILIO_ACCOUNT_SID: ACC, PROVIDER_USAGE_ALERT_TRIP_TRIGGER_SIDS: UT }, now: () => new Date(T0 + 3 * 3600e3),
    setKillSwitch: (a) => financialContainmentDb.setKillSwitch(a, client),
  });
  const stale = await staleHandler({ genuine: true, body: body({ DateFired: fired(20), IdempotencyToken: 'e2e-1' }) });
  check(stale.reason === 'stale_alert_not_tripped', 'a restarted process seeing an hours-old captured alert → not tripped');
  const inv = await R.invariants();
  check(inv && inv.ok === true, 'Fortress invariants hold after trip/reset');
}

console.log(failures === 0 ? '\nProvider usage alert → kill switch: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
