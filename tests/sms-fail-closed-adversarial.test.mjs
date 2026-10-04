// SMS spend is fail-closed (soft-launch integration 2026-10-04; provider
// containment final T7; Andrew's rule: absence, failure or uncertainty of the
// applicable financial authority must never result in HCG spending money).
// Every case below must end with ZERO messages handed to the provider client.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSmsBudget } = require('../services/usage/smsBudget');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const period = () => ({ periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-11-01T00:00:00Z' });
const noPeriod = () => null;
const env = { SAFETY_BUDGET_CHECK_TIMEOUT_MS: '50' };

function harness({ containment = null, claimSmsSend, getPeriod = period, householdId = 'hh-1' }) {
  const sent = []; const audits = [];
  const client = { messages: { create: async (p) => { sent.push(p); return { sid: 'SM1' }; } } };
  const sms = createSmsBudget({ client, claimSmsSend, containment, env, recordIntervention: async (e) => audits.push(e) }).forHousehold(householdId, getPeriod);
  return { sms, sent, audits };
}
async function attempt(h) { try { await h.sms.messages.create({ to: '+447700900001', body: 'warning' }); return null; } catch (e) { return e.message; } }
const okContainment = (over = {}) => ({ smsKey: () => 'k', authorizeSpend: async () => ({ allowed: true, ...over }) });
const allowClaim = async () => ({ allowed: true });

const cases = [
  ['056 claim throws', { claimSmsSend: async () => { throw new Error('db down'); } }, 'sms_budget_unavailable'],
  ['056 claim hangs past the timeout', { claimSmsSend: () => new Promise(() => {}) }, 'sms_budget_unavailable'],
  ['056 claim returns null', { claimSmsSend: async () => null }, 'sms_budget_unavailable'],
  ['056 claim returns {} (no explicit allowed)', { claimSmsSend: async () => ({}) }, 'sms_budget_unavailable'],
  ['056 claim returns allowed:"yes" (not boolean)', { claimSmsSend: async () => ({ allowed: 'yes' }) }, 'sms_budget_unavailable'],
  ['056 claim not configured', { claimSmsSend: undefined }, 'sms_budget_unavailable'],
  ['056 claim denies', { claimSmsSend: async () => ({ allowed: false, reason: 'household_daily_sms_limit' }) }, 'household_daily_sms_limit'],
  ['Fortress authorizeSpend throws', { containment: { smsKey: () => 'k', authorizeSpend: async () => { throw new Error('rpc'); } }, claimSmsSend: allowClaim }, 'authorization_unavailable'],
  ['Fortress returns undefined', { containment: { smsKey: () => 'k', authorizeSpend: async () => undefined }, claimSmsSend: allowClaim }, 'authorization_malformed'],
  ['Fortress returns allowed:1 (not true)', { containment: okContainment({ allowed: 1, reason: 'odd' }), claimSmsSend: allowClaim }, 'odd'],
  ['Fortress refuses (breaker open)', { containment: okContainment({ allowed: false, reason: 'breaker_open' }), claimSmsSend: allowClaim }, 'breaker_open'],
  ['Fortress unavailable (its own fail-closed result)', { containment: okContainment({ allowed: false, reason: 'authorization_unavailable' }), claimSmsSend: allowClaim }, 'authorization_unavailable'],
  ['Fortress allows but 056 claim throws', { containment: okContainment(), claimSmsSend: async () => { throw new Error('db'); } }, 'sms_budget_unavailable'],
  ['no Fortress and no period (no authority at all)', { claimSmsSend: allowClaim, getPeriod: noPeriod }, 'no_financial_authority'],
  ['no Fortress and no household', { claimSmsSend: allowClaim, householdId: null }, 'no_financial_authority'],
  ['duplicate (Fortress idempotency: existing)', { containment: okContainment({ existing: true }), claimSmsSend: allowClaim }, 'duplicate'],
];
for (const [name, opts, expected] of cases) {
  const h = harness(opts);
  const err = await attempt(h);
  check(h.sent.length === 0 && typeof err === 'string' && err.includes(expected), `${name} → NOT sent (${err})`);
  if (expected !== 'duplicate') check(h.audits.length >= 1, `${name} → refusal audited`);
}

// Positive controls: explicit permission still sends exactly once.
{
  const h = harness({ claimSmsSend: allowClaim });
  check((await attempt(h)) === null && h.sent.length === 1, '056 claim explicitly allows (no Fortress) → sent once');
  const f = harness({ containment: okContainment(), claimSmsSend: allowClaim });
  check((await attempt(f)) === null && f.sent.length === 1, 'Fortress + 056 explicitly allow → sent once');
  const fp = harness({ containment: okContainment(), claimSmsSend: allowClaim, getPeriod: noPeriod });
  check((await attempt(fp)) === null && fp.sent.length === 1, 'Fortress explicitly allows, no 056 period → sent once (Fortress is the applicable authority)');
}

console.log(failures === 0 ? '\nSMS fail-closed: all adversarial cases hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
