// Tests for the business control centre v2 (2026-09-27):
//   definitions.js (the business vocabulary — regression suite),
//   stripeRevenue.js (genuine MRR / collected revenue, test-mode guard),
//   numberInventory.js (Twilio number inventory),
//   controlOverview.js (the twelve Overview cards and their colour rules),
//   lifecycleTimeline.js (subscription → … → gone from Twilio),
//   campaignPerformance.js channel comparison.
// Pure functions only.
//
// Run with: node tests/business-control-centre.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-09-27T12:00:00.000Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const ent = (type, startsAgo, extra = {}) => ({ entitlement_type: type, status: 'active', source: type === 'paid_subscription' ? 'stripe' : 'admin_manual', starts_at: ago(startsAgo), ends_at: null, updated_at: ago(startsAgo), ...extra });
const protectedFields = { activation_verified_at: ago(DAY), voice_client_registered_at: ago(HOUR), delivery_verified_at: ago(DAY) };

// ============================================================
// 1. Business vocabulary (definitions.js)
// ============================================================
{
  const { classifyHouseholdForBusiness, GLOSSARY } = require('../services/businessControl/definitions.js');
  const cls = (household, entitlements, subscriptions, classification) => classifyHouseholdForBusiness({ household: { id: 'h', email: 'a@b.c', ...household }, entitlements, subscriptions, classification }, NOW);

  const paidGenuine = cls({ twilio_number: '+44', ...protectedFields }, [ent('paid_subscription', 10 * DAY)], [{ status: 'active', updated_at: ago(DAY) }], 'genuine_customer');
  check(paidGenuine.accountClass === 'genuine' && paidGenuine.access === 'paid' && paidGenuine.isGenuinePayingCustomer, 'paid: genuine + current paid_subscription = genuine paying customer');
  check(paidGenuine.protection === 'protected', 'protected: current membership + delivery confirmed + app registered');

  const comp = cls({ twilio_number: '+44' }, [ent('complimentary', 10 * DAY)], [], 'genuine_customer');
  check(comp.access === 'complimentary' && !comp.isGenuinePayingCustomer, 'complimentary: never a paying customer, even when the account is genuine');
  check(comp.protection === 'entitled_not_protected', 'entitled but not protected: current membership without delivery/app evidence');

  const testAcc = cls({}, [ent('paid_subscription', 5 * DAY)], [], 'internal_test');
  check(testAcc.accountClass === 'internal_test' && testAcc.access === 'paid' && !testAcc.isGenuinePayingCustomer, 'internal test with paid access is NOT a genuine paying customer');
  const reviewer = cls({}, [ent('complimentary', 5 * DAY)], [], 'reviewer');
  check(reviewer.accountClass === 'reviewer' && !reviewer.isGenuine, 'reviewer: its own class, never genuine');
  check(cls({}, [ent('paid_subscription', DAY)], [], undefined).accountClass === 'unclassified', 'unclassified: never defaulted to genuine');
  check(cls({ email: 'anonymized-x@deleted.homecallguard.internal' }, [], [], 'genuine_customer').accountClass === 'deleted', 'deleted accounts are their own class');

  const cancelled = cls({ twilio_number: '+44' }, [ent('paid_subscription', 60 * DAY, { status: 'expired', updated_at: ago(5 * DAY) })], [{ status: 'canceled', updated_at: ago(5 * DAY) }], 'genuine_customer');
  check(cancelled.membership === 'cancelled' && cancelled.protection === 'not_entitled' && cancelled.membershipEndedAt === ago(5 * DAY), 'cancelled: subscription canceled, no current access; ended date recorded');
  const revoked = cls({}, [ent('complimentary', 30 * DAY, { status: 'revoked', updated_at: ago(2 * DAY) })], [], 'reviewer');
  check(revoked.membership === 'cancelled', 'cancelled: access revoked by an admin');
  const expired = cls({}, [ent('complimentary', 60 * DAY, { ends_at: ago(DAY) })], [], 'genuine_customer');
  check(expired.membership === 'expired' && expired.membershipEndedAt === ago(DAY), 'expired: ended by date (not cancelled)');
  check(cls({}, [ent('paid_subscription', -2 * DAY)], [], 'genuine_customer').membership === 'upcoming', 'upcoming: active with a future start (047 definition)');
  check(cls({}, [ent('paid_subscription', 0, { status: 'scheduled', starts_at: ago(-DAY) })], [], 'genuine_customer').membership === 'upcoming', 'upcoming: scheduled');
  check(cls({}, [], [], 'genuine_customer').membership === 'never', 'never: no membership ever');
  const protectedButExpired = cls({ twilio_number: '+44', ...protectedFields }, [ent('paid_subscription', 60 * DAY, { ends_at: ago(DAY) })], [], 'genuine_customer');
  check(protectedButExpired.protection === 'not_entitled', 'technical protection evidence without a current membership is NOT "protected"');
  check(cls({}, [ent('paid_subscription', 5 * DAY)], [{ status: 'active', cancel_at_period_end: true, updated_at: ago(DAY) }], 'genuine_customer').cancellingAtPeriodEnd === true, 'cancelling at period end is still current (not yet cancelled)');
  check(GLOSSARY.length >= 10 && GLOSSARY.some(([t]) => t === 'Revenue / MRR'), 'glossary defines every business term, including revenue/MRR');
}

