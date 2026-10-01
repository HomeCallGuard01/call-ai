// Tests for Operations → Usage & cost safety (2026-10-01):
//   services/businessControl/usageSafety.js (pure) and its UI renderer.
// Covers: minutes never manufactured from missing data, concurrency
// estimate, unusual-usage rules matching the live alert thresholds,
// recorded-failure signals, the "limits in this build" statements (pinned
// against the code they describe), Overview attention wiring, escaping.
//
// Run with: node tests/usage-safety.test.mjs

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

const {
  summariseMinutes, peakConcurrency, findRepeatCallerBursts, describeControls, computeUsageSafety, summariseForOverview, maskCaller,
} = require('../services/businessControl/usageSafety.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date('2026-09-20T15:00:00.000Z');
const at = (ms) => new Date(NOW.getTime() - ms).toISOString();
let seq = 0;
const call = (o) => ({
  household_id: 'h1', created_at: at(HOUR), number: '+447700900' + String(100 + (seq++ % 800)), status: 'Known', result: 'SAFE',
  duration_seconds: 60, monitored_duration_seconds: null, monitoring_limit_reached: false, dial_call_status: 'completed',
  terminated_by_system: false, warning_sent: false, ...o,
});

// ---------- 1. minutes: measured only, gaps counted ----------
{
  const m = summariseMinutes([
    call({ status: 'Known', duration_seconds: 120 }),
    call({ status: 'Unknown', duration_seconds: 300, monitored_duration_seconds: 240 }),
    call({ status: 'Unknown', duration_seconds: null, monitored_duration_seconds: null, dial_call_status: null }),
    call({ status: 'Unknown', result: 'SCAM', duration_seconds: null, monitored_duration_seconds: null, dial_call_status: null }),
  ]);
  check(m.callMinutes === 7 && m.trustedCallMinutes === 2 && m.unknownCallMinutes === 5, 'call minutes split trusted / unknown from duration_seconds');
  check(m.monitoredMinutes === 4, 'monitored minutes come from monitored_duration_seconds only');
  check(m.callsWithoutDuration === 1, 'an approved call with no duration is counted as unmeasured; a blocked (SCAM) call is not a gap');
  check(m.unknownCallsWithoutMonitoringRecord === 2, 'unknown calls with no monitoring record are counted, not treated as 0 min');
  const empty = summariseMinutes([]);
  check(empty.calls === 0 && empty.monitoredMinutes === 0 && empty.callsWithoutDuration === 0, 'no calls → zero calls (a real zero, not a missing source)');
}

// ---------- 2. concurrency estimate ----------
{
  const t0 = NOW.getTime() - 2 * HOUR;
  const iso = (ms) => new Date(ms).toISOString();
  const p = peakConcurrency([
    { created_at: iso(t0), duration_seconds: 600 },
    { created_at: iso(t0 + 5 * MIN), duration_seconds: 600 },
    { created_at: iso(t0 + 8 * MIN), duration_seconds: 60 },
    { created_at: iso(t0 + 10 * MIN), duration_seconds: 60 }, // starts exactly when #1 ends
    { created_at: iso(t0), duration_seconds: null },
  ], 'duration_seconds');
  check(p.peak === 3 && p.peakAt === iso(t0 + 8 * MIN), 'peak simultaneous calls found by sweep (3 at the third start)');
  check(p.intervalsWithoutLength === 1, 'calls without a duration are excluded and counted (peak is a lower bound)');
  check(peakConcurrency([{ created_at: iso(t0), duration_seconds: 60 }, { created_at: iso(t0 + MIN), duration_seconds: 60 }], 'duration_seconds').peak === 1, 'back-to-back calls are not overlap');
}

// ---------- 3. repeat-caller rule = live alert rule ----------
{
  const c = (minsAgo, number = '+447700900123', hh = 'h1') => ({ household_id: hh, number, created_at: at(minsAgo * MIN) });
  const bursts = findRepeatCallerBursts([c(30), c(25), c(22), c(200), c(5, '07700 900123'), c(30, '+447700900999'), c(29, '+447700900123', 'h2')], { windowMs: 10 * MIN, threshold: 3 });
  check(bursts.length === 1 && bursts[0].householdId === 'h1' && bursts[0].callsInWindow === 3 && bursts[0].totalCalls === 5, '3 calls from one caller within 10 min → one burst; national/international formats normalised');
  check(bursts[0].caller === '•••123' && !JSON.stringify(bursts).includes('7700900'), 'caller numbers are masked to the last 3 digits');
  check(findRepeatCallerBursts([c(30), c(15), c(1)], { windowMs: 10 * MIN, threshold: 3 }).length === 0, 'calls spread wider than the window are not a burst');
  check(maskCaller(null) === '•••', 'a missing number masks safely');
}

// ---------- 4. full computation ----------
{
  const classificationMap = new Map([['h1', 'genuine_customer'], ['h2', 'internal_test']]);
  const households = [{ id: 'h1', email: 'one@example.com' }, { id: 'h2', email: 'two@example.com' }, { id: 'h3', email: 'three@example.com' }];
  const calls = [
    // h1: a normal week of ~5 monitored min/day …
    ...[1, 2, 3, 4, 5, 6, 7].map((d) => call({ household_id: 'h1', status: 'Unknown', created_at: at(d * DAY), duration_seconds: 300, monitored_duration_seconds: 300 })),
    // … then 45 monitored min today (spike), one call hitting the cap
    call({ household_id: 'h1', status: 'Unknown', created_at: at(2 * HOUR), duration_seconds: 1800, monitored_duration_seconds: 1800, monitoring_limit_reached: true }),
    call({ household_id: 'h1', status: 'Unknown', created_at: at(1 * HOUR), duration_seconds: 900, monitored_duration_seconds: 900, warning_sent: true }),
    // h2: 20 unknown calls on one day (daily threshold) + a 70-minute trusted call
    ...Array.from({ length: 20 }, (_, i) => call({ household_id: 'h2', status: 'Unknown', created_at: at(3 * DAY + i * 20 * MIN), duration_seconds: 30, monitored_duration_seconds: 30 })),
    call({ household_id: 'h2', status: 'Known', created_at: at(5 * HOUR), duration_seconds: 70 * 60 }),
    // h3: failures
    call({ household_id: 'h3', created_at: at(4 * HOUR), dial_call_status: 'failed', duration_seconds: 0 }),
    call({ household_id: 'h3', created_at: at(5 * HOUR), dial_call_status: null, duration_seconds: null }),
    call({ household_id: 'h3', created_at: at(30 * MIN), dial_call_status: null, duration_seconds: null }), // within grace
    call({ household_id: 'h3', status: 'Unknown', created_at: at(6 * HOUR), dial_call_status: 'completed', duration_seconds: 200, monitored_duration_seconds: null }),
    call({ household_id: 'h3', status: 'Unknown', created_at: at(26 * HOUR), terminated_by_system: true, duration_seconds: 90, monitored_duration_seconds: 90, dial_call_status: null }),
    call({ household_id: 'h3', created_at: at(8 * HOUR), dial_call_status: 'no-answer', duration_seconds: 0 }),
    // last month: excluded from MTD
    call({ household_id: 'h1', created_at: '2026-08-31T23:00:00.000Z', dial_call_status: 'failed' }),
  ];
  const r = computeUsageSafety({ calls, households, classificationMap, env: {} }, NOW);
  const sig = (id) => r.signals.find((s) => s.id === id);

  check(r.available && r.timezone === 'UTC' && r.series.length === 14 && r.series[13].partial, '14-day UTC series, today marked partial');
  check(r.windows.today.monitoredMinutes === 45 && r.windows.today.monitoringLimitReached === 1 && r.windows.today.warningSmsSent === 1, 'today: 45 monitored min, 1 cap hit, 1 warning SMS');
  check(r.windows.last7Days.monitoredMinutes === 7 * 5 + 10 + 1.5, 'previous 7 days excludes today (h1 7 × 5 min + h2 20 × 0.5 min + h3 1.5 min)');
  check(r.windows.monthToDate.calls === calls.length - 1, 'month to date excludes last month');
  check(sig('usage_spike').severity === 'amber' && sig('usage_spike').items.some((i) => i.householdId === 'h1' && /45 monitored min today/.test(i.detail)), 'spike: household 9× its own daily average flagged, with numbers');
  check(sig('usage_spike').items.some((i) => i.label === 'Whole service'), 'spike: whole-service rule also evaluated');
  check(sig('rapid_daily').items.length === 1 && sig('rapid_daily').items[0].householdId === 'h2' && sig('rapid_daily').items[0].accountClass === 'internal_test', 'daily threshold (20) flags h2, badged as internal test (not hidden)');
  check(sig('monitoring_cap').count === 1, 'per-call monitoring limit hits listed');
  check(sig('long_calls').count === 1 && /70 min · trusted contact/.test(sig('long_calls').items[0].detail), 'calls ≥ 60 min listed (trusted calls included — they bill inbound minutes too)');
  check(sig('delivery_failed').severity === 'red' && sig('delivery_failed').count === 1, 'failed delivery = red; last month\'s and no-answer are not counted');
  check(sig('outcome_not_recorded').count === 1, 'approved call with no outcome after 2h flagged; one inside the grace period is not');
  check(sig('monitoring_not_recorded').count === 1, 'connected unknown call with no monitoring record flagged');
  check(sig('terminated').severity === 'info' && sig('terminated').count === 1, 'HCG terminations are a count, not a fault');
  check(r.overall === 'red' && r.signals[0].severity === 'red', 'overall = worst signal; red sorted first');

  const h1 = r.households.find((h) => h.householdId === 'h1');
  check(r.households[0].householdId === 'h1' && h1.label === 'one@example.com' && h1.accountClass === 'genuine', 'households ranked by monitored minutes, labelled and classified');
  check(h1.baselineDailyMonitoredMinutes === 5 && h1.today.monitoredMinutes === 45, 'per-household trailing baseline and today');
  check(h1.peakConcurrentCalls === 1 && r.concurrency.streamCap === 200, 'per-household peak concurrency and the configured stream cap');
  check(r.households.find((h) => h.householdId === 'h3').accountClass === 'unclassified', 'unclassified households stay unclassified');

  const quiet = computeUsageSafety({ calls: [], env: {} }, NOW);
  check(quiet.overall === 'green' && quiet.signals.every((s) => s.count === 0) && quiet.households.length === 0, 'no calls → every signal green/zero');

  const summary = summariseForOverview(r);
  check(summary.available && summary.signals.every((s) => s.severity === 'red' || s.severity === 'amber') && !summary.signals.some((s) => s.id === 'terminated'), 'Overview summary carries only red/amber signals');
  check(summariseForOverview({ available: false, reason: 'db down' }).reason === 'db down', 'Overview summary passes an unavailable reason through');
}

// ---------- 5. "limits in this build" are pinned to the code ----------
{
  const root = path.join(__dirname, '..');
  const server = readFileSync(path.join(root, 'server.js'), 'utf8');
  const controls = describeControls({ env: {}, present: () => false });
  const byId = Object.fromEntries(controls.map((c) => [c.id, c]));
  check(!/timeLimit/.test(server) && byId.call_length.mode === 'provider_default', 'server.js sets no <Dial> timeLimit → stated as Twilio\'s 4-hour default (update usageSafety.js if this changes)');
  check(byId.monitoring_per_call.mode === 'enforced' && byId.monitoring_per_call.limit === '30 min', 'per-call monitoring limit: enforced, 30 min default');
  check(describeControls({ env: { MONITORING_MAX_DURATION_MINUTES: '20' }, present: () => false }).find((c) => c.id === 'monitoring_per_call').limit === '20 min', 'monitoring limit follows MONITORING_MAX_DURATION_MINUTES');
  check(byId.streams_concurrent_global.limit === '200' && /NOT recorded/.test(byId.streams_concurrent_global.evidence), 'whole-server stream cap 200, refusals stated as not recorded');
  const handler = readFileSync(path.join(root, 'services', 'liveMonitoring', 'mediaStreamHandler.js'), 'utf8');
  check(/streams\.size >= maxConcurrentStreams/.test(handler) && /hasReachedDurationThreshold/.test(handler), 'both "enforced" limits are actually enforced in mediaStreamHandler.js');
  check(byId.rapid_daily.mode === 'alert_only' && byId.rapid_repeat.mode === 'alert_only' && byId.fair_use.mode === 'visibility_only', 'rapid-abuse alerts and fair use are not described as limits');
  for (const id of ['household_streams', 'household_allowance', 'household_concurrency', 'spend_ceilings', 'sms_budget']) {
    check(byId[id].mode === 'not_in_build', `${id}: not in this build (stated, not hidden)`);
  }
  const live = describeControls({ env: {}, present: (rel) => require('node:fs').existsSync(path.join(root, rel)) });
  check(live.filter((c) => c.mode === 'not_in_build').length === 5, 'this branch really has none of the other branches\' limit modules');
  const landed = describeControls({ env: {}, present: (rel) => rel.endsWith('callAdmission.js') });
  check(landed.find((c) => c.id === 'spend_ceilings').mode === 'present_unverified', 'a limit module that lands is reported "code present — verify", never assumed enabled');
}

// ---------- 6. UI renderer + Overview attention ----------
{
  const html = readFileSync(path.join(__dirname, '..', 'admin-business.html'), 'utf8');
  const x = (name) => { const a = html.indexOf(`// TEST-EXTRACT-START: ${name}`); const b = html.indexOf(`// TEST-EXTRACT-END: ${name}`); return html.slice(a, b); };
  const doc = { getElementById: () => ({ innerHTML: '' }) };
  const ui = new Function('document', 'fetch', 'window', 'fmtNum', `${x('customerMonitorHelpers')}\n${x('fmtDateTime')}\n${x('businessControlTabs')}\nreturn { renderUsageSafetyHtml, TAB_SECTIONS, BUSINESS_CONTROL_TABS };`)(doc, async () => ({}), {}, (n) => (n === null || n === undefined ? '—' : String(n)));
  check(ui.TAB_SECTIONS.operations.includes('usageSafety') && ui.BUSINESS_CONTROL_TABS.includes('usageSafety'), 'Operations tab loads the usage-safety section');
  check(html.includes('<div id="usageSafety"></div>'), 'Operations panel has the usage-safety container');

  const evil = '"><img src=x onerror=alert(1)>';
  const r = computeUsageSafety({
    calls: [call({ household_id: 'hx', status: 'Unknown', created_at: at(3 * HOUR), duration_seconds: 4000, monitored_duration_seconds: 1800, monitoring_limit_reached: true, dial_call_status: 'failed' })],
    households: [{ id: 'hx', email: evil }], classificationMap: new Map([['hx', evil]]), env: {},
  }, NOW);
  const out = ui.renderUsageSafetyHtml(r);
  check(!out.includes('<img') && out.includes('&lt;img'), 'every data-derived string (email, class, detail) is escaped');
  check(out.includes('Limits in this build') && out.includes('Not in this build') && out.includes('Provider default') && out.includes('Enforced'), 'limits table shows enforced / provider default / not in this build');
  check(out.includes('not measured') && out.includes('ESTIMATED lower bound'), 'page states unmeasured ≠ 0 and that concurrency is an estimate');
  check(!/£\s*\d/.test(out), 'no £ amounts are manufactured on this section');
  const trunc = ui.renderUsageSafetyHtml({ ...r, truncated: true });
  check(trunc.includes('incomplete'), 'a truncated load is announced');

  const attn = new Function('document', 'fetch', 'window', 'fmtNum', `${x('customerMonitorHelpers')}\n${x('fmtDateTime')}\n${x('businessControlTabs')}\nreturn { buildAttentionItems };`)(doc, async () => ({}), {}, String);
  const items = attn.buildAttentionItems({ cards: [], usageSafety: summariseForOverview(r) }, null, null);
  const usage = items.find((i) => i.topic === 'usage');
  check(usage && usage.severity === 'red' && usage.tab === 'operations' && usage.affected === 1, 'Overview "Needs your attention" gets one usage group, worst severity, de-duplicated by household');
  const down = attn.buildAttentionItems({ cards: [], usageSafety: { available: false, reason: 'db down' } }, null, null);
  check(down.some((i) => i.topic === 'data_freshness' && i.details.some((d) => /Usage & cost safety: db down/.test(d))), 'unavailable usage data surfaces as "could not run", never as fine');
  check(attn.buildAttentionItems({ cards: [], usageSafety: summariseForOverview(computeUsageSafety({ calls: [], env: {} }, NOW)) }, null, null).length === 0, 'quiet usage adds nothing to the attention list');
}

console.log(failures === 0 ? '\nAll usage-safety checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
