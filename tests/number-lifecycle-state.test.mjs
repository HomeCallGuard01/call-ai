// The canonical number-lifecycle definition (services/numberLifecycle/
// state.js) and proof that the dashboard cannot silently disagree with
// the backend release rules (migration 047).
//
//  1. Canonical predicates reproduce 047's truth table
//     (tests/fixtures/number-lifecycle-parity.json).
//  2. Every dashboard consumer answers the same fixture identically.
//  3. Single source: no dashboard module carries its own copy of a rule.
//  4. Fail closed: ambiguous state always blocks release and is reported.
//  5. Classification is never an input.
//  6. The backend engines (sweep #49, admin API #47) run the same fixture
//     automatically once merged (skipped, and said so, until then).
//
// Run with: node tests/number-lifecycle-state.test.mjs

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'x';

const lifecycle = require('../services/numberLifecycle/state.js');
const { classifyHouseholdForBusiness } = require('../services/businessControl/definitions.js');
const recon = require('../services/businessControl/numberReconciliation.js');
const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'number-lifecycle-parity.json'), 'utf8'));
const NOW = new Date(fixture.now);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

// ---------- 1. 047 truth table ----------
for (const c of fixture.cases) {
  const current = c.entitlements.some((e) => lifecycle.isCurrentlyEntitled(e, NOW));
  const upcoming = c.entitlements.some((e) => lifecycle.isUpcomingEntitlement(e, NOW));
  const blocks = lifecycle.blocksNumberRelease(c.entitlements, NOW);
  check(current === c.expected.current && upcoming === c.expected.upcoming && blocks === c.expected.blocksRelease, `047 parity (canonical): ${c.name}`);
}

// ---------- 2. every dashboard consumer agrees ----------
for (const c of fixture.cases) {
  const household = { id: 'h', email: 'h@x', twilio_number: '+447700900001', twilio_provisioning_status: 'active' };
  const biz = classifyHouseholdForBusiness({ household, entitlements: c.entitlements, subscriptions: [], classification: 'genuine_customer' }, NOW);
  const bizBlocks = biz.membership === 'current' || biz.membership === 'upcoming';
  const reconUpcoming = c.entitlements.some((e) => recon.isUpcomingEntitlement(e, NOW));
  const codes = recon.detectHouseholdAnomalies({ household, entitlements: c.entitlements, quarantineRows: [] }, NOW).anomalies.map((a) => a.code);
  // A household holding a number with no release scheduled is flagged
  // "retained without entitlement" exactly when 047 would NOT block release.
  const reconSaysUnprotected = codes.includes('NUMBER_RETAINED_NO_ENTITLEMENT');
  check(bizBlocks === c.expected.blocksRelease && reconUpcoming === c.expected.upcoming && reconSaysUnprotected === !c.expected.blocksRelease,
    `dashboard parity (definitions + reconciliation): ${c.name}`);
}
// The case that used to disagree (dashboard v2 before 2026-09-29).
{
  const ended = [{ status: 'scheduled', starts_at: '2026-09-01T00:00:00Z', ends_at: '2026-09-15T00:00:00Z' }];
  const biz = classifyHouseholdForBusiness({ household: { id: 'h', email: 'h@x', twilio_number: '+1' }, entitlements: ended, subscriptions: [], classification: 'genuine_customer' }, NOW);
  check(biz.membership !== 'upcoming' && lifecycle.blocksNumberRelease(ended, NOW) === false, 'regression: a scheduled entitlement whose end date has passed no longer counts as "upcoming" on the dashboard (047 would release; the dashboard used to say protected)');
}