// ============================================================
// 2. Genuine revenue from Stripe (stripeRevenue.js)
// ============================================================
{
  const { computeRecognisedMrr, computeCollectedRevenue, monthlyAmountMinor, stripeMode, exVat } = require('../services/businessControl/stripeRevenue.js');
  const genuine = new Map([['cus_g1', 'h1'], ['cus_g2', 'h2']]);
  const sub = (customer, status, unit, interval = 'month', livemode = true, currency = 'gbp') => ({ customer, status, livemode, currency, items: { data: [{ quantity: 1, price: { unit_amount: unit, currency, recurring: { interval, interval_count: 1 } } }] } });
  const mrr = computeRecognisedMrr([
    sub('cus_g1', 'active', 499),
    sub('cus_g2', 'past_due', 4990, 'year'),
    sub('cus_test', 'active', 499),
    sub('cus_g1', 'canceled', 499),
  ], genuine);
  check(mrr.genuine.GBP === 9.15 && mrr.genuineSubscriptions === 2, 'MRR: genuine monthly £4.99 + annual £49.90/12 = £9.15 (cancelled ignored)');
  check(mrr.excludedNonGenuine.GBP === 4.99 && mrr.excludedSubscriptions === 1, 'MRR: a non-genuine subscription is excluded and reported, not counted');
  check(Math.abs(monthlyAmountMinor(sub('x', 'active', 499, 'week')) - (499 * 52) / 12) < 1e-9, 'weekly price normalised to a month');
  check(computeRecognisedMrr([sub('cus_g1', 'trialing', 499)], genuine).genuine.GBP === 0, 'a trialing subscription contributes no MRR');
  const multi = computeRecognisedMrr([sub('cus_g1', 'active', 499), sub('cus_g2', 'active', 599, 'month', true, 'eur')], genuine);
  check(multi.genuine.GBP === 4.99 && multi.genuine.EUR === 5.99, 'currencies are never added together');

  const charges = [
    { customer: 'cus_g1', paid: true, status: 'succeeded', amount: 499, amount_refunded: 0, currency: 'gbp', livemode: true, balance_transaction: { fee: 33, currency: 'gbp' } },
    { customer: 'cus_g2', paid: true, status: 'succeeded', amount: 499, amount_refunded: 499, currency: 'gbp', livemode: true, balance_transaction: { fee: 33, currency: 'gbp' } },
    { customer: 'cus_test', paid: true, status: 'succeeded', amount: 499, amount_refunded: 0, currency: 'gbp', livemode: true, balance_transaction: { fee: 33 } },
    { customer: 'cus_g1', paid: false, status: 'failed', amount: 499, amount_refunded: 0, currency: 'gbp', livemode: true },
  ];
  const col = computeCollectedRevenue(charges, genuine);
  check(col.genuine.GBP === 4.99 && col.genuineCharges === 2, 'collected: genuine payments net of refunds (a fully refunded payment contributes £0); failed payments ignored');
  check(col.otherNonGenuine.GBP === 4.99, 'collected: non-genuine receipts reported separately, never as revenue');
  check(col.genuineFees.GBP === 0.66 && col.feesMissing === 0, 'fees: Stripe\'s own fee per genuine payment');
  check(computeCollectedRevenue([{ ...charges[0], balance_transaction: 'txn_123' }], genuine).feesMissing === 1, 'fee not available (unexpanded) → counted as missing, never zero');
  check(stripeMode(false, 'sk_live_x') === 'test' && stripeMode(true, 'sk_test_x') === 'live', 'mode comes from Stripe objects first');
  check(stripeMode(null, 'sk_test_abc') === 'test' && stripeMode(null, 'rk_live_abc') === 'live' && stripeMode(null, undefined) === 'unknown', 'mode falls back to the key prefix (the key itself is never returned)');
  check(exVat({ GBP: 5.99 }, 0.2).GBP === 4.99, 'ex-VAT split at the configured rate');
}

