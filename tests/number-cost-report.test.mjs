// Tests for services/ledger/numberCostReport.js — the financial-side
// reconciliation of provider-billed numbers. Fixture mirrors the real
// 2026-09-27 patterns (anonymised): reviewer, brother, Andrew's test
// devices, the #8 wrongly-quarantined number, a QA number outside the
// lifecycle, a legacy dev number, staging numbers on the production
// account, a pending release, an old quarantine and an orphan with recent
// inbound calls.
//
// Run with: node tests/number-cost-report.test.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildNumberCostReport } = require('../services/ledger/numberCostReport.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const NOW = new Date('2026-09-27T12:00:00Z');
const d = (days) => new Date(NOW.getTime() + days * 86400000).toISOString();
const num = (i) => `+44170000${String(i).padStart(4, '0')}`;
const owned = (i, created = '2026-09-01T00:00:00Z') => ({ sid: `PN${String(i).padStart(4, '0')}`, phoneNumber: num(i), dateCreated: created });

const households = [
  { id: 'hh-reviewer', twilio_number: num(1), environment: 'production' },
  { id: 'hh-test-a', twilio_number: num(5), environment: 'production' },
  { id: 'hh-brother', twilio_number: num(6), environment: 'production' },
  { id: 'hh-andrew', twilio_number: null, environment: 'production' },           // #8 case: number was taken
  { id: 'hh-qa', twilio_number: num(9), environment: 'production' },
  { id: 'hh-legacy-dev', twilio_number: num(17), environment: 'production' },
  { id: 'hh-cancelled', twilio_number: num(16), twilio_number_pending_release_at: d(12), environment: 'production' },
  { id: 'stg-1', twilio_number: num(12), environment: 'staging' },
  { id: 'hh-reviewer-2', twilio_number: null, environment: 'production' },
];
const entitlements = [
  { household_id: 'hh-reviewer', status: 'active', starts_at: d(-30), ends_at: null },
  { household_id: 'hh-test-a', status: 'active', starts_at: d(-4), ends_at: d(10) },
  { household_id: 'hh-brother', status: 'active', starts_at: d(-21), ends_at: d(344) },
  { household_id: 'hh-andrew', status: 'active', starts_at: d(-31), ends_at: null },
  { household_id: 'hh-qa', status: 'revoked', starts_at: d(-65), ends_at: d(-64) },
  { household_id: 'hh-cancelled', status: 'expired', starts_at: d(-21), ends_at: d(-18) },
  { household_id: 'hh-reviewer-2', status: 'active', starts_at: d(-36), ends_at: null },
];
const classifications = [
  { household_id: 'hh-reviewer', classification: 'reviewer' },
  { household_id: 'hh-brother', classification: 'internal_test' },
  { household_id: 'hh-qa', classification: 'qa_automation' },
  { household_id: 'hh-reviewer-2', classification: 'reviewer' },
];
const quarantine = [
  { twilio_number: num(8), household_id: 'hh-andrew', quarantined_at: d(-4), released_at: null, deactivation_confirmed: false },
  { twilio_number: num(4), household_id: null, quarantined_at: d(-100), released_at: null, deactivation_confirmed: false },
];
const lastInboundByNumber = { [num(19)]: d(-6), [num(9)]: d(-66), [num(6)]: d(-1) };

const report = buildNumberCostReport({
  ownedNumbers: [1, 4, 5, 6, 8, 9, 12, 16, 17, 19].map((i) => owned(i)),
  monthlyRate: 0.86917,
  currency: 'GBP',
  households, entitlements, classifications, quarantine, lastInboundByNumber, now: NOW,
});
const row = (i) => report.rows.find((r) => r.sid === `PN${String(i).padStart(4, '0')}`);
const has = (type, pred = () => true) => report.anomalies.some((a) => a.type === type && pred(a));

