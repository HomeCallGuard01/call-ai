// Launch Fortress — commercial configuration validation, admin visibility and
// honest customer state (integration 2026-10-03, §9 §10 §15 §16).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { validateCommercialConfiguration } = require('../services/finance/commercialConfigValidation.js');
const { getFortressOverview, maskEmail, STATEMENT } = require('../services/businessControl/fortressOverview.js');
const { fromFortressHouseholdStatus } = require('../services/allowance/fortressAdapter.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const SEED = [
  { profile: 'standard', period_budget_gbp: 0.5, delivery_reserve_gbp: 0.25, essential_reserve_gbp: 0.1 },
  { profile: 'plus', period_budget_gbp: 0.5, delivery_reserve_gbp: 0.25, essential_reserve_gbp: 0.1 },
];

// ── §9/§10: the validator reports, decides nothing ─────────────────────
{
  const r = validateCommercialConfiguration({ env: {}, profiles: SEED });
  check(r.envelope && r.envelope.variableEnvelopeGbp > 0, `£5.99 at a 40% margin → a variable envelope of £${r.envelope && r.envelope.variableEnvelopeGbp} per customer per period (derived, not hard-coded)`);
  check(r.ok && r.profiles.every((p) => p.ok), 'the seeded placeholder profiles fit the envelope');
  check(r.warnings.some((w) => w.code === 'minutes_promise_exceeds_budget'), 'the 100-minute placeholder is flagged: the £ budget cannot fund it (the D1 inconsistency is reported, not hidden)');
  check(r.decisionsRequired.length >= 5 && r.decisionsRequired.some((d) => /D1/.test(d)), 'the commercial decisions still owed by Andrew are listed');
}
{
  const generous = [{ profile: 'standard', period_budget_gbp: 3, delivery_reserve_gbp: 1, essential_reserve_gbp: 0.1 }, SEED[1]];
  const r = validateCommercialConfiguration({ env: {}, profiles: generous });
  check(!r.ok && r.errors.some((e) => e.code === 'profile_exceeds_envelope' && /standard/.test(e.detail)), 'a profile granting more £ than the margin model allows is an ERROR (impossible economics cannot pass silently)');
}
{
  const r = validateCommercialConfiguration({ env: { HCG_ECONOMICS_PRICE_INC_VAT_GBP: '4.99' }, profiles: SEED });
  check(r.envelope.variableEnvelopeGbp < validateCommercialConfiguration({ env: {}, profiles: SEED }).envelope.variableEnvelopeGbp, 'the envelope follows the configured price (no price is hard-coded into enforcement)');
}
{
  const env = { ALLOWANCE_TOPUPS_ENABLED: 'true', ALLOWANCE_TOPUP_PRODUCTS: JSON.stringify([{ code: 'bad', budgetGbp: 0.3, minutes: 60, priceGbpInclVat: 2.99, stripePriceId: 'p' }, { code: 'greedy', budgetGbp: 5, priceGbpInclVat: 2.99, stripePriceId: 'q' }]) };
  const r = validateCommercialConfiguration({ env, profiles: SEED });
  check(r.errors.some((e) => e.code === 'topup_invalid' && /bad/.test(e.detail)), 'a top-up promising more minutes than its £ funds is an ERROR');
  check(r.warnings.some((w) => w.code === 'topup_not_viable' && /greedy/.test(w.detail)), 'a top-up whose £ exceeds its margin is reported as not offered');
}
{
  const r = validateCommercialConfiguration({ env: {}, profiles: null });
  check(r.warnings.some((w) => w.code === 'profiles_unverified'), 'unreadable profiles are reported as unverified, never assumed fine');
  const bad = validateCommercialConfiguration({ env: { HCG_ECONOMICS_VAT_RATE: 'abc' }, profiles: SEED });
  check(!bad.ok && bad.errors.some((e) => e.code === 'economic_inputs_invalid'), 'malformed economic inputs are an ERROR (never a silent default)');
}

// ── §16: the customer view never over-claims ──────────────────────────
{
  const plan = { code: 'standard', warningPoints: [0.75, 0.9] };
  const base = { hasAccount: true, budgetGbp: 0.5, adjustmentsGbp: 0, estimatedConsumedGbp: 0.5, reservedGbp: 0, remainingBudgetGbp: 0, live: [] };
  const trustedOnly = fromFortressHouseholdStatus({ ...base, remainingWithReserveGbp: 0.2, deliveryReserveScope: 'trusted_only' }, { plan });
  check(trustedOnly.callsContinue === false && trustedOnly.trustedCallersContinue === true && trustedOnly.monitoringActive === false, 'budget spent + trusted-only reserve: NOT "every call continues" — trusted callers continue, monitoring off');
  const all = fromFortressHouseholdStatus({ ...base, remainingWithReserveGbp: 0.2, deliveryReserveScope: 'all' }, { plan });
  check(all.callsContinue === true, 'budget spent + reserve for all callers: calls continue (unmonitored)');
  const none = fromFortressHouseholdStatus({ ...base, remainingWithReserveGbp: 0, deliveryReserveScope: 'trusted_only' }, { plan });
  check(none.callsContinue === false && none.trustedCallersContinue === false, 'budget AND reserve spent: no caller is promised delivery');
  const web = readFileSync(path.join(ROOT, 'upload.html'), 'utf8');
  const mob = readFileSync(path.join(ROOT, 'mobile', 'components', 'AllowanceMeter.tsx'), 'utf8');
  check(/a\.trustedCallersContinue\s*\?\s*"You've used this month's protection allowance\. Calls from people you trust still get through/.test(web) && /a\.trustedCallersContinue\s*\?\s*`You've used this month's protection allowance\. Calls from people you trust still get through/.test(mob),
    'web and mobile copy say exactly who still gets through when only trusted callers do');
  check(!/calls_limited[\s\S]{0,300}every call still reaches you/.test(web), 'the calls_limited copy never says "every call still reaches you"');
}