// ============================================================
// 3. Twilio number inventory (numberInventory.js)
// ============================================================
const { buildNumberInventory, voiceHostEvidence, resolveProductionHosts, deriveRentalPerNumber, maskNumber } = require('../services/businessControl/numberInventory.js');
const prodHosts = resolveProductionHosts({ APP_URL: 'https://www.homecallguard.co.uk' });
{
  check(prodHosts.has('www.homecallguard.co.uk') && prodHosts.has('homecallguard.co.uk'), 'production hosts: APP_URL host and its www/apex twin');
  check(resolveProductionHosts({ APP_URL: 'https://x.com', BUSINESS_PRODUCTION_VOICE_HOSTS: 'call-ai-production.up.railway.app' }).has('call-ai-production.up.railway.app'), 'extra production hosts configurable');
  check(voiceHostEvidence('https://ferret-x.ngrok-free.dev/voice', prodHosts).environment === 'dev_tunnel', 'ngrok voice URL → development tunnel');
  check(voiceHostEvidence('https://homecallguard.co.uk/voice', prodHosts).environment === 'production', 'production host → production');
  check(voiceHostEvidence(null, prodHosts).environment === 'no_voice_url' && voiceHostEvidence('https://other.example/voice', prodHosts).environment === 'other_host', 'no URL / other host distinguished');
  const rental = deriveRentalPerNumber([{ category: 'phonenumbers-local', price: '-14.77589', usage: '17', priceUnit: 'gbp' }, { category: 'calls-inbound', price: '-1', usage: '9' }]);
  check(rental.perNumber === 0.8692 && rental.provenance === 'ACTUAL' && /17 number-months/.test(rental.basis), 'rental per number from Twilio\'s own last-month figures (£14.78 / 17 = £0.8692)');
  check(deriveRentalPerNumber([]) === null, 'no rental records → no rate (not zero)');

  const V = 'https://www.homecallguard.co.uk/voice';
  const households = [
    { id: 'hA', email: 'a@x', twilio_number: '+447000000001' },                                  // genuine current
    { id: 'hB', email: 'b@x', twilio_number: '+447000000002' },                                  // cancelled, no release
    { id: 'hC', email: 'c@x', twilio_number: '+447000000003', twilio_number_pending_release_at: ago(-5 * DAY) }, // grace
    { id: 'hD', email: 'd@x', twilio_number: '+447000000004', twilio_number_pending_release_at: ago(3 * DAY) },  // overdue
    { id: 'hE', email: 'e@x', twilio_number: '+447000000005' },                                  // reviewer current, dev URL
    { id: 'hF', email: 'f@x', twilio_number: '+447000000099' },                                  // missing at provider
    { id: 'hG', email: 'g@x', twilio_number: '+447000000011', twilio_release_last_error: 'Twilio 20404', twilio_release_attempt_count: 3 },
  ];
  const ents = new Map([
    ['hA', [ent('paid_subscription', 10 * DAY)]],
    ['hB', [ent('paid_subscription', 60 * DAY, { status: 'expired', updated_at: ago(5 * DAY) })]],
    ['hC', [ent('complimentary', 60 * DAY, { ends_at: ago(DAY) })]],
    ['hD', [ent('complimentary', 60 * DAY, { ends_at: ago(20 * DAY) })]],
    ['hE', [ent('complimentary', 10 * DAY)]],
    ['hF', [ent('paid_subscription', 10 * DAY)]],
    ['hG', [ent('complimentary', 60 * DAY, { ends_at: ago(20 * DAY) })]],
  ]);
  const subs = new Map([['hB', [{ status: 'canceled', updated_at: ago(5 * DAY) }]]]);
  const classes = new Map([['hA', 'genuine_customer'], ['hB', 'genuine_customer'], ['hE', 'reviewer']]);
  const provider = [
    { phoneNumber: '+447000000001', voiceUrl: V }, { phoneNumber: '+447000000002', voiceUrl: V }, { phoneNumber: '+447000000003', voiceUrl: V },
    { phoneNumber: '+447000000004', voiceUrl: V }, { phoneNumber: '+447000000005', voiceUrl: 'https://tun.ngrok-free.dev/voice' },
    { phoneNumber: '+447000000006', voiceUrl: V },                          // open quarantine awaiting confirmation
    { phoneNumber: '+447000000007', voiceUrl: V },                          // quarantine recorded released
    { phoneNumber: '+447000000008', voiceUrl: 'https://tun.ngrok-free.dev/voice' }, // staging
    { phoneNumber: '+447000000009', voiceUrl: null },                       // orphan
    { phoneNumber: '+447000000011', voiceUrl: V },
  ];
  const quarantine = [
    { household_id: null, twilio_number: '+447000000006', deactivation_confirmed: false, quarantined_at: ago(3 * DAY), released_at: null, release_reason: 'subscription_grace_expired' },
    { household_id: null, twilio_number: '+447000000007', deactivation_confirmed: true, deactivation_confirmed_at: ago(10 * DAY), released_at: ago(9 * DAY) },
  ];
  const inv = buildNumberInventory({ providerNumbers: provider, households, entitlementsByHousehold: ents, subscriptionsByHousehold: subs, classificationMap: classes, quarantineRows: quarantine, productionHosts: prodHosts, rental: { perNumber: 0.87, currency: 'GBP', basis: 'test', provenance: 'ACTUAL' }, releaseRecordingAvailable: true }, NOW);
  const byNum = Object.fromEntries(inv.rows.map((r) => [r.number, r]));
  check(inv.providerNumberCount === 10, 'every provider number is listed');
  check(byNum[maskNumber('+447000000001')].state === 'in_service' && byNum[maskNumber('+447000000001')].severity === 'info' && /paid access/.test(byNum[maskNumber('+447000000001')].whyExpected), 'genuine paying customer\'s number: in service, and says why');
  check(byNum[maskNumber('+447000000002')].state === 'outside_lifecycle' && byNum[maskNumber('+447000000002')].severity === 'red', 'cancelled customer still holding a number with no release scheduled → red');
  check(byNum[maskNumber('+447000000003')].state === 'grace_period' && byNum[maskNumber('+447000000003')].severity === 'info', 'lapsed household within its scheduled grace period → expected, not flagged');
  check(byNum[maskNumber('+447000000004')].state === 'release_overdue' && byNum[maskNumber('+447000000004')].severity === 'red', 'release more than 48h overdue → red');
  check(byNum[maskNumber('+447000000005')].state === 'retained_internal' && byNum[maskNumber('+447000000005')].flags.some((f) => f.code === 'voice_url_mismatch'), 'a production household\'s number pointing at a dev tunnel is flagged (calls would not reach production)');
  check(byNum[maskNumber('+447000000006')].state === 'quarantined_awaiting_confirmation' && byNum[maskNumber('+447000000006')].severity === 'amber', 'quarantined, awaiting your confirmation → amber');
  const entitledQ = buildNumberInventory({ providerNumbers: [{ phoneNumber: '+447000000050', voiceUrl: V }], households: [{ id: 'hQ', email: 'q@x', twilio_number: null }], entitlementsByHousehold: new Map([['hQ', [ent('complimentary', 5 * DAY)]]]), classificationMap: new Map(), quarantineRows: [{ household_id: 'hQ', twilio_number: '+447000000050', deactivation_confirmed: false, quarantined_at: ago(3 * DAY), released_at: null }], productionHosts: prodHosts, rental: null, releaseRecordingAvailable: false }, NOW);
  check(entitledQ.rows[0].severity === 'red' && entitledQ.rows[0].flags.some((f) => f.code === 'quarantined_from_entitled') && /Do NOT confirm deactivation/.test(entitledQ.rows[0].recommendations.join(' ')), 'a quarantined number whose household is entitled again → red, "do not confirm deactivation" (Finance CRITICAL case)');
  check(byNum[maskNumber('+447000000007')].state === 'marked_released_still_at_provider' && byNum[maskNumber('+447000000007')].severity === 'red', 'recorded as released but Twilio still lists it → red');
  check(byNum[maskNumber('+447000000008')].state === 'staging_or_dev' && byNum[maskNumber('+447000000008')].severity === 'amber', 'unlinked number on a dev tunnel → staging/dev (amber)');
  check(byNum[maskNumber('+447000000009')].state === 'orphan' && byNum[maskNumber('+447000000009')].severity === 'red' && /Check recent inbound calls/.test(byNum[maskNumber('+447000000009')].recommendations[0]), 'unlinked number with no dev evidence → orphan (red) with "investigate before release" advice');
  check(byNum[maskNumber('+447000000099')].state === 'missing_at_provider' && byNum[maskNumber('+447000000099')].severity === 'red', 'household number not on the provider account → red');
  check(byNum[maskNumber('+447000000011')].flags.some((f) => f.code === 'release_failed_recorded' && /3 time/.test(f.label)), 'a recorded release failure (P0 columns) is shown with its attempt count and error');
  check(inv.rows.every((r) => r.state === 'missing_at_provider' || r.monthlyRental === 0.87), 'each provider number shows its monthly rental');
  check(inv.monthlyRental.allNumbers === 8.7, 'total rental = 10 × £0.87');
  check(inv.rows[0].severity === 'red', 'rows sorted red first');
  const noRec = buildNumberInventory({ providerNumbers: [], households: [], entitlementsByHousehold: new Map(), classificationMap: new Map(), quarantineRows: [], productionHosts: prodHosts, rental: null, releaseRecordingAvailable: false }, NOW);
  check(/not recorded yet/.test(noRec.releaseFailureRecording) && noRec.monthlyRental.provenance === 'NOT_CONNECTED', 'without P0\'s columns release failures are "not recorded yet"; without a rate, rental is NOT CONNECTED');
}

