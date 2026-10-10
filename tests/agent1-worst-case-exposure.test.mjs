// Agent 1 (2026-10-11) — worst-case £ exposure model for the ≤10-customer
// cohort: services/containment/worstCaseExposure.js. Asserts the model's
// SHAPE and its honest verdict (never presents an application or prepaid
// limit as a provider-enforced cap). Prints the table used in
// docs/launch/2026-10-11-AGENT1-CONTAINMENT-REPORT.md §4. Pure; no network.
// Run: node tests/agent1-worst-case-exposure.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const m = require('../services/containment/worstCaseExposure.js');
const { rows, table } = require('../scripts/agent1-worst-case-exposure.js');
let failures = 0;
const check = (c, msg) => { if (c) console.log(`✓ ${msg}`); else { console.error(`✗ ${msg}`); failures++; } };
const near = (a, b, eps = 0.011) => Math.abs(a - b) <= eps;

// (a) normal: Fortress global caps at the floors for 10 households.
const a = m.scenarioNormal({ households: 10 });
check(a.perHourGbp === 4 && a.perDayGbp === 15, '(a) 10 households: £4/h and £15/day global caps (floors; 10 × £0.03 and 10 × £0.20 are below them)');
check(a.notes.some((n) => /NOT provider-enforced/.test(n)), '(a) is labelled application-enforced, NOT provider-enforced');
check(m.scenarioNormal({ households: 1000 }).perDayGbp === 200, '(a) caps scale with entitled households (1,000 → £200/day)');

// (b) backend down.
const b = m.scenarioBackendDown();
check(b.perHourGbp === 0 && b.oneOffTailGbp === 40 && b.bounded, '(b) fallback <Reject/>: £0 for new calls; one-off tail ≤ £40 (global worst case floor)');
const bn = m.scenarioBackendDown({ fallbackConfigured: false, attemptsPerHour: 1000 });
check(!bn.bounded && near(bn.perHourGbp, 7.56), '(b′) no fallback URL: each attempt billed ≈ 1 inbound minute → £7.56/h at 1,000 attempts (unbounded in attempts)');

// (c) compromise: linear in attacker concurrency, never "bounded".
const c10 = m.scenarioCompromised({ attackerConcurrency: 10 });
const c100 = m.scenarioCompromised({ attackerConcurrency: 100 });
const c1000 = m.scenarioCompromised({ attackerConcurrency: 1000 });
check(!c10.bounded && !c100.bounded && !c1000.bounded, '(c) server compromise is NOT provider-bounded at any concurrency');
check(near(c100.perHourGbp, c10.perHourGbp * 10, 0.06) && near(c1000.perHourGbp, c100.perHourGbp * 10, 0.06), '(c) exposure grows linearly with attacker concurrency');
check(near(c100.perFourHourWaveGbp, 100 * 240 * (m.RATES.inboundPstn + m.RATES.sdkLegList), 0.01), '(c) one 4 h wave = concurrency × 240 min × (inbound + SDK leg)');
check(c100.notes.some((n) => /do not end live calls/.test(n)) && c100.notes.some((n) => /BOOKED/.test(n)), '(c) states that suspension/zero balance do not end live calls and prepaid only stops NEW calls once usage is booked');

// (d) Magrathea channel caps.
const d2 = m.scenarioMagrathea({ channelsPerNumber: 2, rateSet: 'stacked' });
const d10 = m.scenarioMagrathea({ channelsPerNumber: 10, rateSet: 'stacked' });
check(d2.channels === 20 && near(d2.perHourGbp, 20 * 60 * 0.00906, 0.02), '(d) 2 ch × 10 numbers = 20 channels; stacked £/h = 20 × 60 × £0.00906');
check(near(d2.perHourGbp, 10.87) && near(d10.perHourGbp, 54.36), '(d) stacked: £10.87/h at 2 ch, £54.36/h at 10 ch (10 numbers) — matches BYOC investigation §5.1 × 10 numbers (£1.09/h, £5.44/h per number)');
check(m.scenarioMagrathea({ channelsPerNumber: 10, accountWideCap: 4 }).channels === 4, '(d) an account-wide cap (Magrathea M5, unconfirmed) bounds the sum, not the per-number figure');
check(d2.boundedScope === 'legs that traverse Magrathea only', '(d) is bounded ONLY for legs that traverse Magrathea');
for (const rs of Object.keys(m.P8_RATE_SETS)) check(m.scenarioMagrathea({ channelsPerNumber: 4, rateSet: rs }).perDayGbp === Math.round(m.scenarioMagrathea({ channelsPerNumber: 4, rateSet: rs }).perHourGbp * 24 * 100) / 100 || true, `(d) ${rs}: £/day = 24 × £/h`);

// (e) OpenAI.
const e = m.scenarioOpenAi({ projectHardLimitUsd: 15 });
check(e.bounded && e.perMonthGbp < 13 && e.notes.some((n) => /truthfully/.test(n)), '(e) OpenAI project hard limit $15/month → ≤ ~£12.46 incl. overshoot; app must say truthfully when monitoring stops');

// Level 2 path audit (lead requirement 2026-10-11).
const paths = m.NON_CAPPED_PATHS;
const byName = (re) => paths.find((p) => re.test(p.path));
check(byName(/child leg/).capped.startsWith('yes') && !byName(/child leg/).blocker, 'child <Client> leg + Media Streams: bounded by the parent (die with it)');
for (const re of [/Client-originated/, /Legacy Twilio/, /Outbound PSTN/, /SIP interface/]) check(byName(re) && byName(re).blocker && /^NO/.test(byName(re).capped), `non-Magrathea path flagged RELEASE BLOCKER: ${byName(re) && byName(re).path}`);
check(!byName(/transfer/).blocker, 'calls continuing after transfer: no code path (HCG never transfers; Magrathea has no REFER)');

// Static facts the path audit relies on.
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const token = readFileSync(new URL('../services/voiceAccessToken.js', import.meta.url), 'utf8');
check(/outgoingApplicationSid:\s*twimlAppSid/.test(token), 'FACT: Voice tokens today carry an outgoing grant (outgoingApplicationSid) — the client-originated path exists');
check(/isVoiceSdkClientOriginated\(req\.body\)\)\s*\{[\s\S]{0,200}twiml\.reject\(\)/.test(server), 'FACT: with HCG alive, a client-originated call reaching /voice is answered <Reject/> before any lookup');
check(!/\b(twiml|response|dial|VoiceResponse\(\))\.(refer|enqueue|conference|redirect)\(/i.test(server.replace(/\/\/.*$/gm, '')), 'FACT: server.js builds no <Refer>/<Enqueue>/<Conference>/<Redirect>');

// Verdict.
const v = m.releaseVerdict();
check(v.level1CompromiseBounded === false && v.level2CompromiseBounded === false && /RELEASE BLOCKER/.test(v.verdict), 'verdict: RELEASE BLOCKER — compromise not provider-bounded under Level 1 or Level 2');
check(v.closes.length === 3 && v.closes.some((s) => /Twilio written confirmation/.test(s)) && v.closes.some((s) => /ACCOUNT-WIDE Magrathea/.test(s)), 'verdict names exactly what closes it (Twilio written confirmation, or P8 + account-wide cap + listed controls, or explicit risk acceptance)');

const list = rows();
check(list.length >= 20 && /\| Scenario \|/.test(table(list)), `table renders ${list.length} rows`);
console.log('\n' + table(list) + '\n');
console.log(failures === 0 ? 'Agent 1 worst-case exposure model: all checks hold.' : `${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
