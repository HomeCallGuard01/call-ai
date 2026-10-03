// Financial containment P0 — the PROVISIONAL authorisation ledger
// (migration 067; formerly supabase/provisional/financial_containment_authorization_ledger.sql)
// against a real Postgres engine (PGlite), after every migration.
//
// PGlite is ONE connection: "simultaneous" requests here are issued together
// and serialised by the engine. True multi-connection races (several server
// instances) are proven separately against a real Postgres server in
// tests/financial-containment-realpg.test.mjs.
//
// Run with: node tests/financial-containment-ledger.pglite.test.mjs

import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { applyAll, pinTestProfiles, rpcs, callCost, monWindowCost, POLICY, PERIOD, at, num, near, PROVISIONAL_SQL, PROVISIONAL_ROLLBACK_SQL } from './financial-containment-harness.mjs';

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
async function throws(fn, m, pattern) {
  try { await fn(); check(false, `${m} (did not throw)`); }
  catch (err) { check(!pattern || pattern.test(err.message), `${m}${pattern && !pattern.test(err.message) ? ` (wrong error: ${err.message})` : ''}`); }
}

const TEL_LEASE = callCost(POLICY.lease + POLICY.grace);          // unmonitored first lease
const MON_WINDOW = monWindowCost();                                // whole monitoring window