// ============================================================
// 4. Overview cards (controlOverview.js)
// ============================================================
{
  const { computeControlOverview } = require('../services/businessControl/controlOverview.js');
  const households = [
    { id: 'g1', email: 'g1@x', twilio_number: '+1', ...protectedFields },
    { id: 'c1', email: 'c1@x', twilio_number: '+2' },
    { id: 'u1', email: 'u1@x', twilio_number: null, twilio_provisioning_status: 'failed' },
    { id: 'x1', email: 'x1@x', twilio_number: '+3' },
  ];
  const ents = new Map([
    ['g1', [ent('paid_subscription', 10 * DAY)]],
    ['c1', [ent('complimentary', 10 * DAY)]],
    ['u1', [ent('complimentary', 3 * DAY)]],
    ['x1', [ent('paid_subscription', 60 * DAY, { status: 'expired', updated_at: ago(5 * DAY) })]],
  ]);
  const classes = new Map([['g1', 'genuine_customer'], ['c1', 'reviewer']]);
  const inventory = { providerNumberCount: 5, monthlyRental: { perNumber: 0.87, currency: 'GBP', basis: 'b', allNumbers: 4.35, flaggedNumbers: 1.74 },
    rows: [{ number: '+9', state: 'orphan', severity: 'red', whyExpected: 'none', owner: null }, { number: '+8', state: 'staging_or_dev', severity: 'amber', whyExpected: 'dev', owner: null }] };
  const liveStripe = { available: true, mode: 'live', mrr: { genuine: { GBP: 4.99 }, genuineExVat: { GBP: 4.16 }, genuineSubscriptions: 1, excludedSubscriptions: 1 } };
  const o = computeControlOverview({ households, entitlementsByHousehold: ents, subscriptionsByHousehold: new Map(), classificationMap: classes, quarantineRows: [], inventory, stripeRevenue: liveStripe, releaseRecordingAvailable: false }, NOW);
  const card = (id) => o.cards.find((c) => c.id === id);
  check(o.cards.length === 13, 'thirteen cards (twelve + paid-but-unclassified)');
  check(o.cards.every((c) => c.rule && ['red', 'amber', 'green', 'grey', 'info'].includes(c.status)), 'every card has a stated rule and a defined status');
  check(card('genuine_paying').value === 1 && card('genuine_paying').status === 'info', 'genuine paying customers: 1 (count, no colour judgement)');
  check(card('non_paying_access').value === 2 && card('non_paying_access').status === 'amber' && /1 reviewer/.test(card('non_paying_access').sub) && /1 unclassified/.test(card('non_paying_access').sub), 'complimentary/internal/test/reviewer: counted by class; amber because one account is unclassified');
  check(card('mrr').value === '£4.99' && /1 non-genuine subscription\(s\) excluded/.test(card('mrr').sub), 'MRR from genuine Stripe subscriptions only (£4.99), non-genuine excluded');
  check(card('protected').value === 1, 'protected households: 1');
  check(card('entitled_not_protected').value === 2 && card('entitled_not_protected').status === 'amber', 'entitled but not protected: 2 → amber');
  check(card('households_with_number').value === 3, 'households holding a number: 3');
  check(card('provider_numbers').value === 5 && /4\.35/.test(card('provider_numbers').sub), 'active Twilio numbers with monthly rental');
  check(card('unmapped_numbers').value === 2 && card('unmapped_numbers').status === 'red', 'unmapped numbers: red because one is an orphan');
  check(card('lapsed_retaining_number').value === 1 && card('lapsed_retaining_number').status === 'red', 'expired household holding a number with no release scheduled → red');
  check(card('entitled_missing_number').value === 1 && card('entitled_missing_number').status === 'red', 'entitled household missing a number (provisioning failed) → red');
  check(card('lifecycle_anomalies').status === 'red', 'unresolved lifecycle anomalies → red');
  check(o.overall === 'red', 'overall colour follows the worst card');

  const testStripe = computeControlOverview({ households, entitlementsByHousehold: ents, subscriptionsByHousehold: new Map(), classificationMap: classes, quarantineRows: [], inventory, stripeRevenue: { available: true, mode: 'test' }, releaseRecordingAvailable: false }, NOW);
  check(testStripe.cards.find((c) => c.id === 'mrr').status === 'grey' && /TEST/.test(testStripe.cards.find((c) => c.id === 'mrr').value), 'Stripe test mode → MRR grey "TEST mode", never shown as revenue');
  check(testStripe.incomplete === true, 'a grey card marks the overview incomplete');

  const clean = computeControlOverview({ households: [{ id: 'g1', email: 'g1@x', twilio_number: '+1', ...protectedFields }], entitlementsByHousehold: new Map([['g1', [ent('paid_subscription', 10 * DAY)]]]), subscriptionsByHousehold: new Map(), classificationMap: new Map([['g1', 'genuine_customer']]), quarantineRows: [], inventory: { providerNumberCount: 1, monthlyRental: { perNumber: 0.87, currency: 'GBP', basis: 'b', allNumbers: 0.87 }, rows: [{ number: '+1', state: 'in_service', severity: 'info', owner: { householdId: 'g1' } }] }, stripeRevenue: liveStripe, releaseRecordingAvailable: false }, NOW);
  check(clean.cards.find((c) => c.id === 'lifecycle_anomalies').status === 'grey', 'no anomalies but release failures not recorded → grey, not a false green');
  check(clean.overall === 'green' && clean.incomplete === true, 'a clean state is green but flagged incomplete while something cannot be checked');
  const noInv = computeControlOverview({ households: [], entitlementsByHousehold: new Map(), subscriptionsByHousehold: new Map(), classificationMap: new Map(), quarantineRows: [], inventory: null, stripeRevenue: null, releaseRecordingAvailable: false }, NOW);
  check(noInv.cards.find((c) => c.id === 'provider_numbers').status === 'grey' && noInv.cards.find((c) => c.id === 'unmapped_numbers').status === 'grey', 'no provider inventory → grey, never "0 unmapped"');
}

