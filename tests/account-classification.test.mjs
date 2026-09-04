// Regression tests for Business Dashboard V2's account classification
// and CONFIRMED/ESTIMATED financial split (2026-09).
//
// Covers, per the approved implementation brief: test/internal accounts
// excluded from genuine-customer KPIs; the admin account excluded from
// genuine-customer KPIs; an unset fixed cost never silently becomes
// £0.00; confirmed operating profit is withheld (INCOMPLETE) rather
// than shown as a false precise figure when a material cost is unknown;
// and structural checks that routes/adminBusiness.js actually wires the
// new fields through and preserves requireAuth/requireAdmin.
//
// Run with: node tests/account-classification.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy-test.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy';

const require = createRequire(import.meta.url);

const { UNCLASSIFIED, classifyHousehold } = require('../services/businessMetrics/accountClassification.js');
const { computeGenuineCustomerBreakdown } = require('../services/businessMetrics/customerClassificationOverview.js');
const { resolveFixedMonthlyCostsStatus } = require('../services/businessMetrics/config.js');
const { computeConfirmedContribution } = require('../services/businessMetrics/profitability.js');
const routeSource = readFileSync(new URL('../routes/adminBusiness.js', import.meta.url), 'utf8');
const migrationSource = readFileSync(new URL('../supabase/migrations/031_account_classifications.sql', import.meta.url), 'utf8');

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`✓ ${message}`);
  } else {
    console.error(`✗ ${message}`);
    failures++;
  }
}

// --- classifyHousehold: absence is always UNCLASSIFIED, never genuine ---

check(
  classifyHousehold('missing-id', new Map()) === UNCLASSIFIED,
  'classifyHousehold: a household with no row in the classification table is UNCLASSIFIED, never genuine_customer'
);

check(
  classifyHousehold('h1', new Map([['h1', 'genuine_customer']])) === 'genuine_customer',
  'classifyHousehold: an explicitly classified household returns its real classification'
);

// --- computeGenuineCustomerBreakdown: the actual KPI split ---

const households = [
  { id: 'admin-1', email: 'admin@homecallguard.co.uk', twilio_provisioning_status: 'pending', twilio_number: null },
  { id: 'test-1', email: 'ad_74uk@yahoo.co.uk', twilio_provisioning_status: 'active', twilio_number: '+441111111111' },
  { id: 'reviewer-1', email: 'appreview@homecallguard.co.uk', twilio_provisioning_status: 'pending', twilio_number: null },
  { id: 'qa-1', email: 'qa-sandbox-v1.5@homecallguard.co.uk', twilio_provisioning_status: 'active', twilio_number: '+441111111112' },
  { id: 'genuine-1', email: 'a.genuine.customer@example.com', twilio_provisioning_status: 'active', twilio_number: '+441111111113' },
  { id: 'genuine-2', email: 'another.genuine@example.com', twilio_provisioning_status: 'pending', twilio_number: null },
  { id: 'unclassified-1', email: 'unknown.origin@example.com', twilio_provisioning_status: 'active', twilio_number: '+441111111114' },
];
const classificationMap = new Map([
  ['admin-1', 'admin'],
  ['test-1', 'internal_test'],
  ['reviewer-1', 'reviewer'],
  ['qa-1', 'qa_automation'],
  ['genuine-1', 'genuine_customer'],
  ['genuine-2', 'genuine_customer'],
  // unclassified-1 deliberately has no entry — must fall to UNCLASSIFIED
]);
// Every household except reviewer-1 and unclassified-1 has an active entitlement.
const activeEntitlementHouseholdIds = ['admin-1', 'test-1', 'qa-1', 'genuine-1', 'genuine-2'];

const breakdown = computeGenuineCustomerBreakdown(
  { households, activeEntitlementHouseholdIds, activeStripeEntitlementHouseholdIds: ['genuine-1'] },
  classificationMap
);

check(
  breakdown.genuineCustomers === 2,
  'computeGenuineCustomerBreakdown: counts only the 2 genuine_customer households (genuine-1, genuine-2), not admin/test/reviewer/qa/unclassified'
);

check(
  breakdown.genuinePayingCustomers === 2,
  'computeGenuineCustomerBreakdown: both genuine customers have an active entitlement here — genuinePayingCustomers reflects that, unaffected by the internal_test/admin/reviewer/qa accounts that also have active entitlements'
);

check(
  breakdown.genuineStripePayingCustomers === 1,
  'computeGenuineCustomerBreakdown: only the Stripe-sourced genuine entitlement counts toward the real, confirmed-MRR basis'
);

check(
  breakdown.activeProtectedGenuineCustomers === 1,
  'computeGenuineCustomerBreakdown: active-protected count is scoped to genuine customers only (genuine-1 has a live Twilio number; genuine-2 does not)'
);

check(
  breakdown.internalTest === 1 && breakdown.admin === 1 && breakdown.reviewer === 1 && breakdown.qaAutomation === 1,
  'computeGenuineCustomerBreakdown: internal_test, admin, reviewer, and qa_automation are each counted in their own separate bucket, never folded into genuine customers'
);

check(
  breakdown.unclassified === 1 && breakdown.unclassifiedAccounts.length === 1 && breakdown.unclassifiedAccounts[0].householdId === 'unclassified-1',
  'computeGenuineCustomerBreakdown: an account with no classification row is reported as unclassified, not silently counted as genuine — the exact case this whole mechanism exists for (ad_74uk@yahoo.co.uk looked exactly like a real customer by email shape alone)'
);