// ── §15: admin visibility is read-only and labelled ───────────────────
{
  check(maskEmail('jane.doe@example.com') === 'j***@example.com', 'admin view masks emails');
  const calls = [];
  const fakeSupabase = {
    from(table) {
      const q = {
        select() { return q; }, lte() { return q; }, gt() { return q; }, order() { return q; }, limit() { return q; }, in() { return q; },
        then(resolve) {
          calls.push(table);
          if (table === 'fc_budget_accounts') resolve({ data: [{ household_id: 'h1', profile: 'standard', period_start: '2026-10-01', period_end: '2026-11-01', base_budget_gbp: 0.5, adjustments_gbp: 0.1, delivery_reserve_gbp: 0.25, consumed_gbp: 0.3, reserved_gbp: 0.06, last_denial_reason: 'household_budget_exhausted', last_denial_at: '2026-10-03' }], error: null });
          else if (table === 'households') resolve({ data: [{ id: 'h1', account_number: 'HCG-00010017', email: 'jane@example.com' }], error: null });
          else if (table === 'fc_events') resolve({ data: [{ created_at: '2026-10-03', level: 'warning', rule: 'call_refused_household_budget_exhausted', household_id: 'h1', call_sid: 'CA1' }], error: null });
          else resolve({ data: SEED, error: null });
        },
      };
      return q;
    },
  };
  const o = await getFortressOverview({
    supabase: fakeSupabase,
    globalStatus: async () => ({ killSwitch: false, breakerOpen: true, breakerReason: 'hourly_spend', activeCount: 3, activeReservedGbp: 0.4, activeWorstCaseGbp: 1.2, entitledHouseholds: 24, enforcementMode: 'enforce' }),
    incidentState: async () => ({ level: 'full_stop', unavailable: false, sources: [{ source: 'financial', level: 'full_stop' }] }),
    validateCommercial: ({ profiles }) => validateCommercialConfiguration({ env: {}, profiles }),
  }, new Date('2026-10-03T12:00:00Z'));
  check(o.statement === STATEMENT && /do not prove enforcement/.test(o.statement) && /"actual" is not known/.test(o.statement), 'the overview states plainly that it is visibility, not enforcement, and that actual cost is unknown');
  check(o.global.breakerOpen === true && o.incident.level === 'full_stop', 'global breaker and incident state are shown');
  check(o.households[0].accountNumber === 'HCG-00010017' && o.households[0].usedPercent === 60 && o.households[0].email === 'j***@example.com' && o.households[0].lastRefusal, 'highest-exposure households show the permanent account number, % used, last refusal; email masked');
  check(o.commercial && Array.isArray(o.commercial.decisionsRequired), 'commercial validation is surfaced to admin');
  check(calls.every((t) => ['fc_budget_accounts', 'households', 'fc_events', 'fc_budget_profiles'].includes(t)), 'the overview only reads');
  const route = readFileSync(path.join(ROOT, 'routes', 'adminFortress.js'), 'utf8');
  // 2026-10-04 (Andrew-approved): exactly three audited safety controls may be
  // changed over HTTP — each behind requireAuth + requireAdmin + JSON
  // (behaviour: tests/admin-fortress-controls.test.mjs). Nothing else.
  const writes = [...route.matchAll(/router\.(post|put|patch|delete)\("([^"]+)", ([^\n]*)/g)];
  check(/router\.get\("\/admin\/api\/fortress\/overview", requireAuth, requireAdmin,/.test(route)
    && writes.length === 3
    && writes.every((m) => m[1] === 'post' && /^requireAuth, requireAdmin, express\.json\(\),/.test(m[3]))
    && writes.map((m) => m[2]).join() === '/admin/api/fortress/breaker/reset,/admin/api/fortress/kill-switch,/admin/api/fortress/households/:id/hold',
    'admin Fortress routes: overview (GET) + only breaker reset, kill switch and household hold (POST, requireAuth + requireAdmin + JSON)');
  const server = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check(/if \(!process\.env\.ALLOWANCE_SOURCE\) process\.env\.ALLOWANCE_SOURCE = "fortress";/.test(server), 'the customer allowance describes the authoritative £ budget by default');
}

console.log(failures === 0 ? '\nAll admin/commercial checks passed.' : `\n${failures} admin/commercial check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