// ============================================================
// 5. Lifecycle timeline (lifecycleTimeline.js)
// ============================================================
{
  const { buildLifecycleTimeline } = require('../services/businessControl/lifecycleTimeline.js');
  const tl = (household, entitlements, subscriptions, quarantineRows = [], onProvider = null) => buildLifecycleTimeline({ household: { id: 'h', email: 'a@b', ...household }, entitlements, subscriptions, classification: 'genuine_customer', quarantineRows, onProvider }, NOW);
  const healthy = tl({ twilio_number: '+1', ...protectedFields }, [ent('paid_subscription', 10 * DAY)], [{ status: 'active', updated_at: ago(DAY) }]);
  check(healthy.steps.map((s) => s.key).join() === 'subscription,entitlement,number,app,delivery,protected' && healthy.firstBroken === null, 'active path: subscription → entitlement → number → app → delivery → protected, nothing broken');
  const noNumber = tl({ twilio_number: null, twilio_provisioning_status: 'failed' }, [ent('complimentary', 3 * DAY)], []);
  check(noNumber.steps[noNumber.firstBroken].key === 'number', 'entitled without a number → first broken step is "HCG number"');
  const cancelledNoRelease = tl({ twilio_number: '+1' }, [ent('paid_subscription', 60 * DAY, { status: 'expired', updated_at: ago(5 * DAY) })], [{ status: 'canceled', updated_at: ago(5 * DAY) }]);
  check(cancelledNoRelease.steps.some((s) => s.key === 'ended' && s.label === 'Cancelled') && cancelledNoRelease.steps[cancelledNoRelease.firstBroken].key === 'release_scheduled', 'cancelled, still holding a number, no release → broken at "Release scheduled"');
  const overdue = tl({ twilio_number: '+1', twilio_number_pending_release_at: ago(3 * DAY) }, [ent('complimentary', 60 * DAY, { ends_at: ago(20 * DAY) })], []);
  check(overdue.steps[overdue.firstBroken].key === 'quarantined', 'release date passed >48h and number not quarantined → broken at "Quarantined"');
  const fullRelease = tl({ twilio_number: null }, [ent('complimentary', 90 * DAY, { ends_at: ago(40 * DAY) })], [], [{ twilio_number: '+1', quarantined_at: ago(30 * DAY), release_reason: 'subscription_grace_expired', deactivation_confirmed: true, deactivation_confirmed_at: ago(20 * DAY), released_at: ago(19 * DAY) }], false);
  check(fullRelease.steps.map((s) => s.key).join() === 'subscription,entitlement,ended,protection_ends,release_scheduled,quarantined,confirmed,released,gone_from_provider' && fullRelease.firstBroken === null, 'cancellation path to "Gone from Twilio" with nothing broken');
  const stillBilled = tl({ twilio_number: null }, [ent('complimentary', 90 * DAY, { ends_at: ago(40 * DAY) })], [], [{ twilio_number: '+1', quarantined_at: ago(30 * DAY), deactivation_confirmed: true, deactivation_confirmed_at: ago(20 * DAY), released_at: ago(19 * DAY) }], true);
  check(stillBilled.steps[stillBilled.firstBroken].key === 'gone_from_provider', 'recorded released but still on Twilio → broken at "Gone from Twilio"');
  const entitledRelease = tl({ twilio_number: '+1', twilio_number_pending_release_at: ago(-3 * DAY) }, [ent('paid_subscription', 10 * DAY)], []);
  check(entitledRelease.steps[entitledRelease.firstBroken].key === 'release_while_entitled', 'release scheduled while entitled → broken (the #8 incident)');
  const never = tl({ twilio_number: '+1' }, [], []);
  check(never.steps[never.firstBroken].key === 'number_without_membership', 'number held without any membership → broken');
  const unknownProvider = tl({ twilio_number: null }, [ent('complimentary', 90 * DAY, { ends_at: ago(40 * DAY) })], [], [{ twilio_number: '+1', quarantined_at: ago(30 * DAY), deactivation_confirmed: true, deactivation_confirmed_at: ago(20 * DAY), released_at: ago(19 * DAY) }], null);
  check(unknownProvider.steps.find((s) => s.key === 'gone_from_provider').state === 'pending', 'provider not checked → "Gone from Twilio" pending, never assumed done');
}