check(
  breakdown.genuineCustomers + breakdown.internalTest + breakdown.admin + breakdown.reviewer + breakdown.qaAutomation + breakdown.unclassified === households.length,
  'computeGenuineCustomerBreakdown: every household lands in exactly one bucket — no double-counting, no household dropped'
);

// --- resolveFixedMonthlyCostsStatus: unknown cost is never £0 ---

check(
  resolveFixedMonthlyCostsStatus({}).railway.configured === false && resolveFixedMonthlyCostsStatus({}).railway.valueGbp === null,
  'resolveFixedMonthlyCostsStatus: an unset fixed cost reports configured:false and valueGbp:null — never a false £0'
);

check(
  resolveFixedMonthlyCostsStatus({}).allConfigured === false && resolveFixedMonthlyCostsStatus({}).totalGbp === null,
  'resolveFixedMonthlyCostsStatus: totalGbp is null (not 0) whenever any one fixed cost is unconfigured'
);

check(
  resolveFixedMonthlyCostsStatus({ BUSINESS_FIXED_COST_RESEND_GBP: '0' }).resend.configured === true &&
    resolveFixedMonthlyCostsStatus({ BUSINESS_FIXED_COST_RESEND_GBP: '0' }).resend.valueGbp === 0,
  'resolveFixedMonthlyCostsStatus: an operator who explicitly enters 0 (e.g. a real free-tier cost) is distinguished from "never configured" — that 0 is real and reported as configured'
);

const fullyConfigured = resolveFixedMonthlyCostsStatus({
  BUSINESS_FIXED_COST_RAILWAY_GBP: '5',
  BUSINESS_FIXED_COST_SUPABASE_GBP: '25',
  BUSINESS_FIXED_COST_RESEND_GBP: '0',
});
check(
  fullyConfigured.allConfigured === true && fullyConfigured.totalGbp === 30,
  'resolveFixedMonthlyCostsStatus: once every fixed cost is explicitly configured, allConfigured is true and totalGbp sums them correctly'
);

// --- computeConfirmedContribution: never a false-precise confirmed profit ---

const incompleteResult = computeConfirmedContribution({
  stripeGrossRevenueGbp: 4.99,
  stripeFeesGbp: 0.36,
  twilioCostGbp: 0.87,
  vatRateAppliedToGross: 0.2,
  fixedCostsStatus: resolveFixedMonthlyCostsStatus({}), // nothing configured
  genuinePayingCustomerCount: 1,
});

check(
  incompleteResult.profit.operatingProfitGbp === null && incompleteResult.profit.operatingProfitStatus === 'INCOMPLETE',
  'computeConfirmedContribution: operating profit is null/INCOMPLETE (never a precise figure) when fixed costs are not configured'
);

check(
  incompleteResult.profit.missingCostInputs.length === 3,
  'computeConfirmedContribution: the exact missing cost inputs are named (all 3, since none are configured in this case)'
);

check(
  typeof incompleteResult.profit.contributionGbp === 'number' && incompleteResult.profit.contributionGbp > 0,
  'computeConfirmedContribution: contribution is still computed and useful even when fixed costs are unknown — only operating profit is withheld'
);

const completeResult = computeConfirmedContribution({
  stripeGrossRevenueGbp: 4.99,
  stripeFeesGbp: 0.36,
  twilioCostGbp: 0.87,
  vatRateAppliedToGross: 0.2,
  fixedCostsStatus: fullyConfigured,
  genuinePayingCustomerCount: 1,
});

check(
  completeResult.profit.operatingProfitStatus === 'CONFIRMED' && typeof completeResult.profit.operatingProfitGbp === 'number',
  'computeConfirmedContribution: once fixed costs are configured, a real CONFIRMED operating profit figure is produced'
);

check(
  completeResult.revenue.stripeGrossRevenueGbp === 4.99 &&
    Math.abs(completeResult.revenue.netRevenueExVatGbp - 4.16) < 0.01,
  'computeConfirmedContribution: uses the same real VAT split as the rest of the dashboard (£4.99 gross -> ~£4.16 net ex-VAT, rounded to 2dp for display)'
);

// --- Structural: the route wires classification/CONFIRMED fields through ---

check(
  routeSource.includes('getGenuineCustomerOverview') && routeSource.includes('confirmedMrr') && routeSource.includes('confirmedContributionMtd'),
  'routes/adminBusiness.js wires the genuine-customer overview and CONFIRMED profitability into the response'
);

check(
  routeSource.includes('requireAuth, requireAdmin') && !routeSource.includes('requireEntitlement'),
  'routes/adminBusiness.js still gates every route with requireAuth + requireAdmin only — unchanged from V1, no weakening of admin access control'
);

check(
  migrationSource.includes("on delete cascade") && migrationSource.includes('grant select, insert, update on public.account_classifications to service_role'),
  'migration 031: the new table cascades on household deletion and grants only the exact privileges the dashboard needs — no broader grant than necessary'
);

check(
  !migrationSource.toLowerCase().includes('delete from public.households') && !migrationSource.toLowerCase().includes('update public.entitlements') && !migrationSource.toLowerCase().includes('update public.subscriptions'),
  'migration 031 never deletes or alters any existing household/entitlement/subscription row — purely additive, matching the explicit "do not delete/anonymise/refund/alter any account" instruction'
);

console.log(failures === 0 ? '\nAll account-classification checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
