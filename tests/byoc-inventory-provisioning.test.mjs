// WS6 Magrathea → Twilio BYOC (2026-10-11): NUMBER_PROVIDER=magrathea
// provisioning assigns a DDI from the manual inventory (migration 078)
// instead of buying a Twilio number — with the same fail-closed gates
// (abuse guard, entitlement provenance, Fortress authorizeNumberPurchase) —
// and a quarantine release returns the DDI to the inventory instead of
// calling Twilio. Default (unset / 'twilio') is unchanged.
//
// Run: node tests/byoc-inventory-provisioning.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ensureTwilioNumberProvisioned, releaseQuarantinedTwilioNumber } = require('../services/twilioProvisioning.js');
const { resolveNumberProvider, inventoryCoolingOffDays } = require('../services/telephony/numberProviders/config.js');
const { isPermittedInventoryNumber } = require('../services/telephony/numberProviders/inventory.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const DDI = '+443300884327';
const HH = { id: 'hh-1', twilio_number: null, twilio_provisioning_attempts: 0 };
const ENV = { NUMBER_PROVIDER: 'magrathea', NODE_ENV: 'test' };

// A Twilio client that FAILS the test if touched.
const touched = [];
const forbiddenTwilio = new Proxy({}, { get(_, k) { touched.push(String(k)); return () => { throw new Error(`Twilio touched: ${String(k)}`); }; } });

function harness({ pool = [DDI], assignImpl, claimImpl, authorize = async () => ({ allowed: true }), entitlements = async () => [{ source: 'stripe', status: 'active' }], guard = null } = {}) {
  const state = { claims: 0, returned: [], assigned: new Map(), failures: [], alerts: [], authorizations: 0, pool: [...pool], claimedBy: new Map() };
  const deps = {
    env: ENV,
    client: forbiddenTwilio,
    abuseGuard: guard,
    inventory: {
      claim: claimImpl || (async (householdId, provider) => {
        state.claims++;
        if (provider !== 'magrathea') throw new Error('wrong provider');
        for (const [n, h] of state.claimedBy) if (h === householdId) return n; // idempotent
        const n = state.pool.shift() || null;
        if (n) state.claimedBy.set(n, householdId);
        return n;
      }),
      giveBack: async (n, householdId) => { state.returned.push([n, householdId]); state.claimedBy.delete(n); state.pool.unshift(n); return true; },
    },
    assign: assignImpl || (async (householdId, n) => { if (state.assigned.has(householdId)) return false; state.assigned.set(householdId, n); return true; }),
    readHouseholdNumber: async (householdId) => state.assigned.get(householdId) || null,
    recordFailure: async (householdId, msg) => { state.failures.push(msg); },
    sendAlert: async (type) => { state.alerts.push(type); },
    readActiveEntitlements: entitlements,
    authorizeNumberPurchase: async (args) => { state.authorizations++; return authorize(args); },
  };
  return { state, deps };
}

// ── config ───────────────────────────────────────────────────────────────
check(resolveNumberProvider({}).provider === 'twilio' && !resolveNumberProvider({}).inventory, 'default provider is twilio (purchase path unchanged)');
check(resolveNumberProvider({ NUMBER_PROVIDER: ' Magrathea ' }).inventory === true, "'magrathea' (case/space-insensitive) selects the inventory");
check(resolveNumberProvider({ NUMBER_PROVIDER: 'telnyx' }).valid === false, 'unknown provider is invalid');
check(inventoryCoolingOffDays({}) === 30 && inventoryCoolingOffDays({ NUMBER_INVENTORY_COOLING_OFF_DAYS: '7' }) === 7 && inventoryCoolingOffDays({ NUMBER_INVENTORY_COOLING_OFF_DAYS: '-1' }) === 30, 'cooling-off days default 30, bounded');
check(isPermittedInventoryNumber(DDI) && isPermittedInventoryNumber('+441615550201') && isPermittedInventoryNumber('+442079460123'), 'inventory accepts UK 01/02/03 E.164');
for (const bad of ['+447700900123', '+449090000000', '+448001234567', '+447624123456', '03300884327', '+13300884327', '+4407700900123']) {
  check(!isPermittedInventoryNumber(bad), `inventory refuses ${bad}`);
}

// ── happy path ───────────────────────────────────────────────────────────
{
  const { state, deps } = harness();
  const r = await ensureTwilioNumberProvisioned({ ...HH }, deps);
  check(r.success === true && r.twilioNumber === DDI && r.provider === 'magrathea', 'magrathea: DDI claimed from inventory and assigned');
  check(state.assigned.get('hh-1') === DDI, 'households.twilio_number set to the DDI (provider-neutral column)');
  check(state.authorizations === 1, 'Fortress authorizeNumberPurchase ran once (same semantics as a purchase)');
  check(touched.length === 0, 'Twilio client never touched (no purchase, no search)');
}

// ── unknown provider holds (never falls back to buying) ──────────────────
{
  const { state, deps } = harness();
  const r = await ensureTwilioNumberProvisioned({ ...HH }, { ...deps, env: { NUMBER_PROVIDER: 'telnyx', NODE_ENV: 'test' } });
  check(r.attempted === false && r.held === true && r.reason === 'unknown_number_provider', 'unknown NUMBER_PROVIDER → held');
  check(state.claims === 0 && touched.length === 0 && state.failures.length === 0, 'held: no claim, no Twilio call, no failure recorded');
}

// ── production without the abuse guard still refuses ─────────────────────
{
  const { state, deps } = harness();
  const r = await ensureTwilioNumberProvisioned({ ...HH }, { ...deps, abuseGuard: null, env: { ...ENV, NODE_ENV: 'production' } });
  check(r.held === true && r.reason === 'abuse_guard_not_configured' && state.claims === 0, 'production with no abuse guard → refused before any claim (unchanged rule)');
}

// ── abuse guard: single-flight, admit, velocity accounting ───────────────
{
  let admits = 0; let noted = 0;
  const guard = {
    singleFlight: (id, fn) => fn(),
    admit: async () => { admits++; return admits === 1 ? { allowed: false, reason: 'account_risk_hold' } : { allowed: true }; },
    noteSuccessfulPurchase: () => { noted++; },
  };
  const { state, deps } = harness({ guard });
  const held = await ensureTwilioNumberProvisioned({ ...HH }, deps);
  check(held.held === true && held.reason === 'account_risk_hold' && state.claims === 0, 'abuse guard hold → no claim');
  const ok = await ensureTwilioNumberProvisioned({ ...HH }, deps);
  check(ok.success === true && noted === 1, 'admitted assignment counts toward the global provisioning velocity ceilings');
}

// ── provenance & Fortress refusals (fail closed, attempts not burned) ────
{
  const { state, deps } = harness({ entitlements: async () => { throw new Error('db down'); } });
  const r = await ensureTwilioNumberProvisioned({ ...HH }, deps);
  check(r.success === false && r.provenanceRefused === true && state.claims === 0 && state.failures.length === 0, 'unreadable entitlement provenance → refused, no claim, attempt not burned');
}
{
  const { state, deps } = harness({ entitlements: async () => [{ source: 'apple_revenuecat', status: 'active', entitlement_type: 'paid_subscription', revenuecat_environment: 'sandbox' }] });
  const r = await ensureTwilioNumberProvisioned({ ...HH }, deps);
  check(r.success === false && r.provenanceRefused === true && state.claims === 0, 'sandbox store entitlement → no number assigned');
}
{
  const { state, deps } = harness({ authorize: async () => ({ allowed: false, reason: 'daily_purchase_cap' }) });
  const r = await ensureTwilioNumberProvisioned({ ...HH }, deps);
  check(r.success === false && r.containmentRefused === true && state.claims === 0 && state.failures.length === 0, 'Fortress refusal → no claim, attempt not burned');
}
{
  const { state, deps } = harness({ authorize: async () => { throw new Error('ledger unreachable'); } });
  const r = await ensureTwilioNumberProvisioned({ ...HH }, deps);
  check(r.success === false && r.containmentRefused === true && state.claims === 0, 'Fortress unavailable → refused (fail closed)');
}

// ── inventory exhausted / unreadable ─────────────────────────────────────
{
  const { state, deps } = harness({ pool: [] });
  const r = await ensureTwilioNumberProvisioned({ ...HH }, deps);
  check(r.success === false && /exhausted/.test(r.error) && state.alerts.includes('number_inventory_exhausted') && state.failures.length === 1, 'empty inventory → failure recorded + critical alert, nothing bought');
  check(touched.length === 0, 'empty inventory never falls back to a Twilio purchase');
}
{
  const { state, deps } = harness({ claimImpl: async () => { throw new Error('claim_inventory_number unavailable: relation does not exist'); } });
  const r = await ensureTwilioNumberProvisioned({ ...HH }, deps);
  check(r.success === false && state.alerts.includes('number_inventory_unavailable') && state.failures.length === 1, 'inventory unreadable (078 not applied) → failure + alert, no purchase');
}

// ── policy re-check ──────────────────────────────────────────────────────
{
  const { state, deps } = harness({ pool: ['+447700900123'] });
  const r = await ensureTwilioNumberProvisioned({ ...HH }, deps);
  check(r.success === false && state.returned.length === 1 && !state.assigned.has('hh-1') && state.alerts.includes('number_inventory_policy_violation'), 'a non-01/02/03 inventory row is returned, never assigned');
}

// ── assignment outcomes ──────────────────────────────────────────────────
{
  const { state, deps } = harness();
  state.assigned.set('hh-1', '+441615550999'); // already provisioned between read and write
  const r = await ensureTwilioNumberProvisioned({ ...HH }, deps);
  check(r.success === false && /race/.test(r.error) && state.returned.length === 1 && state.returned[0][0] === DDI, 'race (household already holds a number) → claim returned to the pool');
}
{
  let call = 0;
  const { state, deps } = harness({ assignImpl: async (h, n) => { call++; state.assigned.set(h, n); throw new Error('timeout'); } });
  const r = await ensureTwilioNumberProvisioned({ ...HH }, deps);
  check(r.success === true && r.assignErrorRecovered === true && state.returned.length === 0 && call === 1, 'assign threw but committed → success, DDI kept');
}
{
  const { state, deps } = harness({ assignImpl: async () => { throw new Error('constraint'); } });
  const r = await ensureTwilioNumberProvisioned({ ...HH }, deps);
  check(r.success === false && state.returned.length === 1, 'assign failed and household confirmably has no number → DDI returned');
}
{
  const { state, deps } = harness({ assignImpl: async () => { throw new Error('timeout'); } });
  deps.readHouseholdNumber = async () => { throw new Error('db down'); };
  const r = await ensureTwilioNumberProvisioned({ ...HH }, deps);
  check(r.success === false && state.returned.length === 0 && state.alerts.includes('number_inventory_assign_unknown'), 'assignment outcome unknown → DDI kept claimed (never re-issued) + alert');
}
{
  const { deps } = harness();
  const r = await ensureTwilioNumberProvisioned({ ...HH, twilio_number: DDI }, deps);
  check(r.attempted === false, 'household that already has a number is not provisioned again');
}

// ── default provider: Twilio purchase path still used ────────────────────
{
  let listed = 0;
  const fakeTwilio = {
    availablePhoneNumbers: () => ({ local: { list: async () => { listed++; return [{ phoneNumber: '+441615550201' }]; } } }),
    incomingPhoneNumbers: Object.assign(() => ({ remove: async () => {} }), { list: async () => [], create: async (p) => ({ sid: 'PN1', phoneNumber: p.phoneNumber }) }),
  };
  const { state, deps } = harness();
  const r = await ensureTwilioNumberProvisioned({ ...HH }, { ...deps, env: { NODE_ENV: 'test' }, client: fakeTwilio, readActiveEntitlements: null, authorizeNumberPurchase: null });
  check(r.success === true && r.twilioNumber === '+441615550201' && listed === 1 && state.claims === 0, 'NUMBER_PROVIDER unset → Twilio purchase path, inventory untouched');
}

// ── quarantine release: inventory DDI never goes to Twilio ───────────────
{
  const row = { id: 'q1', household_id: 'hh-1', twilio_number: DDI, deactivation_confirmed: true, released_at: null };
  const calls = { returned: [], marked: [], twilio: 0 };
  const client = { incomingPhoneNumbers: Object.assign(() => ({ remove: async () => { calls.twilio++; } }), { list: async () => { calls.twilio++; return []; } }) };
  const base = {
    client,
    markReleased: async (id) => { calls.marked.push(id); },
    blocksRelease: async () => false,
    guardEnv: { NUMBER_INVENTORY_COOLING_OFF_DAYS: '14' },
    returnToInventory: async (n, days) => { calls.returned.push([n, days]); return true; },
  };
  const r = await releaseQuarantinedTwilioNumber(row, { ...base, inventoryProviderFor: async (n) => (n === DDI ? 'magrathea' : null) });
  check(r.released === true && r.returnedToInventory === true && calls.twilio === 0, 'inventory DDI: released back to the inventory, Twilio never called');
  check(calls.returned.length === 1 && calls.returned[0][1] === 14 && calls.marked[0] === 'q1', 'returned with the configured cooling-off, quarantine row marked released');

  calls.returned.length = 0; calls.marked.length = 0;
  const r2 = await releaseQuarantinedTwilioNumber(row, { ...base, inventoryProviderFor: async () => { throw new Error('db down'); } });
  check(r2.released === false && calls.twilio === 0 && calls.marked.length === 0, 'inventory unreadable → release refused, nothing called, nothing marked');

  const r3 = await releaseQuarantinedTwilioNumber(row, { ...base, inventoryProviderFor: async () => 'magrathea', returnToInventory: async () => false });
  check(r3.released === false && calls.marked.length === 0, 'inventory refuses the return (number still held) → not marked released');

  const twRow = { ...row, id: 'q2', twilio_number: '+441615550201', twilio_sid: 'PN9' };
  const r4 = await releaseQuarantinedTwilioNumber(twRow, { ...base, inventoryProviderFor: async () => null });
  check(r4.released === true && calls.twilio === 1, 'a Twilio-hosted number still goes through the Twilio release (unchanged)');

  const r5 = await releaseQuarantinedTwilioNumber({ ...twRow, id: 'q3' }, { ...base });
  check(r5.released === true, 'tests/fake clients without an inventory lookup keep the old behaviour');
}

console.log(failures === 0 ? '\nAll BYOC inventory provisioning checks passed.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