// ============================================================
// 6. Channel comparison (campaignPerformance.js)
// ============================================================
{
  const { computeChannelComparison, comparisonChannel } = require('../services/businessControl/campaignPerformance.js');
  check(comparisonChannel({ utm_source: 'Instagram' }).channel === 'instagram' && comparisonChannel({ referrer_host: 'l.instagram.com' }).channel === 'instagram', 'Instagram from utm_source or referrer');
  check(comparisonChannel({ utm_source: 'tiktok' }).channel === 'tiktok' && comparisonChannel({ referrer_host: 'www.linkedin.com' }).channel === 'linkedin' && comparisonChannel({ referrer_host: 'lnkd.in' }).channel === 'linkedin', 'TikTok and LinkedIn');
  check(comparisonChannel({ utm_source: 'facebook' }).channel === 'facebook' && comparisonChannel({ referrer_host: 'l.facebook.com' }).channel === 'facebook', 'Facebook');
  check(comparisonChannel({ utm_source: 'meta' }).channel === 'other_unknown', '"meta" does not say Facebook or Instagram → Other/unknown, never guessed');
  check(comparisonChannel({}).channel === 'direct' && comparisonChannel({ referrer_host: 'chatgpt.com' }).channel === 'other_unknown', 'no source → Direct; other referrers → Other/unknown');
  const cc = computeChannelComparison([
    { event_type: 'landing_visit', utm_source: 'instagram' }, { event_type: 'registration_completed', utm_source: 'instagram' },
    { event_type: 'landing_visit' }, { event_type: 'landing_visit', referrer_host: 'chatgpt.com' }, { event_type: 'paid_conversion' },
  ]);
  const row = (c) => cc.rows.find((r) => r.channel === c);
  check(cc.rows.map((r) => r.label).join() === 'Instagram,TikTok,Facebook,LinkedIn,Direct,Other / unknown', 'fixed channel set in order');
  check(row('instagram').visits === 1 && row('instagram').registrations === 1 && row('direct').visits === 1 && row('other_unknown').otherDetails['chatgpt.com'] === 1, 'visits and signups per channel; Other/unknown shows what it contains');
  check(cc.rows.every((r) => r.payingCustomers === null && r.revenue === null && r.cac === null), 'paying customers, revenue and CAC per channel are NOT CONNECTED (never 0)');
  check(cc.stageStatus.payingCustomers.status === 'NOT_CONNECTED' && cc.selfReported.status === 'NOT_CAPTURED', 'stage evidence stated; self-report kept separate and marked not captured');
}

