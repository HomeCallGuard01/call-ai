// Financial containment P0 — application layer with fakes: config
// validation, economics, fail-closed authorisation, the degraded envelope,
// the lease sweeper (renew / terminate / provider repair / DB outage), SMS
// and number-purchase gates, and the customer read model.
// Run with: node tests/financial-containment-service.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Existing modules (provisioning → Supabase client) need these to load;
// dummies only — nothing here talks to a real service.
process.env.SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.SUPABASE_ANON_KEY ||= 'dummy';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { resolveContainmentConfig, isEssentialCaller } = require('../services/containment/policy');
const { deriveVariableEnvelope, validateProfileAgainstEconomics } = require('../services/containment/economicPolicy');
const { createContainment } = require('../services/containment/containment');
const { createLeaseSweeper } = require('../services/containment/leaseSweeper');
const { createTwilioCallControl } = require('../services/containment/twilioCallControl');
const { createContainmentReadModel } = require('../services/containment/readModel');
const { createSmsBudget } = require('../services/usage/smsBudget');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

// A controllable clock.
function clock(startIso = '2026-10-03T09:00:00Z') {
  let t = Date.parse(startIso);
  const now = () => new Date(t);
  now.advance = (sec) => { t += sec * 1000; };
  return now;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---------------- policy.js ----------------
  {
    const c = resolveContainmentConfig({});
    check(c.requireSignedVoice === true && c.degradedMode === 'bounded' && c.overrides.enforcement_mode === 'enforce' && c.warnings.length === 0,
      'defaults: signed /voice required, bounded degraded envelope, always ask the DB to ENFORCE');
    const bad = resolveContainmentConfig({ FC_DEGRADED_MODE: 'yolo', FC_DEGRADED_MAX_CONCURRENT: '500', FC_DEGRADED_MAX_CALL_SECONDS: '99999',
      FC_REQUIRE_SIGNED_VOICE: 'maybe', FC_SWEEP_INTERVAL_MS: '600000', FC_MIN_CONNECTED_RATE_GBP_PER_MIN: '-3' });
    check(bad.degradedMode === 'reject', 'unknown degraded mode → reject (most conservative), never "bounded"');
    check(bad.degradedMaxConcurrent === 0 && bad.degradedMaxCallSeconds === 60, 'out-of-range degraded limits fall to the MINIMUM, never clamp up');
    check(bad.requireSignedVoice === true, 'unparseable FC_REQUIRE_SIGNED_VOICE keeps signature enforcement');
    check(bad.sweepIntervalMs <= 30000, 'sweep interval capped inside the renew-ahead window');
    check(!('connected_rate_gbp_per_min' in bad.overrides) && bad.warnings.length >= 5, 'invalid override ignored; every invalid value is reported');
    const sh = resolveContainmentConfig({ FC_ALLOW_SHADOW: 'true' });
    check(!('enforcement_mode' in sh.overrides), 'shadow is possible only if FC_ALLOW_SHADOW=true AND the DB policy says shadow');
    const ess = resolveContainmentConfig({ FC_ESSENTIAL_CALLERS: '+44 7700 900123, 999, 01632960000' });
    check(isEssentialCaller(ess, '07700900123') && isEssentialCaller(ess, '+441632960000') && !isEssentialCaller(ess, '+447700900124') && ess.essentialCallers.length === 2,
      'essential callers normalised (+44/0) and invalid entries dropped');
  }

  // ---------------- economicPolicy.js ----------------
  {
    const d = deriveVariableEnvelope();
    check(Math.abs(d.netRevenueGbp - 4.9917) < 0.001 && Math.abs(d.deliveryCostCeilingGbp - 2.995) < 0.001,
      `£5.99 inc VAT → net £${d.netRevenueGbp}, 60% delivery ceiling £${d.deliveryCostCeilingGbp}`);
    check(d.variableEnvelopeGbp < d.deliveryCostCeilingGbp && Math.abs(d.variableEnvelopeGbp - 0.858) < 0.01,
      `the safe variable envelope (£${d.variableEnvelopeGbp}) is far below the £2.995 ceiling once rental, fees, infrastructure, reserve and overrun are taken out`);
    const seedsSql = readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '067_financial_containment_authorization_ledger.sql'), 'utf8');
    // Integration 2026-10-03: the paid profiles' reserve scope is 'trusted_only'; any scope is accepted here (the check is the £).
    const m = seedsSql.match(/\('standard',\s*([\d.]+),\s*([\d.]+),\s*'(?:all|trusted_only|none)',\s*([\d.]+),/);
    const v = validateProfileAgainstEconomics({ periodBudgetGbp: m[1], deliveryReserveGbp: m[2], essentialReserveGbp: m[3] });
    check(v.ok, `seeded standard profile (£${v.totalAuthorisationGbp}) fits the derived envelope (£${v.variableEnvelopeGbp})`);
    check(!validateProfileAgainstEconomics({ periodBudgetGbp: 2.995, deliveryReserveGbp: 0, essentialReserveGbp: 0 }).ok,
      'setting the allowance to the raw 60% ceiling (£2.995) is rejected');
    const cheaper = deriveVariableEnvelope({ priceIncVatGbp: 9.99 });
    check(cheaper.variableEnvelopeGbp > d.variableEnvelopeGbp, 'economics are parameters: a price change recalculates the envelope without code changes');
    let threw = false; try { deriveVariableEnvelope({ vatRate: -1 }); } catch { threw = true; }
    check(threw, 'invalid economic inputs are rejected');
  }

  // ---------------- containment.js: authorisation ----------------
  const hh = { id: '11111111-1111-1111-1111-111111111111' };
  const okDb = (over = {}) => ({
    authorizeCall: async () => ({ allowed: true, monitoring: true, timeLimitSeconds: 1200, leaseExpiresAt: '2026-10-03T09:05:00Z', funding: 'budget' }),
    markMonitoringStarted: async () => ({ ok: true }),
    settleCall: async () => ({ ok: true }),
    authorizeSpend: async () => ({ allowed: true }),
    adoptDegradedCall: async () => ({ ok: true }),
    ...over,
  });
  {
    const events = [];
    const c = createContainment({ db: okDb(), recordEvent: async (e) => events.push(e) });
    const unsigned = await c.authorizeCall({ household: hh, callSid: 'CA1', isKnown: false, wantsMonitoring: true, signatureValid: false });
    check(!unsigned.allowed && unsigned.reason === 'unsigned_request', 'unsigned /voice: no reservation, refused (<Reject>) — forged requests cost and pin nothing');
    const ok = await c.authorizeCall({ household: hh, callSid: 'CA2', isKnown: false, wantsMonitoring: true, signatureValid: true });
    check(ok.allowed && ok.monitoring && ok.timeLimitSeconds === 1200 && ok.source === 'database', 'database decision passed through with its time limit');
    const noLimit = createContainment({ db: okDb({ authorizeCall: async () => ({ allowed: true, timeLimitSeconds: null }) }), env: { FC_DEGRADED_MODE: 'reject' } });
    const nl = await noLimit.authorizeCall({ household: hh, callSid: 'CA3', signatureValid: true });
    check(!nl.allowed, 'an "allowed" answer without a valid time limit is treated as no answer (never an unbounded Dial)');
    const rejected = createContainment({ db: okDb({ authorizeCall: async () => { throw new Error('fc_authorize_call failed: fc_authorize_call: invalid call sid'); } }) });
    const rj = await rejected.authorizeCall({ household: hh, callSid: 'CA-bad', signatureValid: true });
    check(!rj.allowed && rj.reason === 'invalid_request' && rejected._state.degraded.admissions.length === 0,
      'authority REJECTS the request (validation/constraint error) → refused, never the degraded envelope');
    const fk = createContainment({ db: okDb({ authorizeCall: async () => { throw new Error('insert or update on table "fc_budget_accounts" violates foreign key constraint'); } }) });
    check(!(await fk.authorizeCall({ household: hh, callSid: 'CA-fk', signatureValid: true })).allowed, 'unknown/deleted household (FK violation) → refused');
    const malformed = createContainment({ db: okDb({ authorizeCall: async () => 'yes' }), env: { FC_DEGRADED_MODE: 'reject' } });
    check(!(await malformed.authorizeCall({ household: hh, callSid: 'CA4', signatureValid: true })).allowed, 'malformed authority response → refused (reject mode)');
  }
  {
    // DB timeout → degraded envelope, bounded per instance; then extended outage → reject
    const now = clock();
    const hang = () => new Promise(() => {});
    const c = createContainment({ db: okDb({ authorizeCall: hang }), now, env: { FC_RPC_TIMEOUT_MS: '200', FC_DEGRADED_MAX_CONCURRENT: '2', FC_DEGRADED_MAX_CALLS_PER_HOUR: '3', FC_DEGRADED_MAX_OUTAGE_SECONDS: '600' } });
    const t0 = Date.now();
    const d1 = await c.authorizeCall({ household: hh, callSid: 'CD1', signatureValid: true, wantsMonitoring: true });
    check(Date.now() - t0 < 1000 && d1.allowed && d1.source === 'degraded' && d1.monitoring === false && d1.timeLimitSeconds === 600,
      'DB timeout (200 ms): degraded envelope admits, NEVER monitored, 10-min provider time limit');
    const d2 = await c.authorizeCall({ household: hh, callSid: 'CD2', signatureValid: true });
    const d3 = await c.authorizeCall({ household: hh, callSid: 'CD3', signatureValid: true });
    check(d2.allowed && !d3.allowed && d3.reason === 'degraded_concurrency_limit', 'degraded: per-instance concurrency limit (2) enforced');
    const d1again = await c.authorizeCall({ household: hh, callSid: 'CD1', signatureValid: true });
    check(d1again.allowed && c._state.degraded.admissions.length === 2, 'degraded: a retried CallSid is not counted twice');
    now.advance(700);   // first calls ended by their provider limit; outage now 700 s
    const d4 = await c.authorizeCall({ household: hh, callSid: 'CD4', signatureValid: true });
    check(!d4.allowed && d4.reason === 'authorization_unavailable_extended', 'after degradedMaxOutageSeconds without the authority: every call refused');
    const rej = createContainment({ db: okDb({ authorizeCall: async () => { throw new Error('ECONNREFUSED'); } }), env: { FC_DEGRADED_MODE: 'reject' } });
    const r1 = await rej.authorizeCall({ household: hh, callSid: 'CR1', signatureValid: true });
    check(!r1.allowed && r1.reason === 'authorization_unavailable', 'FC_DEGRADED_MODE=reject: DB down → refuse (zero exposure)');
    // hourly cap
    const now2 = clock();
    const c2 = createContainment({ db: okDb({ authorizeCall: async () => { throw new Error('down'); } }), now: now2, env: { FC_DEGRADED_MAX_CONCURRENT: '10', FC_DEGRADED_MAX_CALLS_PER_HOUR: '3', FC_DEGRADED_MAX_OUTAGE_SECONDS: '3600' } });
    const res = [];
    for (let i = 0; i < 5; i++) res.push(await c2.authorizeCall({ household: hh, callSid: `CH${i}`, signatureValid: true }));
    check(res.filter((r) => r.allowed).length === 3 && res[4].reason === 'degraded_hourly_limit', 'degraded: per-instance hourly limit enforced');
    // adoption when the DB returns
    const adopted = [];
    let up = false;
    const c3 = createContainment({ db: okDb({
      authorizeCall: async () => { if (!up) throw new Error('down'); return { allowed: true, timeLimitSeconds: 600, leaseExpiresAt: '2026-10-03T09:05:00Z' }; },
      adoptDegradedCall: async (p) => { adopted.push(p.callSid); return { ok: true }; },
    }) });
    await c3.authorizeCall({ household: hh, callSid: 'CJ1', signatureValid: true });
    up = true;
    await c3.settleCall({ callSid: 'CJ1', source: 'dial_action' });
    check(adopted.includes('CJ1') && c3._state.degraded.journal.size === 0, 'degraded admission adopted into the ledger before it is settled');
  }
  {
    // fail-closed one-shot spend and monitoring
    const c = createContainment({ db: okDb({ authorizeSpend: async () => { throw new Error('db down'); }, markMonitoringStarted: async () => { throw new Error('db down'); } }) });
    const s = await c.authorizeSpend({ category: 'sms', key: 'k1', householdId: hh.id });
    check(!s.allowed && s.reason === 'authorization_unavailable', 'SMS/AI/number-purchase authorisation unavailable → refused (fail closed)');
    check((await c.markMonitoringStarted('CA9')) === false, 'monitoring start unconfirmable → not authorised (stream stopped before paid transcription)');
  }

  // ---------------- leaseSweeper.js ----------------
  function fakeLedger(now) {
    const calls = new Map();   // sid -> { state, leaseExpiresAt(ms), terminateAt, renewOutcome }
    let dbDown = false;
    const api = {
      calls, setDown: (v) => { dbDown = v; },
      dueLeases: async () => { if (dbDown) throw new Error('db down'); return [...calls.entries()].filter(([, c]) => c.state !== 'settled' && !c.confirmed && c.leaseExpiresAt - now().getTime() <= 90000)
        .map(([sid, c]) => ({ callSid: sid, state: c.state, terminateAt: c.terminateAt ? new Date(c.terminateAt).toISOString() : null })); },
      renewLease: async ({ callSid }) => {
        const c = calls.get(callSid);
        if (c.renewOutcome === 'terminate') { c.state = 'terminating'; c.terminateAt = c.leaseExpiresAt; return { action: 'terminate', reason: 'household_budget_exhausted', terminateAt: new Date(c.leaseExpiresAt).toISOString() }; }
        c.leaseExpiresAt += 300000; c.renewals = (c.renewals || 0) + 1;
        return { action: 'renewed', leaseExpiresAt: new Date(c.leaseExpiresAt).toISOString() };
      },
      noteProviderCheck: async () => ({ ok: true }),
      recordTermination: async ({ callSid, confirmed }) => { if (confirmed) calls.get(callSid).confirmed = true; return { ok: true }; },
      settleCall: async ({ callSid, durationSeconds, source }) => { const c = calls.get(callSid); if (!c) return { ok: false, reason: 'unknown_call' }; if (c.state === 'settled') return { ok: true, alreadySettled: true }; c.state = 'settled'; c.settled = { durationSeconds, source }; return { ok: true }; },
      refreshEntitledCount: async () => ({ ok: true }),
      checkInvariants: async () => ({ ok: true }),
      adoptDegradedCall: async () => ({ ok: true }),
      markMonitoringStarted: async () => ({ ok: true }),
      authorizeSpend: async () => ({ allowed: true }),
      authorizeCall: async ({ callSid }) => { calls.set(callSid, { state: 'active', leaseExpiresAt: now().getTime() + 300000 }); return { allowed: true, timeLimitSeconds: 1200, leaseExpiresAt: new Date(now().getTime() + 300000).toISOString() }; },
    };
    return api;
  }
  function fakeProvider() {
    const live = new Map();     // sid -> { status, duration }
    const terminations = [];
    let failTerminate = false;
    return {
      live, terminations, setFailTerminate: (v) => { failTerminate = v; },
      fetchCall: async (sid) => { const c = live.get(sid); if (!c) return null; return { status: c.status, durationSeconds: c.duration ?? null, live: c.status === 'in-progress', ended: c.status === 'completed' }; },
      terminate: async (sid) => { terminations.push(sid); if (failTerminate) return { confirmed: false, error: 'provider 500' }; const c = live.get(sid); if (c) c.status = 'completed'; return { confirmed: true, providerStatus: 'completed' }; },
    };
  }
  {
    const now = clock();
    const L = fakeLedger(now);
    const P = fakeProvider();
    const events = [];
    const c = createContainment({ db: L, now });
    const sw = createLeaseSweeper({ containment: c, db: L, callControl: P, now, recordEvent: async (e) => events.push(e) });
    await c.authorizeCall({ household: hh, callSid: 'CS1', signatureValid: true });
    await c.authorizeCall({ household: hh, callSid: 'CS2', signatureValid: true });
    await c.authorizeCall({ household: hh, callSid: 'CS-forged', signatureValid: true });
    await c.authorizeCall({ household: hh, callSid: 'CS-lost', signatureValid: true });
    P.live.set('CS1', { status: 'in-progress' });
    P.live.set('CS2', { status: 'in-progress' });
    P.live.set('CS-lost', { status: 'completed', duration: 140 });
    now.advance(240);
    const s1 = await sw.sweepOnce();
    check(L.calls.get('CS1').renewals === 1 && L.calls.get('CS2').renewals === 1, 'sweeper renews live calls inside the renew-ahead window');
    check(L.calls.get('CS-forged').settled && L.calls.get('CS-forged').settled.durationSeconds === 0, 'provider has no such call → settled at 0 (forged / never connected)');
    check(L.calls.get('CS-lost').settled && L.calls.get('CS-lost').settled.durationSeconds === 140, 'lost Dial callback repaired from provider status (140 s)');
    L.calls.get('CS2').renewOutcome = 'terminate';
    now.advance(300);
    await sw.sweepOnce();
    check(L.calls.get('CS2').state === 'terminating' && !P.terminations.includes('CS2'), 'renewal refused: call marked, NOT cut before the end of its paid lease');
    now.advance(90);
    await sw.sweepOnce();
    check(P.terminations.includes('CS2') && L.calls.get('CS2').state === 'settled', 'at the end of the paid lease the sweeper ends the PARENT call via the provider and settles it');
    // termination failure → retried + alert
    await c.authorizeCall({ household: hh, callSid: 'CS3', signatureValid: true });
    P.live.set('CS3', { status: 'in-progress' });
    L.calls.get('CS3').renewOutcome = 'terminate';
    P.setFailTerminate(true);
    now.advance(300); await sw.sweepOnce(); now.advance(60); await sw.sweepOnce();
    check(events.some((e) => e.rule === 'provider_termination_failed') && L.calls.get('CS3').state === 'terminating', 'provider hang-up failure: alert raised, call stays queued for retry');
    P.setFailTerminate(false);
    now.advance(20); await sw.sweepOnce();
    check(L.calls.get('CS3').state === 'settled', 'next sweep retries the hang-up successfully');
    // reentrancy
    const slow = { ...L, dueLeases: async () => { await sleep(50); return []; } };
    const sw2 = createLeaseSweeper({ containment: c, db: slow, callControl: P, now });
    const [a, b] = await Promise.all([sw2.sweepOnce(), sw2.sweepOnce()]);
    check(a.skipped === 'already_running' || b.skipped === 'already_running', 'overlapping sweeps in one instance are prevented');
  }
  {
    // DB down mid-call → instance ends its own calls after lease + grace
    const now = clock();
    const L = fakeLedger(now);
    const P = fakeProvider();
    const events = [];
    const c = createContainment({ db: L, now, env: { FC_RENEWAL_UNAVAILABLE_GRACE_SECONDS: '60' } });
    const sw = createLeaseSweeper({ containment: c, db: L, callControl: P, now, recordEvent: async (e) => events.push(e) });
    await c.authorizeCall({ household: hh, callSid: 'CO1', signatureValid: true });
    P.live.set('CO1', { status: 'in-progress' });
    L.setDown(true);
    now.advance(330);
    let s = await sw.sweepOnce();
    check(s.dbUnavailable && !P.terminations.includes('CO1'), 'DB down: within lease + grace the call continues');
    now.advance(60);
    s = await sw.sweepOnce();
    check(P.terminations.includes('CO1') && events.some((e) => e.rule === 'calls_terminated_authority_unavailable'), 'DB down past lease + grace: the instance ends the call itself (fail closed) and raises an emergency');
    L.setDown(false);
    await sw.sweepOnce();
    check(L.calls.get('CO1').state === 'settled' && L.calls.get('CO1').settled.source === 'terminated_authority_unavailable', 'when the DB returns, the outage termination is settled in the ledger');
    const off = createContainment({ db: L, now, env: { FC_TERMINATE_ON_RENEWAL_UNAVAILABLE: 'false' } });
    const swOff = createLeaseSweeper({ containment: off, db: L, callControl: P, now });
    await off.authorizeCall({ household: hh, callSid: 'CO2', signatureValid: true });
    L.setDown(true); now.advance(1000);
    const before = P.terminations.length;
    await swOff.sweepOnce();
    check(P.terminations.length === before, 'FC_TERMINATE_ON_RENEWAL_UNAVAILABLE=false disables local termination (provider backstop still applies)');
  }

  // ---------------- twilioCallControl.js ----------------
  {
    const updates = [];
    const client = { calls: (sid) => ({
      fetch: async () => { if (sid === 'missing') { const e = new Error('nf'); e.status = 404; throw e; } return { status: 'completed', duration: '75' }; },
      update: async (p) => { updates.push([sid, p]); if (sid === 'over') { const e = new Error('not in progress'); e.code = 21220; throw e; } if (sid === 'boom') throw new Error('500'); return { status: 'completed' }; },
    }) };
    const cc = createTwilioCallControl({ client });
    check((await cc.fetchCall('missing')) === null && (await cc.fetchCall('x')).durationSeconds === 75, 'provider fetch: 404 → null; duration parsed');
    check((await cc.terminate('x')).confirmed && updates[0][1].status === 'completed', 'terminate = REST update status=completed on the parent call');
    check((await cc.terminate('over')).confirmed && (await cc.terminate('missing')).confirmed, 'already-ended / unknown call counts as terminated');
    check((await cc.terminate('boom')).confirmed === false, 'provider error → not confirmed (retried)');
    const ann = createTwilioCallControl({ client, mode: 'announce', announcement: 'Bye <now>' });
    await ann.terminate('y');
    check(/<Say[^>]*>Bye &lt;now&gt;<\/Say><Hangup\/>/.test(updates.at(-1)[1].twiml), 'announce mode: escaped message then hang-up');
  }

  // ---------------- smsBudget.js with containment ----------------
  {
    const sent = [];
    const client = { messages: { create: async (p) => { sent.push(p); return { sid: 'SM1' }; } } };
    let decision = { allowed: true };
    const authorizations = [];
    const fakeContainment = { authorizeSpend: async (p) => { authorizations.push(p); return decision; }, smsKey: () => 'k' };
    const b = createSmsBudget({ client, claimSmsSend: async () => ({ allowed: true }), containment: fakeContainment });
    await b.forHousehold(hh.id, () => null).messages.create({ to: '+447700900000', body: 'x' });
    check(sent.length === 1 && authorizations.length === 1, 'SMS with NO known period (limit notice / post-hang-up path) now needs containment authorisation');
    await b.forHousehold(null, () => null).messages.create({ to: '+447700900000', body: 'x' });
    check(authorizations.length === 2 && authorizations[1].householdId === null, 'SMS from a stream with no household is authorised globally (was unmetered)');
    decision = { allowed: false, reason: 'authorization_unavailable' };
    let threw = false;
    try { await b.forHousehold(hh.id, () => null).messages.create({ to: '+447700900000', body: 'y' }); } catch { threw = true; }
    check(threw && sent.length === 2, 'containment refusal / DB down → SMS NOT sent (fail closed)');
    decision = { allowed: true, existing: true };
    threw = false;
    try { await b.forHousehold(hh.id, () => null).messages.create({ to: '+447700900000', body: 'x' }); } catch { threw = true; }
    check(threw && sent.length === 2, 'a retried identical SMS (same key) is not sent twice');
    const realKey = createContainment({ db: okDb() }).smsKey;
    check(realKey({ householdId: 'a', to: '1', body: 'b', at: new Date(0) }) === realKey({ householdId: 'a', to: '1', body: 'b', at: new Date(30000) })
      && realKey({ householdId: 'a', to: '1', body: 'b', at: new Date(0) }) !== realKey({ householdId: 'a', to: '1', body: 'c', at: new Date(0) }), 'SMS idempotency key: same message within a minute = same key');
  }

  // ---------------- number purchase gate ----------------
  {
    const { ensureTwilioNumberProvisioned } = require('../services/twilioProvisioning');
    const bought = [];
    const client = { availablePhoneNumbers: () => ({ local: { list: async () => [{ phoneNumber: '+441000000000' }] } }),
      incomingPhoneNumbers: Object.assign(() => ({ remove: async () => {} }), { create: async (p) => { bought.push(p); return { phoneNumber: p.phoneNumber, sid: 'PN1' }; } }) };
    let failuresRecorded = 0;
    const base = { client, assign: async () => true, recordFailure: async () => { failuresRecorded++; }, sendAlert: async () => {}, appUrl: 'https://x' };
    const refused = await ensureTwilioNumberProvisioned({ id: hh.id, twilio_number: null, twilio_provisioning_attempts: 0 },
      { ...base, authorizeNumberPurchase: async () => ({ allowed: false, reason: 'global_number_purchase_cap' }) });
    check(!refused.success && refused.containmentRefused && bought.length === 0 && failuresRecorded === 0,
      'number purchase refused by containment: nothing bought, and the household\'s limited attempts are NOT burned');
    const thrown = await ensureTwilioNumberProvisioned({ id: hh.id, twilio_number: null, twilio_provisioning_attempts: 0 },
      { ...base, authorizeNumberPurchase: async () => { throw new Error('db down'); } });
    check(!thrown.success && bought.length === 0, 'containment unavailable → no purchase (fail closed)');
    const ok = await ensureTwilioNumberProvisioned({ id: hh.id, twilio_number: null, twilio_provisioning_attempts: 0 },
      { ...base, authorizeNumberPurchase: async () => ({ allowed: true }) });
    check(ok.success && bought.length === 1, 'authorised purchase proceeds');
    const src = readFileSync(path.join(__dirname, '..', 'services', 'twilioProvisioning.js'), 'utf8');
    check(/client && client === twilioRestClient \? require\("\.\/containment"\)\.authorizeNumberPurchase/.test(src), 'the REAL Twilio client is always gated by default (only injected fakes skip it)');
  }

  // ---------------- readModel.js (customer contract) ----------------
  {
    const mk = (status) => createContainmentReadModel({ db: { householdStatus: async () => status } });
    const base = { hasAccount: true, budgetGbp: 0.5, adjustmentsGbp: 0, profile: 'standard' };
    check((await mk({ ...base, remainingBudgetGbp: 0.4, remainingWithReserveGbp: 0.65 }).getCustomerAllowanceView(hh)).state === 'ok', 'customer view: ok');
    check((await mk({ ...base, remainingBudgetGbp: 0.1, remainingWithReserveGbp: 0.35 }).getCustomerAllowanceView(hh)).state === 'low', 'customer view: low (<25%)');
    const rs = await mk({ ...base, remainingBudgetGbp: -0.01, remainingWithReserveGbp: 0.2 }).getCustomerAllowanceView(hh);
    check(rs.state === 'reserve' && rs.monitoringAvailable === false && rs.callsDelivered === true, 'customer view: reserve — calls delivered unmonitored');
    const ex = await mk({ ...base, remainingBudgetGbp: -0.3, remainingWithReserveGbp: -0.05 }).getCustomerAllowanceView(hh);
    check(ex.state === 'exhausted' && ex.callsDelivered === false, 'customer view: exhausted — calls not connected');
    const un = await createContainmentReadModel({ db: { householdStatus: async () => { throw new Error('x'); } } }).getCustomerAllowanceView(hh);
    check(un.state === 'unavailable' && un.monitoringAvailable === null, 'customer view: read failure → "unavailable", never "protected"');
    check(!('budgetGbp' in ex) && !('remainingBudgetGbp' in ex), 'customer view exposes no HCG cost figures');
    const rmSrc = readFileSync(path.join(__dirname, '..', 'services', 'containment', 'readModel.js'), 'utf8');
    check(!/adminAdjust|authorize|settle|setPolicy|setKillSwitch/.test(rmSrc.replace(/\/\/.*$/gm, '')), 'read model module has no write path at all');
  }

  if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('\nAll financial-containment service checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
