// Adversarial financial-containment CONTRACT tests.
//
// These tests are written against an adapter interface, not against any
// one branch's code, so they can be pointed at the Financial Fortress /
// Customer Allowance implementation when integration is authorised —
// without this branch depending on (or cherry-picking) unfinished work.
//
// Adapter interface (all methods async; units: seconds of monitored
// allowance, integer pence of cost):
//
//   createSubject() -> {
//     capabilities: Set<string>   // subset of CAPABILITIES below
//     setAllowance(householdId, seconds)
//     remaining(householdId) -> number
//     authorizeCall({ householdId, callSid }) -> { admitted: boolean, grantedSeconds: number, reason?: string }
//     recordUsage({ householdId, callSid, eventId, seconds, costPence }) -> { applied: boolean }
//          (may also throw for invalid input — treated the same as applied:false)
//     setGlobalCeiling(pence); addGlobalSpend(pence)       // capability 'global-ceiling'
//     setStoreAvailable(boolean)                           // capability 'store-outage'
//     setRateLimit({ maxAdmissions, windowMs })            // capability 'rate-breaker'
//   }
//
// A capability the adapter does not declare makes the dependent check
// UNPROVEN — never silently passing.

export const CAPABILITIES = ['global-ceiling', 'store-outage', 'rate-breaker'];

const BAD_COSTS = [NaN, -1, -0.5, Infinity, -Infinity, 1e308, Number.MAX_SAFE_INTEGER + 2, '12abc', null, undefined, {}, '1e9'];
const BAD_SECONDS = [NaN, -30, Infinity, 1e308, '60; drop table', null];

async function attempt(fn) {
  try {
    const r = await fn();
    return r && r.applied === true;
  } catch {
    return false;
  }
}

/**
 * Runs every contract check. Returns [{ id, scenarios, status, detail }]
 * with status PASS | FAIL | UNPROVEN. `PASS` here means the contract held
 * against this adapter; whether that promotes a launch-gate item to
 * PROVEN depends on the adapter being bound to the real implementation
 * and its real store (see docs/launch-gate/ADVERSARIAL_TEST_SPEC.md).
 */