// ============================================================
// 7. "0 genuine paying customers" vs Stripe evidence (2026-09-28)
// A customer who paid by Stripe and cancelled days later (the real
// production pattern: paid 6 Sep, cancelled 9 Sep) must not vanish from
// every figure — whether they are classified genuine or not yet
// classified at all.
// ============================================================
{
  const { classifyHouseholdForBusiness } = require('../services/businessControl/definitions.js');
  const { computeControlOverview } = require('../services/businessControl/controlOverview.js');
  const { computeSubscriptionOverview } = require('../services/businessControl/subscriptionOverview.js');
  const { computeRecognisedMrr, computeCollectedRevenue } = require('../services/businessControl/stripeRevenue.js');

  const cancelledPaid = [ent('paid_subscription', 21 * DAY, { status: 'revoked', updated_at: ago(18 * DAY) })];
  const cancelledSub = [{ status: 'canceled', cancel_at_period_end: false, updated_at: ago(18 * DAY) }];

  const b = classifyHouseholdForBusiness({ household: { id: 'p', email: 'p@x' }, entitlements: cancelledPaid, subscriptions: cancelledSub, classification: 'genuine_customer' }, NOW);
  check(b.everPaid && b.formerPaying && !b.isGenuinePayingCustomer && b.membership === 'cancelled' && b.audience === 'genuine' && b.paidSources.join() === 'stripe', 'definitions: a genuine customer who paid then cancelled is a FORMER paying customer (not paying now), with payment history from stripe');
  check(classifyHouseholdForBusiness({ household: { id: 'r', email: 'r@x' }, entitlements: [], subscriptions: [], classification: 'reviewer' }, NOW).audience === 'test', 'definitions: reviewer/test/admin/QA share one "test" audience badge');
  check(classifyHouseholdForBusiness({ household: { id: 'n', email: 'n@x' }, entitlements: [ent('complimentary', DAY)], subscriptions: [], classification: undefined }, NOW).everPaid === false, 'definitions: complimentary access is not payment history');

  const run = (cls) => computeControlOverview({
    households: [{ id: 'p', email: 'payer@x', twilio_number: '+1', twilio_number_pending_release_at: new Date(NOW.getTime() + 12 * DAY).toISOString() }],
    entitlementsByHousehold: new Map([['p', cancelledPaid]]), subscriptionsByHousehold: new Map([['p', cancelledSub]]),
    classificationMap: new Map(cls ? [['p', cls]] : []), quarantineRows: [], inventory: null, stripeRevenue: null, releaseRecordingAvailable: true,
  }, NOW);
  const card = (o, id) => o.cards.find((c) => c.id === id);

  const asGenuine = run('genuine_customer');
  check(card(asGenuine, 'genuine_paying').value === 0 && /1 ever paid · 1 former paying/.test(card(asGenuine, 'genuine_paying').sub) && card(asGenuine, 'genuine_paying').items.some((i) => /former paying · cancelled/.test(i.detail)), 'overview: classified genuine → "0 paying now" AND "1 ever paid · 1 former paying", with the account listed');
  check(card(asGenuine, 'paid_unclassified').value === 0 && card(asGenuine, 'paid_unclassified').status === 'green', 'overview: nothing to classify when the payer is classified');

  const unclassified = run(null);
  check(card(unclassified, 'genuine_paying').value === 0 && /0 ever paid/.test(card(unclassified, 'genuine_paying').sub), 'overview: an unclassified payer is not silently counted as genuine…');
  check(card(unclassified, 'paid_unclassified').value === 1 && card(unclassified, 'paid_unclassified').status === 'amber' && /former paying · cancelled · stripe/.test(card(unclassified, 'paid_unclassified').items[0].detail), '…but is surfaced (amber) as "paid at some point, not classified" instead of vanishing');
  check(unclassified.overall !== 'green', 'overview: an unclassified payer stops the overall status being green');

  const sub = computeSubscriptionOverview({ households: [{ id: 'p', email: 'payer@x' }, { id: 'g', email: 'g@x' }], entitlements: [...cancelledPaid.map((e) => ({ ...e, household_id: 'p' })), { ...cancelledPaid[0], household_id: 'g' }], subscriptions: [], classificationMap: new Map([['g', 'genuine_customer']]) }, NOW);
  check(sub.counts.paymentHistory.unclassifiedEverPaid === 1 && sub.counts.paymentHistory.genuineEverPaid === 1 && sub.counts.paymentHistory.genuineFormerPaying === 1, 'subscriptions: payment history counted per class (1 genuine former payer, 1 unclassified payer)');
  check(sub.needsClassification.length === 1 && sub.needsClassification[0].householdId === 'p' && /paid before/.test(sub.needsClassification[0].reason), 'subscriptions: a former payer with no access still appears in "needs classification", with the reason');

  // Stripe: live payments from unclassified / unknown customers are
  // reported as UNATTRIBUTED, never silently dropped; explicit test
  // accounts are merely excluded.
  const genuineByCustomer = new Map([['cus_g', 'g']]);
  const classByCustomer = new Map([['cus_g', 'genuine'], ['cus_u', 'unclassified'], ['cus_r', 'reviewer']]);
  const price = { unit_amount: 499, currency: 'gbp', recurring: { interval: 'month', interval_count: 1 } };
  const subs = ['cus_g', 'cus_u', 'cus_r', 'cus_nohousehold'].map((customer) => ({ customer, status: 'active', livemode: true, items: { data: [{ price, quantity: 1 }] } }));
  const mrr = computeRecognisedMrr(subs, genuineByCustomer, classByCustomer);
  check(mrr.genuine.GBP === 4.99 && mrr.excludedSubscriptions === 3 && mrr.unattributedSubscriptions === 2 && mrr.unattributed.GBP === 9.98, 'stripe MRR: 1 genuine; of 3 excluded, 2 (unclassified + no household) are UNATTRIBUTED; the reviewer is only excluded');
  const charges = ['cus_g', 'cus_u', 'cus_r'].map((customer) => ({ customer, paid: true, status: 'succeeded', amount: 499, amount_refunded: 0, currency: 'gbp', livemode: true }));
  const col = computeCollectedRevenue(charges, genuineByCustomer, classByCustomer);
  check(col.genuine.GBP === 4.99 && col.unattributedCharges === 1 && col.unattributed.GBP === 4.99, 'stripe collected: the unclassified customer\'s live payment is reported as unattributed');
  check(computeRecognisedMrr(subs, genuineByCustomer).unattributedSubscriptions === 0, 'stripe: without a class map (older callers) nothing is guessed as unattributed');

  const overviewLive = computeControlOverview({ households: [], entitlementsByHousehold: new Map(), subscriptionsByHousehold: new Map(), classificationMap: new Map(), quarantineRows: [], inventory: null,
    stripeRevenue: { available: true, mode: 'live', mrr: { ...mrr, genuineExVat: { GBP: 4.16 } }, collectedThisMonth: col }, releaseRecordingAvailable: true }, NOW);
  const mrrCard = overviewLive.cards.find((c) => c.id === 'mrr');
  check(mrrCard.status === 'amber' && /UNATTRIBUTED: 2 subscription\(s\)/.test(mrrCard.sub) && /1 payment\(s\) £4\.99 this month/.test(mrrCard.sub), 'overview MRR card: amber, and states the unattributed live subscriptions and payments');
}