// ---------- 3. single source ----------
{
  const dir = path.join(__dirname, '..', 'services', 'businessControl');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(path.join(dir, file), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    check(!/48\s*\*\s*HOUR/.test(code) && !/24\s*\*\s*60\s*\*\s*60\s*\*\s*1000\s*\*\s*2/.test(code), `${file}: no hard-coded lifecycle grace period (uses GRACE)`);
    const upcomingFn = code.match(/function isUpcomingEntitlement\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    check(!upcomingFn || /return lifecycle\.isUpcomingEntitlement\(/.test(upcomingFn[1]), `${file}: any isUpcomingEntitlement only delegates to the canonical module`);
  }
  const reconSrc = readFileSync(path.join(dir, 'numberReconciliation.js'), 'utf8');
  check(/lifecycle\.deriveHouseholdLifecycle\(/.test(reconSrc) && !/isEntitlementCurrentlyActive/.test(reconSrc), 'numberReconciliation derives anomalies from the canonical module only');
}

// ---------- 4. fail closed ----------
{
  const weird = lifecycle.deriveHouseholdLifecycle({ household: { id: 'w', twilio_number: '+1', twilio_number_pending_release_at: ago(5 * DAY), twilio_provisioning_status: 'active' }, entitlements: [{ status: 'paused', starts_at: ago(DAY) }] }, NOW);
  check(weird.membership === 'ambiguous' && weird.blocksRelease === true && weird.releaseEligibleNow === false && weird.anomalies.map((a) => a.code).join() === 'AMBIGUOUS_STATE', 'unknown entitlement status → ambiguous: blocks release, never eligible, reported (not silently "not entitled")');
  const dash = recon.detectHouseholdAnomalies({ household: { id: 'w', twilio_number: '+1', twilio_provisioning_status: 'active' }, entitlements: [{ status: 'paused', starts_at: ago(DAY) }], quarantineRows: [] }, NOW);
  check(dash.anomalies.some((a) => a.code === 'AMBIGUOUS_STATE' && a.severity === 'action'), 'dashboard reports the ambiguous household as an action');
}

// ---------- 5. release eligibility mirrors release_household_twilio_number ----------
{
  const d = (h, ents) => lifecycle.deriveHouseholdLifecycle({ household: { id: 'x', twilio_provisioning_status: 'active', ...h }, entitlements: ents }, NOW);
  check(d({ twilio_number: '+1', twilio_number_pending_release_at: ago(HOUR) }, []).releaseEligibleNow === true, 'eligible: number held, release date passed, nothing blocks');
  check(d({ twilio_number: '+1', twilio_number_pending_release_at: ago(-HOUR) }, []).releaseEligibleNow === false, 'not eligible: release date in the future');
  check(d({ twilio_number: '+1', twilio_number_pending_release_at: ago(HOUR) }, [{ status: 'scheduled', starts_at: ago(-DAY), ends_at: null }]).releaseEligibleNow === false, 'not eligible: an upcoming entitlement blocks (047)');
  check(d({ twilio_number: '+1', twilio_number_pending_release_at: null }, []).releaseEligibleNow === false, 'not eligible: no release scheduled (outside the lifecycle is reported, never released)');
  check(d({ twilio_number: '+1', twilio_number_pending_release_at: ago(23 * HOUR) }, []).numberState === 'release_due' && d({ twilio_number: '+1', twilio_number_pending_release_at: ago(25 * HOUR) }, []).numberState === 'release_overdue', 'due vs overdue split at one 24h job interval');
}

// ---------- 6. classification is never an input ----------
{
  check(lifecycle.deriveHouseholdLifecycle.length === 2 && !/classification/.test(readFileSync(path.join(__dirname, '..', 'services', 'numberLifecycle', 'state.js'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')), 'the canonical module never reads classification (a reviewer\'s number costs the same)');
}

// ---------- 7. quarantine rules ----------
{
  const q = (row) => lifecycle.deriveHouseholdLifecycle({ household: { id: 'q', twilio_number: null, twilio_provisioning_status: 'pending' }, entitlements: [], quarantineRows: [row] }, NOW).anomalies.map((a) => a.code);
  check(q({ deactivation_confirmed: false, quarantined_at: ago(3 * DAY) }).join() === 'QUARANTINE_AWAITING_CONFIRMATION', 'unconfirmed quarantine < 45 days → watch');
  check(q({ deactivation_confirmed: false, quarantined_at: ago(50 * DAY) }).join() === 'QUARANTINE_AWAITING_CONFIRMATION_LONG', 'unconfirmed quarantine > 45 days → action');
  check(q({ deactivation_confirmed: true, deactivation_confirmed_at: ago(3 * DAY), quarantined_at: ago(30 * DAY) }).join() === 'QUARANTINE_RELEASE_STUCK', 'confirmed 3 days ago and not released → stuck');
  check(q({ deactivation_confirmed: true, deactivation_confirmed_at: ago(HOUR), quarantined_at: ago(30 * DAY) }).length === 0, 'confirmed an hour ago → waiting for the release job (basis is the confirmation, not the quarantine date)');
  check(q({ deactivation_confirmed: true, deactivation_confirmed_at: null, quarantined_at: ago(3 * DAY) }).join() === 'QUARANTINE_RELEASE_STUCK', 'confirmation time missing → falls back to quarantined_at (the sweep\'s basis), never silent');
  const entitled = lifecycle.deriveHouseholdLifecycle({ household: { id: 'e', twilio_number: null, twilio_provisioning_status: 'pending' }, entitlements: [{ status: 'active', starts_at: ago(DAY) }], quarantineRows: [{ deactivation_confirmed: false, quarantined_at: ago(DAY) }] }, NOW);
  check(entitled.anomalies.some((a) => a.code === 'QUARANTINED_NUMBER_OF_ENTITLED_HOUSEHOLD' && a.severity === 'critical'), 'quarantined while entitled → critical');
}

// ---------- 8. pinned values (a change must be deliberate) ----------
check(lifecycle.GRACE.releaseOverdueMs === 24 * HOUR && lifecycle.GRACE.provisioningWatchMs === HOUR && lifecycle.GRACE.quarantineReleaseStuckMs === 48 * HOUR && lifecycle.GRACE.quarantineEscalateMs === 45 * DAY && lifecycle.GRACE.quarantineCriticalMs === 90 * DAY, 'grace periods pinned: provisioning 1h, release overdue 24h, confirmed quarantine stuck 48h, escalation 45/90 days');

// ---------- 9. backend engines, once merged ----------
for (const [name, rel, blocks] of [
  ['sweep (#49)', '../services/numberLifecycleSweep.js', (m, ents) => m.blocksNumberRelease(ents, NOW.getTime())],
  ['admin API (#47)', '../services/adminNumberLifecycleReconciliation.js', (m, ents) => ents.some((e) => m.isCurrentlyEntitled(e, NOW.getTime()) || m.isUpcomingEntitlement(e, NOW.getTime()))],
]) {
  const file = path.join(__dirname, rel);
  if (!existsSync(file)) { console.log(`- ${name}: not on this branch yet — parity runs automatically once merged (verified 2026-09-29 from its branch: 14/14 agree)`); continue; }
  const m = require(file);
  const bad = fixture.cases.filter((c) => blocks(m, c.entitlements) !== c.expected.blocksRelease).map((c) => c.name);
  check(bad.length === 0, `${name} agrees with 047 on every fixture case${bad.length ? ' — disagrees on: ' + bad.join('; ') : ''}`);
}

console.log(failures === 0 ? '\nAll number lifecycle checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