check(report.kpis.totalNumbers === 10 && report.kpis.monthlyCost === 8.6917, 'total numbers and monthly rental cost come from the provider inventory');
check(row(1).assessment === 'retained_internal' && row(6).assessment === 'retained_internal', 'reviewer and brother (internal, entitled) are intentional retained overhead');
check(row(5).assessment === 'customer_required' && row(5).classification === 'unclassified',
  'an entitled but UNCLASSIFIED household counts as a customer — classification drives the split');
check(row(16).assessment === 'lifecycle_in_progress' && row(16).lifecycle === 'pending_release', 'a cancelled customer pending release is lifecycle_in_progress');
check(row(9).assessment === 'apparently_unnecessary' && has('NUMBER_WITHOUT_ENTITLEMENT_OUTSIDE_LIFECYCLE', (a) => a.sid === 'PN0009'),
  'a number whose household has no entitlement and is outside the release lifecycle is flagged as apparently unnecessary');
check(row(17).assessment === 'apparently_unnecessary' && row(17).entitlement === 'never', 'a legacy dev household that never had an entitlement is flagged');
check(row(12).environment === 'staging' && row(12).assessment === 'apparently_unnecessary' && has('STAGING_NUMBER_ON_BILLED_ACCOUNT'),
  'a staging number billed on this account is reported (environment staging)');
check(row(19).assessment === 'orphan_investigate' && row(19).recentInbound === true
  && has('ORPHAN_NUMBER', (a) => a.sid === 'PN0019' && /RECENT INBOUND/.test(a.detail)),
  'an orphan with recent inbound calls is flagged for investigation, explicitly not for release');
check(row(8).lifecycle === 'quarantined' && has('QUARANTINED_NUMBER_OF_ENTITLED_HOUSEHOLD', (a) => a.level === 'CRITICAL' && a.sid === 'PN0008'),
  'the #8 pattern (quarantined from a currently entitled household) is a CRITICAL anomaly');
check(has('ENTITLED_HOUSEHOLD_WITHOUT_NUMBER', (a) => a.household === 'hh-andre' && a.level === 'CRITICAL')
  && has('ENTITLED_HOUSEHOLD_WITHOUT_NUMBER', (a) => a.household === 'hh-revie' && a.classification === 'reviewer'),
  'entitled households with no billed number (#8 household, reviewer) are CRITICAL');
check(has('QUARANTINE_OVERDUE', (a) => a.level === 'CRITICAL' && a.sid === 'PN0004'), 'a quarantine older than the 90-day policy is CRITICAL');
check(!has('QUARANTINE_OVERDUE', (a) => a.sid === 'PN0008'), 'a 4-day-old quarantine is not overdue');

const k = report.kpis;
check(k.expectedMonthlyCost === 2.60751, 'expected monthly cost = retained internal + customer-required numbers (3 × £0.86917)');
check(k.potentialMonthlySaving.whenLifecycleCompletes === 2.60751, 'saving when the lifecycle completes = pending + quarantined numbers');
check(k.potentialMonthlySaving.ifApparentlyUnnecessaryResolved === 2.60751 && k.potentialMonthlySaving.blockedByRecentInboundActivity === 0.86917,
  'apparently-unnecessary saving excludes numbers with recent inbound activity; the orphan\'s cost is shown as blocked');
check(k.byAssessment.orphan_investigate.numbers === 1 && k.stagingNumbersOnAccount === 1 && k.entitledHouseholdsWithoutNumber === 2, 'KPIs count orphans, staging numbers and entitled households without numbers');

const text = JSON.stringify(report);
check(!/\+44|170000/.test(text), 'the report contains no phone numbers (last three digits only)');

const again = buildNumberCostReport({
  ownedNumbers: [1, 4, 5, 6, 8, 9, 12, 16, 17, 19].map((i) => owned(i)), monthlyRate: 0.86917, currency: 'GBP',
  households, entitlements, classifications, quarantine, lastInboundByNumber, now: NOW,
});
check(JSON.stringify(again) === text, 'the report is deterministic — re-running it is idempotent');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
