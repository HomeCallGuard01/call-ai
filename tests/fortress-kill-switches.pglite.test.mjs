// Global LATCHING breaker + per-household financial hold — integration
// 2026-10-04 (Andrew-approved decisions 1 & 2). Real SQL (every migration,
// PGlite). Proves, at the authority itself:
//   - a spend/rate trip latches; spend returning to normal does NOT reopen it;
//     only the audited manual reset does; latching cannot be switched off;
//   - accounts acting simultaneously during the breaker are all refused;
//   - a household hold blocks EVERY HCG-funded path (calls — trusted, unknown,
//     reserve, essential —, renewals, monitoring start, SMS, AI, number
//     purchase) and cannot be bypassed by retries, simultaneous calls, top-ups,
//     contacts, payment channel or number changes; automatic controls may set
//     but never release a hold; the hold audit is append-only;
//   - automatic FINANCIAL holds (24 h spend anomaly; actual far above estimate).
import { PGlite } from '@electric-sql/pglite';
import { applyAll, pinTestProfiles, rpcs } from './financial-containment-harness.mjs';

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const throws = async (fn, re) => { try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

const NOW = Date.now();
const at = (s) => new Date(NOW + s * 1000).toISOString();
const P = [new Date(NOW - 86400e3).toISOString(), new Date(NOW + 29 * 86400e3).toISOString()];
let n = 0; const sid = () => `CA${String(++n).padStart(32, '0')}`;

async function main() {
  const db = new PGlite();
  await applyAll(db);
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  await pinTestProfiles(q);
  const R = rpcs(q);
  const mk = async (email) => {
    const id = (await q('insert into public.households (auth_user_id, email) values (null, $1) returning id', [email]))[0].id;
    await q(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at) values ($1, 'paid_subscription', 'active', 'stripe', $2)`, [id, P[0]]);
    return id;
  };
  const auth = (hh, s, o = {}) => R.authorize(hh, s, { period: P, now: at(o.t || 0), known: o.known || false, mon: o.mon || false, essential: o.essential || false });
  const hold = (hh, on, source = 'admin', actor = 'admin:test-admin') => q('select public.fc_set_household_hold($1,$2,$3,$4,$5) as r', [hh, on, `test ${on ? 'hold' : 'release'} reason`, actor, source]);

  // ── Decision 1: latching global breaker ────────────────────────────────
  await q(`select public.fc_set_policy($1::jsonb, 'kill-switch test: tiny hourly cap', 'tester')`, [JSON.stringify({ global_hourly_floor_gbp: 0.2, global_hourly_per_household_gbp: 0 })]);
  const g1 = await mk('g1@example.com'); const g2 = await mk('g2@example.com');
  const trip = [];
  for (let i = 0; i < 6; i++) trip.push(await auth(g1, sid()));
  const st1 = (await q('select breaker_open, breaker_reason from public.fc_global_state where id = 1'))[0];
  check(st1.breaker_open === true && trip.some((r) => !r.allowed && r.reason === 'global_hourly_cap'), `a spend-rate trip opens the global breaker (${st1.breaker_reason})`);
  // Spend returns to normal: settle everything, move 2 h on, raise the cap.
  for (const r of await q("select call_sid from public.fc_reservations where state = 'active'")) await R.settle(r.call_sid, 5, at(30));
  await q(`select public.fc_set_policy($1::jsonb, 'kill-switch test: generous cap again', 'tester')`, [JSON.stringify({ global_hourly_floor_gbp: 100 })]);
  const later = await auth(g2, sid(), { t: 7200 });
  check(!later.allowed && later.reason === 'breaker_open', 'LATCHED: two hours later, spend back to normal and caps raised — still refused (no automatic reset)');
  const sim = await Promise.all(Array.from({ length: 8 }, async (_, i) => auth(i % 2 ? g1 : g2, sid(), { t: 7200, known: i % 3 === 0 })));
  check(sim.every((r) => !r.allowed && r.reason === 'breaker_open'), 'simultaneous accounts (incl. trusted callers) during the breaker: every one refused');
  check(await throws(() => q(`select public.fc_set_policy('{"breaker_latch_on_rate": false}'::jsonb, 'try to disable latching', 'tester')`)), 'latching cannot be switched off by policy (CHECK refuses breaker_latch_on_rate=false)');
  check(await throws(() => q(`select public.fc_set_policy('{"breaker_terminates_active": false}'::jsonb, 'try to keep live calls', 'tester')`)), 'the breaker ending live calls cannot be switched off by policy');
  await db.exec('set role authenticated;');
  check(await throws(() => q("select public.fc_reset_breaker('customer tries a reset', 'me')"), /permission denied/), 'a signed-in customer cannot reset the breaker');
  await db.exec('reset role;');
  check(await throws(() => q("select public.fc_reset_breaker('', '')")), 'a reset without a reason and actor is refused');
  const reset = (await q("select public.fc_reset_breaker('manual reset after review of the spend trip', 'admin:test-admin') as r"))[0].r;
  const audit = (await q("select actor, reason, target from public.fc_policy_audit where target = 'breaker' order by id desc limit 1"))[0];
  check(reset.ok && reset.wasOpen === true && audit && audit.actor === 'admin:test-admin' && /manual reset/.test(audit.reason), 'only the manual reset reopens it, and it is audited with the admin actor and reason');
  check((await auth(g2, sid(), { t: 7300 })).allowed, 'after the authorised reset, calls are admitted again');

  // ── Decision 2: per-household financial hold ───────────────────────────
  const h = await mk('held@example.com');
  const live = sid();
  const beforeHold = await auth(h, live, { mon: true, t: 7400 });
  check(beforeHold.allowed, 'precondition: a call admitted before the hold');
  await hold(h, true);
  const audits = (await q('select action, source, actor from public.fc_household_hold_audit where household_id = $1', [h]));
  check(audits.length === 1 && audits[0].action === 'hold' && audits[0].actor === 'admin:test-admin', 'the hold is audited (who, source, reason)');
  const unknown = await auth(h, sid(), { t: 7410 });
  const trusted = await auth(h, sid(), { t: 7410, known: true });
  const essential = await auth(h, sid(), { t: 7410, essential: true });
  check([unknown, trusted, essential].every((r) => !r.allowed && r.reason === 'household_hold'), 'held: unknown, TRUSTED and essential-pool calls all refused');
  const many = await Promise.all(Array.from({ length: 10 }, () => auth(h, sid(), { t: 7420, known: true })));
  check(many.every((r) => !r.allowed && r.reason === 'household_hold'), 'bypass attempt: 10 simultaneous / repeated calls — all refused');
  const retry = await auth(h, live, { t: 7430 });
  check(retry.existing === true, 'a retry of the call admitted before the hold returns the SAME reservation (no new spend)');
  const renew = await R.renew(live, at(7400 + 300 - 60));
  console.log('  renew result:', JSON.stringify(renew));
  check(renew && renew.reason === 'household_hold' && renew.action !== 'renewed', `the live call is NOT renewed — it ends at its lease end (${JSON.stringify(renew).slice(0, 80)})`);
  check((await R.monStarted(live)).reason === 'household_hold', 'bypass attempt: triggering monitoring directly — refused');
  for (const [cat, key] of [['sms', 'sms-held'], ['ai', 'ai-held'], ['number_purchase', 'num-held']]) {
    const r = await R.spend(key, h, cat, 1, at(7440));
    check(!r.allowed && r.reason === 'household_hold', `bypass attempt: ${cat === 'number_purchase' ? 'buying/replacing a number' : cat} — refused`);
  }
  // A paid top-up is recorded (the customer paid) but does not lift the hold.
  await q('select public.credit_allowance($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)', [h, P[0], P[1], 'topup', 1800, 'stripe', 'production', 'pi_held', null, 'p', 299, 'gbp', null, null, false, 0.5637]);
  // Payment channel change: the household's entitlement source changes.
  await q(`update public.entitlements set source = 'apple_revenuecat' where household_id = $1`, [h]);
  check(!(await auth(h, sid(), { t: 7450, known: true })).allowed, 'bypass attempts: a top-up and a payment-channel change — still refused');
  const autoRelease = (await hold(h, false, 'financial', 'system:fortress'))[0].r;
  const stillHeld = (await q('select count(*)::int c from public.fc_household_holds where household_id = $1', [h]))[0].c;
  const refusedAudit = (await q("select count(*)::int c from public.fc_household_hold_audit where household_id = $1 and action = 'refused_release' and source = 'financial'", [h]))[0].c;
  check(autoRelease.ok === false && autoRelease.reason === 'only_admin_can_release' && stillHeld === 1, 'an automatic control cannot RELEASE a hold (still held)');
  check(refusedAudit === 1, 'the refused release attempt is itself recorded in the append-only audit');
  check(await throws(() => q('update public.fc_household_hold_audit set actor = $1', ['rewritten'])) && await throws(() => q('delete from public.fc_household_hold_audit')), 'the hold audit is append-only');
  await db.exec('set role authenticated;');
  check(await throws(() => hold(h, false), /permission denied/), 'a signed-in customer cannot release (or set) a hold');
  await db.exec('reset role;');
  await hold(h, false, 'admin', 'admin:test-admin');
  check((await auth(h, sid(), { t: 7460 })).allowed, 'after an administrator releases the hold, calls are admitted again');

  // ── automatic FINANCIAL holds ──────────────────────────────────────────
  const a1 = await mk('auto@example.com');
  await q(`select public.fc_set_policy($1::jsonb, 'kill-switch test: tiny daily hold threshold', 'tester')`, [JSON.stringify({ household_auto_hold_daily_gbp: 0.05 })]);
  for (let i = 0; i < 4; i++) { const s = sid(); const r = await auth(a1, s, { t: 7500 + i }); if (r.allowed) await R.settle(s, 600, at(8200 + i)); }
  const auto = await auth(a1, sid(), { t: 8300, known: true });
  const row = (await q('select source, actor from public.fc_household_holds where household_id = $1', [a1]))[0];
  check(!auto.allowed && auto.reason === 'household_hold' && row && row.source === 'financial' && row.actor === 'system:fortress', 'automatic financial hold: 24 h household spend above policy ⇒ held (latches until an admin releases it)');
  await q(`select public.fc_set_policy($1::jsonb, 'kill-switch test: default threshold', 'tester')`, [JSON.stringify({ household_auto_hold_daily_gbp: 5 })]);
  const a2 = await mk('undercount@example.com');
  const s2 = sid();
  await auth(a2, s2, { t: 8400 });
  await R.settle(s2, 60, at(8460));
  await R.actual('pr-undercount', s2, 'call', 3.0, at(8500));
  const row2 = (await q('select source from public.fc_household_holds where household_id = $1', [a2]))[0];
  check(row2 && row2.source === 'financial', 'automatic financial hold: provider actual cost far above the estimate ⇒ held');

  const inv = await R.invariants();
  check(inv && inv.ok === true, `Fortress invariants hold (${JSON.stringify(inv).slice(0, 100)})`);
  await db.close();
  console.log(failures === 0 ? '\nAll kill-switch checks passed.' : `\n${failures} kill-switch check(s) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