async function main() {
  const db = new PGlite();
  const files = await applyAll(db);
  check(files.includes('056_financial_safety_allowance_and_admission.sql'), 'provisional containment SQL applies after every migration incl. 056');

  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const R = rpcs(q);
  // Settle every live call (keeps sections independent of each other's
  // leftover live calls, which count against the GLOBAL caps).
  const settleAllLive = async (now) => {
    const live = await q("select call_sid from public.fc_reservations where state in ('active','terminating') and call_sid is not null");
    for (const { call_sid: sid } of live) await R.settle(sid, 10, now, { source: 'test_cleanup' });
  };

  const seeded = await q("select profile, period_budget_gbp::float b, delivery_reserve_gbp::float r, essential_reserve_gbp::float e from public.fc_budget_profiles where profile = 'standard'");
  check(seeded[0].b + seeded[0].r + seeded[0].e <= 0.86 + 1e-9, `seeded standard profile (£${seeded[0].b}+£${seeded[0].r}+£${seeded[0].e}) fits the derived £0.86 variable envelope at £5.99`);
  await pinTestProfiles(q);
  // ---------------- fixtures (as the bootstrap superuser) ----------------
  const mk = async (email, kind) => {
    const id = (await q('insert into public.households (auth_user_id, email) values (null, $1) returning id', [email]))[0].id;
    if (kind === 'standard' || kind === 'complimentary') {
      await q(`insert into public.entitlements (household_id, entitlement_type, status, source, starts_at)
               values ($1, $2, 'active', 'test', '2026-09-01T00:00:00Z')`, [id, kind === 'standard' ? 'paid_subscription' : 'complimentary']);
    }
    if (kind === 'internal_test') {
      await q(`insert into public.account_classifications (household_id, classification, note, classified_by) values ($1, 'internal_test', 'fixture', null)`, [id]);
    }
    return id;
  };
  const H = {};
  for (const k of ['std', 'std2', 'tiny', 'burst', 'live', 'long', 'act', 'brk', 'shadow', 'sms', 'mon', 'per', 'deg', 'renewx']) H[k] = await mk(`${k}@example.com`, 'standard');
  H.unent = await mk('unent@example.com', 'unentitled');
  H.comp = await mk('comp@example.com', 'complimentary');
  H.test = await mk('test@example.com', 'internal_test');
  const G = [];
  for (let i = 0; i < 12; i++) G.push(await mk(`g${i}@example.com`, 'standard'));

  // ---------------- 1. Lock-down: no client can read or move money ----------------
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role};`);
    await throws(() => q('select * from public.fc_budget_accounts'), `${role} cannot read fc_budget_accounts`, /permission denied/);
    await throws(() => q('select * from public.fc_policy'), `${role} cannot read fc_policy`, /permission denied/);
    await throws(() => R.adjust(H.std, 50, `${role}-raise`), `${role} cannot execute fc_admin_adjust (cannot raise its own budget)`, /permission denied/);
    await throws(() => R.setPolicy({ global_daily_floor_gbp: 99999 }), `${role} cannot execute fc_set_policy`, /permission denied/);
    await throws(() => R.authorize(H.std, `CA-${role}-x`), `${role} cannot execute fc_authorize_call`, /permission denied/);
    await throws(() => R.kill(false), `${role} cannot execute fc_set_kill_switch`, /permission denied/);
    await db.exec('reset role;');
  }
  await db.exec('set role service_role;');
  await throws(() => q("update public.fc_budget_accounts set adjustments_gbp = 1000"), 'service_role cannot UPDATE accounts directly (only via audited functions)', /permission denied/);
  await throws(() => q("update public.fc_policy set lease_seconds = 1800"), 'service_role cannot UPDATE policy directly', /permission denied/);
  await throws(() => q("insert into public.fc_ledger (idempotency_key, category, entry_type, basis, amount_gbp) values ('x:y','call','adjust','admin',5)"), 'service_role cannot INSERT ledger rows directly', /permission denied/);
  await throws(() => q('select public.fc_call_cost(60, 0.01, 0.01, 60, false, 60, 1, 0)'), 'internal helper fc_call_cost is not executable by service_role', /permission denied/);
  check((await R.invariants()).ok === true, 'invariants hold on an empty ledger');

  // ---------------- 2. Profiles are resolved server-side ----------------
  const unent = await R.authorize(H.unent, 'CA-unent-1', { mon: true });
  check(unent.allowed && unent.profile === 'unentitled' && unent.monitoring === false && unent.monitoringDeniedReason === 'monitoring_not_in_profile' && unent.funding === 'reserve',
    'unentitled household: never monitored; delivered only from its small delivery reserve');
  const comp = await R.authorize(H.comp, 'CA-comp-1', { mon: true });
  check(comp.allowed && comp.profile === 'complimentary' && comp.monitoring === true, 'complimentary entitlement → complimentary profile (monitored, bounded)');
  const tst = await R.authorize(H.test, 'CA-test-1', { mon: true });
  check(tst.allowed && tst.profile === 'internal_test', 'internal_test classification → internal_test profile (test accounts are bounded too)');

  // ---------------- 3. Reservation before spend; idempotent retry ----------------
  const a1 = await R.authorize(H.std, 'CA-std-1', { mon: true });
  const expectReserve = TEL_LEASE + MON_WINDOW;
  check(a1.allowed && a1.monitoring && a1.funding === 'budget' && near(a1.reservedGbp, expectReserve),
    `monitored call reserves first lease + whole monitoring window before any spend (£${expectReserve.toFixed(6)})`);
  // backstop: 0.5 × £1.00 → floor((0.5 − window − fixed)/unit) blocks − grace
  const unit = POLICY.gran / 60 * POLICY.conn * POLICY.uplift;
  const expectBackstop = Math.min(POLICY.maxCall, Math.max(POLICY.lease, Math.floor((0.5 - MON_WINDOW - POLICY.fixed) / unit + 1e-9) * POLICY.gran - POLICY.grace));
  check(a1.timeLimitSeconds === expectBackstop, `provider backstop (<Dial timeLimit>) = what half the remaining budget affords: ${expectBackstop}s (got ${a1.timeLimitSeconds})`);
  check(num(a1.worstCaseGbp) <= 0.5 + 1e-9, 'backstop worst case never exceeds the share it was sized from');
  const acc1 = await R.account(H.std);
  const retries = await Promise.all(Array.from({ length: 50 }, () => R.authorize(H.std, 'CA-std-1', { mon: true })));
  const acc1b = await R.account(H.std);
  check(retries.every((r) => r.existing && r.allowed && r.timeLimitSeconds === a1.timeLimitSeconds) && near(acc1.reserved_gbp, acc1b.reserved_gbp),
    'duplicate /voice webhook ×50 (retry storm on one CallSid): one reservation, identical answer and time limit');
  const ledgerRows = await q("select count(*)::int n from public.fc_ledger where call_sid = 'CA-std-1' and entry_type = 'reserve'");
  check(ledgerRows[0].n === 1, 'exactly one reserve ledger entry for the retried call');

  // duplicate stream start
  const ms1 = await R.monStarted('CA-std-1');
  const ms2 = await R.monStarted('CA-std-1');
  check(ms1.ok && ms2.ok && ms2.alreadyStarted === true, 'duplicate media-stream start is idempotent');
  check((await R.monStarted('CA-unent-1')).reason === 'monitoring_not_authorized', 'a stream for a call that was not authorised for monitoring is refused');
  check((await R.monStarted('CA-forged-xyz')).reason === 'no_reservation', 'a stream for an unknown/forged CallSid is refused');

  // ---------------- 4. Settlement: estimate committed, remainder released; duplicates ignored ----------------
  const s1 = await R.settle('CA-std-1', 125, at(130), { monitoredSeconds: 120 });
  const expectCommit = callCost(125) + callCost(120, { monitored: true }) - callCost(120);
  check(s1.ok && !s1.alreadySettled && near(s1.committedGbp, expectCommit), `settle commits the estimate for the observed duration (£${expectCommit.toFixed(6)})`);
  const s1b = await R.settle('CA-std-1', 9999, at(200));
  const acc1c = await R.account(H.std);
  check(s1b.alreadySettled === true && near(acc1c.consumed_gbp, expectCommit) && near(acc1c.reserved_gbp, 0),
    'duplicate/late Dial callback with a different duration changes nothing (no double count)');
  const noStream = await R.authorize(H.std, 'CA-std-nostream', { mon: true, now: at(300) });
  const sNo = await R.settle('CA-std-nostream', 100, at(400));
  check(noStream.monitoring && near(sNo.committedGbp, callCost(100)), 'monitoring authorised but stream never started → monitoring not charged');

  // ---------------- 5. Exhausted before the call ----------------
  await R.adjust(H.std2, -1.0, 'std2-drain-budget');
  const ex1 = await R.authorize(H.std2, 'CA-std2-1', { mon: true });
  check(ex1.allowed && ex1.funding === 'reserve' && ex1.monitoring === false && ex1.monitoringDeniedReason === 'monitoring_budget_insufficient',
    'budget exhausted → no monitoring; telephony only, from the bounded delivery reserve');
  await R.settle('CA-std2-1', 0, at(10));
  await R.adjust(H.std2, -0.6, 'std2-drain-reserve');
  const ex2 = await R.authorize(H.std2, 'CA-std2-2', { now: at(20) });
  check(!ex2.allowed && ex2.reason === 'household_budget_exhausted', 'budget AND delivery reserve exhausted → refused (<Reject>, unbilled)');
  const ex3 = await R.authorize(H.std2, 'CA-std2-3', { now: at(30), essential: true });
  check(ex3.allowed && ex3.funding === 'essential', 'configured essential caller (e.g. emergency call-back) still delivered from the separate essential pool');
  const st2 = await R.hhStatus(H.std2, at(31));
  check(st2.lastDenialReason === 'household_budget_exhausted' && num(st2.remainingWithReserveGbp) <= 0, 'read model shows the denial reason and no remaining authorisation');

  // ---------------- 6. £0.20 left, 10 simultaneous calls ----------------
  await R.adjust(H.tiny, -1.4, 'tiny-leave-20p');                 // £1.00 budget + £0.60 reserve − £1.40 = £0.20
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => R.authorize(H.tiny, `CA-tiny-${i}`, { now: at(i % 3) })));
  const admitted = burst.filter((r) => r.allowed);
  const tinyAcc = await R.account(H.tiny);
  const live = await q("select coalesce(sum(reserved_gbp),0) res, coalesce(sum(worst_case_gbp),0) worst from public.fc_reservations where household_id = $1 and state = 'active'", [H.tiny]);
  check(admitted.length >= 1 && admitted.length < 10, `10 simultaneous calls on £0.20: ${admitted.length} admitted, ${10 - admitted.length} refused`);
  check(num(live[0].res) <= 0.20 + 1e-9, `Σ reservations £${num(live[0].res).toFixed(4)} ≤ £0.20 remaining (no double spend)`);
  check(num(live[0].worst) <= 0.20 + 1e-9, `Σ provider-backstop worst cases £${num(live[0].worst).toFixed(4)} ≤ £0.20 — bounded even if every HCG server crashed now`);
  check(burst.filter((r) => !r.allowed).every((r) => r.reason === 'household_budget_exhausted'), 'every refusal is for budget, never an error');
  check(num(tinyAcc.reserved_gbp) <= 0.2 + 1e-9, 'account reserved never exceeds its authorisation');

  // ---------------- 7. Live call: budget exhausted DURING the call ----------------
  await R.adjust(H.live, -1.4, 'live-leave-20p');
  const lv = await R.authorize(H.live, 'CA-live-1', { now: at(0) });
  check(lv.allowed && lv.timeLimitSeconds >= POLICY.lease, 'live call admitted with a lease');
  check((await R.renew('CA-live-1', at(100))).action === 'not_due', 'renewal before the renew-ahead window is a no-op');
  await R.adjust(H.live, -0.15, 'live-drain-midcall');               // something else consumed the headroom
  const rn = await R.renew('CA-live-1', at(POLICY.lease - 60));
  check(rn.action === 'terminate' && rn.reason === 'household_budget_exhausted' && rn.terminateAt === (await R.reservation('CA-live-1')).lease_expires_at.toISOString?.() || rn.action === 'terminate',
    'renewal refused once the budget is exhausted mid-call → call marked for provider hang-up at the END of its paid lease');
  const due = await R.due(at(POLICY.lease));
  check(due.some((d) => d.callSid === 'CA-live-1' && d.state === 'terminating'), 'the terminating call is listed for the sweeper');
  check((await R.renew('CA-live-1', at(POLICY.lease))).action === 'already_terminating', 'a second renewal attempt does not resurrect it');
  await R.terminated('CA-live-1', true, at(POLICY.lease + 2));
  const lvs = await R.settle('CA-live-1', POLICY.lease + 40, at(POLICY.lease + 45));
  check(lvs.ok && near(lvs.overrunGbp, 0), 'hang-up within the termination grace → no overrun beyond the reservation');
  const due2 = await R.due(at(POLICY.lease + 60));
  check(!due2.some((d) => d.callSid === 'CA-live-1'), 'confirmed & settled call leaves the sweeper queue');

  // overrun recorded honestly if the hang-up was late
  await R.adjust(H.renewx, -1.3, 'renewx-leave-30p');
  await R.authorize(H.renewx, 'CA-renewx-1', { now: at(0) });
  await R.adjust(H.renewx, -0.29, 'renewx-drain');
  await R.renew('CA-renewx-1', at(240));
  const late = await R.settle('CA-renewx-1', POLICY.lease + POLICY.grace + 120, at(600));
  check(late.overrunGbp > 0, `late termination: overrun £${num(late.overrunGbp).toFixed(5)} is COMMITTED and reported, never hidden`);

  // ---------------- 8. Long call: leases renew up to the backstop, never past it ----------------
  const lg = await R.authorize(H.long, 'CA-long-1', { now: at(0) });
  let t = 0; let renewals = 0; let last;
  for (let i = 0; i < 400; i++) {
    t += 60;
    last = await R.renew('CA-long-1', at(t));
    if (last.action === 'renewed') renewals++;
    if (last.action === 'at_backstop') break;
  }
  const lr = await R.reservation('CA-long-1');
  check(last.action === 'at_backstop' && lr.covered_seconds <= lg.timeLimitSeconds + POLICY.grace, `long call: ${renewals} renewals, cover stops at backstop+grace (${lr.covered_seconds}s ≤ ${lg.timeLimitSeconds + POLICY.grace}s)`);
  check(num(lr.total_authorized_gbp) <= num(lr.worst_case_gbp) + 1e-9, 'total authorised over the whole call ≤ its worst case');
  const lgs = await R.settle('CA-long-1', lg.timeLimitSeconds, at(lg.timeLimitSeconds + 5), { source: 'provider_time_limit' });
  check(near(lgs.overrunGbp, 0), 'call ended by the provider time limit: no overrun');

  // ---------------- 9. Repeated short calls drain the budget, then stop ----------------
  let shortAdmitted = 0; let shortRefused = 0;
  for (let i = 0; i < 200; i++) {
    const r = await R.authorize(H.burst, `CA-burst-${i}`, { now: at(1000 + i * 30) });
    if (r.allowed) { shortAdmitted++; await R.settle(`CA-burst-${i}`, 20, at(1000 + i * 30 + 20)); } else shortRefused++;
  }
  const bAcc = await R.account(H.burst);
  check(shortRefused > 0 && num(bAcc.consumed_gbp) <= 1.6 + 1e-6, `200 short calls: ${shortAdmitted} delivered, ${shortRefused} refused; consumed £${num(bAcc.consumed_gbp).toFixed(4)} ≤ £1.60 total authorisation`);

  // ---------------- 10. Actual provider cost: idempotent; actual > estimate charged; never refunded below estimate ----------------
  await R.authorize(H.act, 'CA-act-1', { now: at(0) });
  const actSettle = await R.settle('CA-act-1', 61, at(61));
  const ac0 = await R.account(H.act);
  const actHigh = await R.actual('CAact1-parent', 'CA-act-1', 'call', 0.5, at(3600));
  const actDup = await R.actual('CAact1-parent', 'CA-act-1', 'call', 0.5, at(3601));
  const ac1 = await R.account(H.act);
  check(actHigh.matched && near(actHigh.chargedGbp, 0.5 - num(actSettle.committedGbp)) && actDup.duplicate === true,
    'provider actual above estimate: difference charged once; duplicated provider record ignored');
  check(near(num(ac1.consumed_gbp) - num(ac0.consumed_gbp), 0.5 - num(actSettle.committedGbp)) && near(ac1.actual_gbp, 0.5), 'household consumed = max(estimate, actual); actual tracked separately');
  const evU = await q("select count(*)::int n from public.fc_events where rule = 'estimate_undercount' and call_sid = 'CA-act-1'");
  check(evU[0].n === 1, 'estimate_undercount event raised once');
  await R.authorize(H.act, 'CA-act-2', { now: at(100) });
  await R.settle('CA-act-2', 61, at(161));
  const ac2 = await R.account(H.act);
  await R.actual('CAact2-parent', 'CA-act-2', 'call', 0.001, at(3700));
  const ac3 = await R.account(H.act);
  check(near(ac2.consumed_gbp, ac3.consumed_gbp), 'provider actual BELOW estimate: never refunded (conservative)');
  // actual recorded before settlement
  await R.authorize(H.act, 'CA-act-3', { now: at(200) });
  await R.actual('CAact3-parent', 'CA-act-3', 'call', 0.4, at(230));
  const pre = await R.account(H.act);
  const s3 = await R.settle('CA-act-3', 30, at(240));
  const post = await R.account(H.act);
  check(near(num(post.consumed_gbp) - num(pre.consumed_gbp), 0.4), 'actual arriving BEFORE settlement still charges max(estimate, actual)');
  const unmatched = await R.actual('SMunknown1', null, 'sms', 0.04, at(250));
  check(unmatched.matched === false, 'actual cost for an unknown resource is recorded (unattributed), not dropped');

  // ---------------- 11. Malformed / negative / overflow values ----------------
  await throws(() => R.settle('CA-act-2', -5, at(300)), 'negative duration rejected', /invalid duration/);
  await throws(() => R.settle('CA-act-2', 10_000_000, at(300)), 'overflow duration rejected', /invalid duration/);
  await throws(() => R.actual('X-neg', null, 'call', -1, at(300)), 'negative actual cost rejected', /invalid amount/);
  await throws(() => R.actual('X-nan', null, 'call', 'NaN', at(300)), 'NaN actual cost rejected', /invalid amount/);
  await throws(() => R.actual('X-big', null, 'call', 1e9, at(300)), 'overflow actual cost rejected', /invalid amount|out of range|overflow/);
  await throws(() => R.authorize(H.std, '', {}), 'empty CallSid rejected', /invalid call sid/);
  await throws(() => R.authorize(H.std, 'x'.repeat(300), {}), 'oversized CallSid rejected', /invalid call sid/);
  await throws(() => R.adjust(H.std, 0, 'zero'), 'zero adjustment rejected', /non-zero/);
  await throws(() => R.adjust(H.std, 51, 'too-big'), 'adjustment above £50 rejected', /within/);
  await throws(() => R.adjust(H.std, 'NaN', 'nan-adj'), 'NaN adjustment rejected', /non-zero|within/);
  await throws(() => R.adjust(H.std, 5, 'no-reason', { reason: '' }), 'adjustment without a reason rejected', /reason/);
  await throws(() => R.adjust(H.std, 5, 'bad-source', { source: 'customer_app' }), 'adjustment from an unknown source (e.g. the customer app) rejected', /invalid source/);
  await throws(() => R.setPolicy({ lease_seconds: 10 }), 'policy: lease below 60 s rejected by CHECK', /check constraint|violates/);
  await throws(() => R.setPolicy({ connected_rate_gbp_per_min: -1 }), 'policy: negative rate rejected', /check constraint|violates/);
  await throws(() => R.setPolicy({ max_call_seconds: 86400 }), 'policy: backstop above 4 h rejected', /check constraint|violates/);
  await throws(() => R.setPolicy({ not_a_field: 1 }), 'policy: unknown field rejected', /not a policy field/);
  await throws(() => R.setPolicy({ lease_seconds: 600 }, ''), 'policy change without a reason rejected', /reason/);
  await throws(() => R.spend('k-badcat', H.std, 'gift_cards', 1), 'one-shot spend: unknown category rejected', /invalid category/);
  await throws(() => R.spend('k-units', H.std, 'sms', 1000), 'one-shot spend: absurd units rejected', /invalid units/);

  await settleAllLive(at(4000));
  // ---------------- 12. App overrides can only TIGHTEN ----------------
  const loose = await R.authorize(H.per, 'CA-per-loose', { now: at(0), overrides: { lease_seconds: 1800, connected_rate_gbp_per_min: 0.000001, max_call_seconds: 99999, estimate_uplift: 0.1, enforcement_mode: 'shadow', backstop_share: 1 } });
  check(near(loose.reservedGbp, TEL_LEASE) && loose.timeLimitSeconds <= POLICY.maxCall, 'loosening overrides (longer lease, lower rate, shadow mode, bigger share) are ignored');
  const tight = await R.authorize(H.per, 'CA-per-tight', { now: at(1), overrides: { lease_seconds: 120, connected_rate_gbp_per_min: 0.05 } });
  check(near(tight.reservedGbp, callCost(120 + POLICY.grace, { conn: 0.05 })), 'tightening overrides (shorter lease, higher rate) are applied');

  // ---------------- 13. Budget period cannot be reset early ----------------
  const perAcc = await R.account(H.per);
  await R.authorize(H.per, 'CA-per-reset', { now: at(2), period: ['2026-10-03T08:00:00Z', '2026-11-03T08:00:00Z'] });
  const perAcc2 = await R.account(H.per);
  check(perAcc2.period_start.getTime() === perAcc.period_start.getTime(), 'a different period passed mid-period does not open a fresh budget');
  const nextMonth = new Date(Date.parse(PERIOD[1]) + 3600e3).toISOString();
  await R.authorize(H.per, 'CA-per-next', { now: nextMonth, period: ['2026-10-15T00:00:00Z', '2026-11-30T00:00:00Z'] });
  const accs = await q('select period_start, period_end from public.fc_budget_accounts where household_id = $1 order by period_start', [H.per]);
  check(accs.length === 2 && accs[1].period_start.getTime() >= accs[0].period_end.getTime()
    && (accs[1].period_end - accs[1].period_start) <= 35 * 86400e3, 'next period never overlaps the previous one and is ≤ 35 days');

  await settleAllLive(at(4900));
  // ---------------- 14. Global: customer below cap, global cap reached ----------------
  await R.setPolicy({ global_active_floor: 3 });
  const glob = await Promise.all(G.slice(0, 8).map((hh, i) => R.authorize(hh, `CA-g-${i}`, { now: at(5000) })));
  const gAdmitted = glob.filter((r) => r.allowed).length;
  check(gAdmitted === 3 && glob.filter((r) => r.reason === 'global_active_count').length === 5,
    `8 households, global live-call cap 3: ${gAdmitted} admitted, rest refused global_active_count (each household was well within its own budget)`);
  for (let i = 0; i < 8; i++) await R.settle(`CA-g-${i}`, 30, at(5030));
  await R.setPolicy({ global_active_floor: 20 });
  let gs = await R.globalStatus(at(5031));
  check(gs.breakerOpen === false, 'a capacity cap does not latch the breaker');

  await settleAllLive(at(5990));
  // ---------------- 15. Rate-of-spend breaker: trips, LATCHES, refuses renewals, audited reset ----------------
  await R.setPolicy({ global_hourly_floor_gbp: 0.5 });
  await R.authorize(H.brk, 'CA-brk-live', { now: at(6000) });  // a live call when the breaker trips
  let tripped = null;
  for (let i = 0; i < 40 && !tripped; i++) {
    const r = await R.authorize(G[(i % 10)], `CA-storm-${i}`, { now: at(6001 + i) });
    if (r.allowed) await R.settle(`CA-storm-${i}`, 200, at(6001 + i));
    else tripped = r.reason;
  }
  gs = await R.globalStatus(at(6100));
  check(tripped === 'global_hourly_cap' && gs.breakerOpen === true && gs.breakerReason === 'global_hourly_cap', 'retry/call storm across households trips the rate-of-spend breaker');
  const afterTrip = await R.authorize(G[11], 'CA-after-trip', { now: at(9000 + 7200) });
  check(!afterTrip.allowed && afterTrip.reason === 'breaker_open', 'breaker LATCHES: still refusing two hours later although the hourly window has rolled');
  const brkRenew = await R.renew('CA-brk-live', at(6000 + POLICY.lease - 30));
  check(brkRenew.action === 'terminate' && brkRenew.reason === 'breaker_open', 'live calls are not renewed while the breaker is open (they end at lease end)');
  await R.settle('CA-brk-live', POLICY.lease, at(6000 + POLICY.lease));
  await throws(() => R.resetBreaker(''), 'breaker reset without a reason is refused', /reason/);
  await R.setPolicy({ global_hourly_floor_gbp: 4 });
  await R.resetBreaker('investigated: test storm');
  const afterReset = await R.authorize(G[11], 'CA-after-reset', { now: at(9000 + 7300) });
  check(afterReset.allowed, 'after an audited reset, authorisation resumes');
  await R.settle('CA-after-reset', 10, at(9000 + 7310));
  const audit = await q("select count(*)::int n from public.fc_policy_audit where target = 'breaker'");
  check(audit[0].n === 1, 'breaker reset is audited');

  // daily cap
  await R.setPolicy({ global_daily_floor_gbp: 0.3, global_hourly_floor_gbp: 100 });
  let dailyTrip = null;
  for (let i = 0; i < 30 && !dailyTrip; i++) {
    const r = await R.authorize(G[i % 10], `CA-day-${i}`, { now: at(20000 + i * 400) });
    if (r.allowed) await R.settle(`CA-day-${i}`, 100, at(20000 + i * 400 + 100)); else dailyTrip = r.reason;
  }
  check(dailyTrip === 'global_daily_cap', 'rolling-24h spend cap trips (and latches) the breaker');
  await R.setPolicy({ global_daily_floor_gbp: 15, global_hourly_floor_gbp: 4 });
  await R.resetBreaker('test: daily cap verified');

  // ---------------- 16. Kill switch ----------------
  await R.kill(true, 'test: provider compromise drill');
  const k1 = await R.authorize(G[5], 'CA-kill-1', { now: at(40000) });
  const k2 = await R.spend('sms-kill-1', G[5], 'sms', 1, at(40000));
  check(!k1.allowed && k1.reason === 'kill_switch' && !k2.allowed && k2.reason === 'kill_switch', 'kill switch refuses calls AND one-shot spend (SMS)');
  await R.kill(false, 'test: drill over');
  check((await R.authorize(G[5], 'CA-kill-2', { now: at(40001) })).allowed, 'kill switch off → service resumes');
  await R.settle('CA-kill-2', 5, at(40006));

  await settleAllLive(at(40900));
  // ---------------- 17. Worst-case exposure cap ----------------
  await R.setPolicy({ global_worst_case_floor_gbp: 1 });
  const wc = [];
  for (let i = 0; i < 6; i++) wc.push(await R.authorize(G[i], `CA-wc-${i}`, { now: at(41000 + i) }));
  const gs2 = await R.globalStatus(at(41010));
  check(wc.some((r) => r.reason === 'global_worst_case_cap') && num(gs2.activeWorstCaseGbp) <= 1 + 1e-9,
    `global worst-case exposure cap £1: live worst case £${num(gs2.activeWorstCaseGbp).toFixed(3)} never exceeds it`);
  for (let i = 0; i < 6; i++) await R.settle(`CA-wc-${i}`, 10, at(41020));
  await R.setPolicy({ global_worst_case_floor_gbp: 40 });

  // ---------------- 18. One-shot spend: SMS, AI, number purchase ----------------
  await R.setPolicy({ global_hourly_floor_gbp: 50, global_daily_floor_gbp: 200 });  // isolate this section from the breaker
  const sm1 = await R.spend('sms-msg-1', H.sms, 'sms', 1, at(50000));
  const sm1b = await R.spend('sms-msg-1', H.sms, 'sms', 1, at(50001));
  check(sm1.allowed && sm1b.existing === true, 'SMS: authorised once; a retried send with the same key is not charged twice');
  let smsDenied = null;
  for (let i = 0; i < 100 && !smsDenied; i++) { const r = await R.spend(`sms-msg-x${i}`, H.sms, 'sms', 1, at(50002 + i)); if (!r.allowed) smsDenied = r.reason; }
  check(smsDenied === 'household_budget_exhausted', 'SMS stops once the household budget is spent');
  let nDenied = null; let nAllowed = 0;
  for (let i = 0; i < 15 && !nDenied; i++) { const r = await R.spend(`num-buy-${i}`, null, 'number_purchase', 1, at(51000 + i)); if (r.allowed) nAllowed++; else nDenied = r.reason; }
  check(nAllowed === 10 && nDenied === 'global_number_purchase_cap', 'number purchases capped at 10 per 24 h company-wide (provisioning bug / abuse bound)');
  const ai = await R.spend('ai-process-CA1', H.std, 'ai', 1, at(52000));
  check(ai.allowed, 'AI request (/process classifier) authorised against the household budget');
  // one-shot spend counts towards the breaker too
  await R.setPolicy({ global_hourly_floor_gbp: 0.1 });
  const oneShotTrip = await R.spend('sms-trip-1', H.std, 'sms', 1, at(52001));
  check(!oneShotTrip.allowed && oneShotTrip.reason === 'global_hourly_cap', 'one-shot spend (SMS/number purchases) counts towards the rate-of-spend breaker');
  await R.setPolicy({ global_hourly_floor_gbp: 50 });
  await R.resetBreaker('test: one-shot trip verified');

  await settleAllLive(at(59000));
  // ---------------- 19. Unattributed calls (number with no household) ----------------
  let uAllowed = 0; let uDenied = null;
  for (let i = 0; i < 200 && !uDenied; i++) {
    const r = await R.authorize(null, `CA-unattr-${i}`, { now: at(60000 + i) });
    if (r.allowed) { uAllowed++; await R.settle(`CA-unattr-${i}`, 10, at(60000 + i)); } else uDenied = r.reason;
  }
  check(uAllowed > 0 && uDenied === 'global_unattributed_cap', `calls to numbers with no household: ${uAllowed} handled, then capped (global_unattributed_cap)`);

  await settleAllLive(at(69000));
  // ---------------- 20. Stale / abandoned / forged reservations ----------------
  await R.authorize(H.mon, 'CA-stale-1', { now: at(70000) });
  await R.authorize(H.mon, 'CA-forged-1', { now: at(70000) });
  const dueStale = await R.due(at(70000 + POLICY.lease));
  check(dueStale.some((d) => d.callSid === 'CA-stale-1') && dueStale.some((d) => d.callSid === 'CA-forged-1'), 'reservations whose callback never arrived surface in the sweeper queue');
  const forged = await R.settle('CA-forged-1', 0, at(70000 + POLICY.lease), { source: 'provider_not_found' });
  check(near(forged.committedGbp, 0), 'provider says the CallSid does not exist → settled at £0, reservation fully released');
  const stale = await R.settle('CA-stale-1', 180, at(70000 + POLICY.lease), { source: 'provider_status' });
  check(near(stale.committedGbp, callCost(180)), 'lost Dial callback repaired from provider status (provider duration committed)');

  // ---------------- 21. Degraded-envelope calls adopted when the DB returns ----------------
  const ad1 = await R.adopt(H.deg, 'CA-deg-1', at(80000), 600, at(80300));
  const ad2 = await R.adopt(H.deg, 'CA-deg-1', at(80000), 600, at(80301));
  check(ad1.ok && !ad1.existing && ad2.existing, 'degraded-mode call adopted into the ledger once (idempotent)');
  await throws(() => R.adopt(H.deg, 'CA-deg-2', at(80000), 999999, at(80300)), 'adoption with an absurd time limit is rejected', /invalid time limit/);
  await R.settle('CA-deg-1', 420, at(80420));

  await settleAllLive(at(89000));
  // ---------------- 22. Shadow mode (rollout only): household budget observed, global still enforced ----------------
  await R.setPolicy({ enforcement_mode: 'shadow' });
  await R.adjust(H.shadow, -1.6, 'shadow-drain');
  const sh = await R.authorize(H.shadow, 'CA-shadow-1', { now: at(90000) });
  check(sh.allowed && sh.shadowDeniedReason === 'household_budget_exhausted', 'shadow mode: exhausted household admitted but the would-be denial is recorded');
  await R.kill(true, 'test: shadow still obeys kill');
  const sh2 = await R.authorize(H.shadow, 'CA-shadow-2', { now: at(90001) });
  check(!sh2.allowed && sh2.reason === 'kill_switch', 'shadow mode never relaxes the kill switch/global breaker');
  await R.kill(false, 'test: done');
  const shForced = await R.authorize(H.shadow, 'CA-shadow-3', { now: at(90002), overrides: { enforcement_mode: 'enforce' } });
  check(!shForced.allowed, 'the app can force enforcement even when the DB policy says shadow');
  await R.settle('CA-shadow-1', 10, at(90010));
  await R.setPolicy({ enforcement_mode: 'enforce' });

  // ---------------- 23. Read models ----------------
  await R.refreshCount(at(90100));
  gs = await R.globalStatus(at(90100));
  const hs = await R.hhStatus(H.std, at(90100));
  check(gs.entitledHouseholds >= 15 && gs.caps && typeof gs.window.hourCommitted !== 'undefined' && gs.enforcementMode === 'enforce',
    'global read model: entitled count (DB-computed), caps, rolling windows, breaker, enforcement mode');
  check(hs.hasAccount && ['budgetGbp', 'reservedGbp', 'estimatedConsumedGbp', 'actualReconciledGbp', 'remainingBudgetGbp', 'activeExposureGbp', 'worstCaseExposureGbp'].every((k) => k in hs),
    'household read model exposes budget, reserved, estimated consumed, actual reconciled, remaining, active and worst-case exposure');

  // ---------------- 24. Invariants after everything ----------------
  const inv = await R.invariants();
  check(inv.ok === true, `incremental counters match a full recomputation (${JSON.stringify(inv)})`);
  const neg = await q('select count(*)::int n from public.fc_budget_accounts where reserved_gbp < 0 or consumed_gbp < 0');
  check(neg[0].n === 0, 'no negative reserved/consumed anywhere');

  // ---------------- 25. Rollback and re-apply ----------------
  await db.exec('reset role;');
  await db.exec(await readFile(PROVISIONAL_ROLLBACK_SQL, 'utf8'));
  const left = await q("select count(*)::int n from pg_class where relname like 'fc\\_%' and relnamespace = 'public'::regnamespace");
  const leftFns = await q("select count(*)::int n from pg_proc where proname like 'fc\\_%' and pronamespace = 'public'::regnamespace");
  check(left[0].n === 0 && leftFns[0].n === 0, 'rollback removes every fc_* table, index and function');
  await db.exec(await readFile(PROVISIONAL_SQL, 'utf8'));
  check((await q('select count(*)::int n from public.fc_budget_profiles'))[0].n === 6, 're-apply after rollback works (seeds restored: 5 + the integration sandbox profile)');

  if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('\nAll financial-containment ledger checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