// ============================================================
// 8. Number categories, masking, cost-leak summary (2026-09-29)
// Shaped like the 27 Sep production inventory: 19 numbers — genuine
// customer, cancelled customer in grace, reviewers, internal tests,
// an unclassified holder, 7 staging (dev tunnel), 2 quarantined, 1 orphan.
// ============================================================
{
  const { buildNumberInventory, maskNumber, categoriseInventoryRow, CATEGORIES } = require('../services/businessControl/numberInventory.js');
  const V = 'https://www.homecallguard.co.uk/voice';
  const DEV = 'https://ferret-example.ngrok-free.dev/voice';
  const n = (i) => `+4470000001${String(i).padStart(2, '0')}`;
  const hh = [
    { id: 'gen', email: 'g@x', twilio_number: n(1) },
    { id: 'can', email: 'c@x', twilio_number: n(2), twilio_number_pending_release_at: new Date(NOW.getTime() + 10 * DAY).toISOString() },
    { id: 'rev1', email: 'r1@x', twilio_number: n(3) },
    { id: 'rev2', email: 'r2@x', twilio_number: n(4) },
    { id: 'tst1', email: 't1@x', twilio_number: n(5) },
    { id: 'tst2', email: 't2@x', twilio_number: n(6) },
    { id: 'qa', email: 'qa@x', twilio_number: n(7) },
    { id: 'unc', email: 'u@x', twilio_number: n(8) },
    { id: 'due', email: 'd@x', twilio_number: n(9), twilio_number_pending_release_at: ago(3 * DAY) },
  ];
  const entsBy = new Map([
    ['gen', [ent('paid_subscription', 20 * DAY)]],
    ['can', [ent('paid_subscription', 40 * DAY, { status: 'revoked', updated_at: ago(20 * DAY) })]],
    ['rev1', [ent('complimentary', 20 * DAY)]], ['rev2', [ent('complimentary', 20 * DAY)]],
    ['tst1', [ent('complimentary', 20 * DAY)]], ['tst2', [ent('complimentary', 20 * DAY)]],
    ['qa', []], ['unc', [ent('complimentary', 5 * DAY)]], ['due', []],
  ]);
  const cls = new Map([['gen', 'genuine_customer'], ['can', 'genuine_customer'], ['rev1', 'reviewer'], ['rev2', 'reviewer'], ['tst1', 'internal_test'], ['tst2', 'internal_test'], ['qa', 'qa_automation'], ['due', 'genuine_customer']]);
  const provider = [
    ...hh.map((h, i) => ({ phoneNumber: h.twilio_number, sid: `PN${i}`, voiceUrl: V, dateCreated: ago(60 * DAY) })),
    ...[10, 11, 12, 13, 14, 15, 16].map((i) => ({ phoneNumber: n(i), sid: `PNstg${i}`, voiceUrl: DEV, dateCreated: ago(40 * DAY) })),
    { phoneNumber: n(17), sid: 'PNq1', voiceUrl: V }, { phoneNumber: n(18), sid: 'PNq2', voiceUrl: V },
    { phoneNumber: n(19), sid: 'PNorphan', voiceUrl: null },
  ];
  const quarantine = [
    { household_id: null, twilio_number: n(17), deactivation_confirmed: false, quarantined_at: ago(20 * DAY), released_at: null, release_reason: 'account_deletion' },
    { household_id: null, twilio_number: n(18), deactivation_confirmed: false, quarantined_at: ago(6 * DAY), released_at: null, release_reason: 'subscription_grace_expired' },
  ];
  const inv = buildNumberInventory({ providerNumbers: provider, households: hh, entitlementsByHousehold: entsBy, subscriptionsByHousehold: new Map(), classificationMap: cls, quarantineRows: quarantine, productionHosts: prodHosts,
    rental: { perNumber: 0.86917, currency: 'GBP', basis: 't', provenance: 'ACTUAL' }, releaseRecordingAvailable: false,
    lastCallByHousehold: new Map([['gen', ago(2 * HOUR)], ['can', ago(25 * DAY)]]) }, NOW);
  const cat = Object.fromEntries(inv.byCategory.map((c) => [c.category, c]));
  check(inv.providerNumberCount === 19 && inv.byCategory.reduce((sum, c) => sum + c.count, 0) === 19, 'every billed number lands in exactly one category (19/19)');
  check(cat.customer_active.count === 1 && cat.customer_cancelled_grace.count === 1 && cat.reviewer.count === 2 && cat.internal_test.count === 3 && cat.staging.count === 7 && cat.pending_release.count === 3 && cat.orphan.count === 1 && cat.unknown.count === 1 && cat.other.count === 0,
    'categories: 1 active customer · 1 cancelled in grace · 2 reviewer · 3 internal test (test+QA) · 7 staging · 3 pending release (1 overdue + 2 quarantined) · 1 orphan · 1 unknown (unclassified holder — never guessed)');
  check(cat.staging.monthlyCost === 6.08 && cat.orphan.monthlyCost === 0.87, 'category rental: staging £6.08/month (7 × £0.869), orphan £0.87');
  check(inv.needsReview.count === 14 && inv.needsReview.monthlyCost === 12.17, 'needs review: 14 numbers ≈ £12.17/month (staging, orphan, pending release, internal test) — reviewer/customer/unknown not counted as avoidable');
  check(inv.rows.every((r) => r.number === null || /^\+44 •••• ••\d{4}$/.test(r.number)) && !JSON.stringify(inv).includes('+447000000'), 'no full number anywhere in the inventory output — masked to the last four digits');
  check(inv.rows.filter((r) => r.state !== 'missing_at_provider').every((r) => r.sid), 'every billed row carries the provider SID for lookup');
  const row = (sid) => inv.rows.find((r) => r.sid === sid);
  check(row('PN0').lastInboundCall.at === ago(2 * HOUR) && row('PN1').lastInboundCall.at === ago(25 * DAY) && /no call recorded/.test(row('PN6').lastInboundCall.source), 'last inbound call from HCG\'s records per household; "no call recorded" when none');
  check(row('PNstg10').lastInboundCall.at === null && /provider call log/.test(row('PNstg10').lastInboundCall.source) && /provider call log/.test(row('PNorphan').lastInboundCall.source), 'staging/orphan numbers: last call is "not in HCG records — check the provider call log", never "never"');
  check(row('PN1').pendingReleaseAt && row('PNq1').quarantinedAt && row('PN0').createdAt, 'pending-release date, quarantine date and acquisition date exposed where they exist');
  check(inv.rows.every((r) => r.recommendations.length > 0), 'every number has a recommended investigation/next step');
  check(categoriseInventoryRow({ state: 'in_service', owner: null }) === 'unknown' && categoriseInventoryRow({ state: 'in_service', owner: { accountClass: 'deleted' } }) === 'other', 'insufficient evidence → unknown / other, never a customer');
  check(maskNumber('+447700900123') === '+44 •••• ••0123' && maskNumber('123') === '••••' && maskNumber(null) === null, 'maskNumber');
  check(Object.keys(CATEGORIES).join() === 'customer_active,customer_cancelled_grace,pending_release,internal_test,staging,reviewer,orphan,unknown,other', 'the category set');
  check(!/\.(remove|update|create)\(/.test(readFileSync(path.join(__dirname, '..', 'services', 'businessControl', 'numberInventory.js'), 'utf8')), 'the inventory module has no provider write call');
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All business control centre checks passed.');