export async function runFinancialContract(adapterFactory) {
  const results = [];
  const add = (id, scenarios, ok, detail) =>
    results.push({ id, scenarios, status: ok === null ? 'UNPROVEN' : ok ? 'PASS' : 'FAIL', detail });

  // FC-1 — zero allowance is never admitted (S7 pre-call half, S26).
  {
    const s = await adapterFactory();
    await s.setAllowance('h1', 0);
    const r = await s.authorizeCall({ householdId: 'h1', callSid: 'CA-zero' });
    add('FC-1', ['S7', 'S26'], !r.admitted && !(r.grantedSeconds > 0), `admitted=${r.admitted} granted=${r.grantedSeconds}`);
  }

  // FC-2 — 10 simultaneous calls with almost no allowance (S6, S27):
  // total granted seconds may never exceed what remained.
  {
    const s = await adapterFactory();
    await s.setAllowance('h2', 45);
    const rs = await Promise.all(
      Array.from({ length: 10 }, (_, i) => s.authorizeCall({ householdId: 'h2', callSid: `CA-c${i}` }))
    );
    const granted = rs.filter(r => r.admitted).reduce((a, r) => a + (Number(r.grantedSeconds) || 0), 0);
    const admitted = rs.filter(r => r.admitted).length;
    add('FC-2', ['S6', 'S27'], granted <= 45, `admitted=${admitted} totalGranted=${granted}s against 45s remaining`);
  }

  // FC-3 — duplicate usage event / duplicate webhook is applied once (S11, S12, S23).
  {
    const s = await adapterFactory();
    await s.setAllowance('h3', 600);
    const ev = { householdId: 'h3', callSid: 'CA-dup', eventId: 'evt-1', seconds: 60, costPence: 5 };
    const applied = [];
    applied.push(await attempt(() => s.recordUsage(ev)));
    applied.push(await attempt(() => s.recordUsage({ ...ev })));
    applied.push(...(await Promise.all([1, 2, 3].map(() => attempt(() => s.recordUsage({ ...ev }))))));
    const rem = await s.remaining('h3');
    add('FC-3', ['S11', 'S12', 'S23'], applied.filter(Boolean).length === 1 && rem === 540,
      `applied ${applied.filter(Boolean).length}× of 5 deliveries; remaining=${rem} (expected 540)`);
  }

  // FC-4 — malformed / overflow cost and duration input is rejected and
  // can never create credit or corrupt the balance (S28, S21).
  {
    const s = await adapterFactory();
    await s.setAllowance('h4', 600);
    let accepted = [];
    let i = 0;
    for (const c of BAD_COSTS) {
      if (await attempt(() => s.recordUsage({ householdId: 'h4', callSid: 'CA-bad', eventId: `bad-c-${i++}`, seconds: 10, costPence: c }))) accepted.push(`cost=${String(c)}`);
    }
    for (const sec of BAD_SECONDS) {
      if (await attempt(() => s.recordUsage({ householdId: 'h4', callSid: 'CA-bad', eventId: `bad-s-${i++}`, seconds: sec, costPence: 1 }))) accepted.push(`seconds=${String(sec)}`);
    }
    const rem = await s.remaining('h4');
    const sane = Number.isFinite(rem) && rem <= 600 && rem >= 0;
    add('FC-4', ['S28', 'S21'], accepted.length === 0 && sane,
      `accepted malformed inputs: [${accepted.join(', ')}]; remaining=${rem}`);
  }

  // FC-5 — recording usage can never increase the allowance (S21).
  {
    const s = await adapterFactory();
    await s.setAllowance('h5', 100);
    await attempt(() => s.recordUsage({ householdId: 'h5', callSid: 'CA-n', eventId: 'n1', seconds: -100, costPence: -10 }));
    const rem = await s.remaining('h5');
    add('FC-5', ['S21'], rem <= 100, `remaining after negative usage = ${rem} (must be <= 100)`);
  }

  // FC-6 — authorisation store unavailable ⇒ fail closed (S16, S17).
  {
    const s = await adapterFactory();
    if (!s.capabilities?.has('store-outage')) add('FC-6', ['S16', 'S17'], null, 'adapter does not expose store-outage simulation');
    else {
      await s.setAllowance('h6', 600);
      await s.setStoreAvailable(false);
      let r;
      try { r = await s.authorizeCall({ householdId: 'h6', callSid: 'CA-out' }); } catch { r = { admitted: false, grantedSeconds: 0 }; }
      add('FC-6', ['S16', 'S17'], !r.admitted, `admitted while store unavailable = ${r.admitted}`);
    }
  }

  // FC-7 — global spend ceiling reached ⇒ no new admissions (S18).
  {
    const s = await adapterFactory();
    if (!s.capabilities?.has('global-ceiling')) add('FC-7', ['S18'], null, 'adapter does not expose a global ceiling');
    else {
      await s.setAllowance('h7', 6000);
      await s.setGlobalCeiling(10000);
      await s.addGlobalSpend(10000);
      const r = await s.authorizeCall({ householdId: 'h7', callSid: 'CA-g' });
      add('FC-7', ['S18'], !r.admitted, `admitted at ceiling = ${r.admitted}`);
    }
  }

  // FC-8 — rate-of-spend breaker trips on a burst (S19, S20).
  {
    const s = await adapterFactory();
    if (!s.capabilities?.has('rate-breaker')) add('FC-8', ['S19', 'S20'], null, 'adapter does not expose a rate breaker');
    else {
      await s.setRateLimit({ maxAdmissions: 5, windowMs: 60_000 });
      for (let h = 0; h < 50; h++) await s.setAllowance(`r${h}`, 6000);
      const rs = await Promise.all(Array.from({ length: 50 }, (_, h) => s.authorizeCall({ householdId: `r${h}`, callSid: `CA-r${h}` })));
      const n = rs.filter(r => r.admitted).length;
      add('FC-8', ['S19', 'S20'], n <= 5, `admitted ${n} of 50 burst calls (limit 5/window)`);
    }
  }

  return results;
}
