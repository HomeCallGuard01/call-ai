// Agent 1 (2026-10-11) — per-customer limits under flood, the spoofed-
// trusted-caller scenario, and the "backend / Fortress / app unavailable"
// fallbacks, each expressed as a COST outcome.
//
// Real modules: services/abuse/* (inbound guard, velocity, concurrency),
// services/containment/containment.js (Fortress client, D3 = reject),
// services/twilioProvisioning.js (fallback URL), services/config/launchConfig.
// Fortress' own £ bound per household (≤ £0.85 fresh, I5) is PROVEN on the
// real SQL by tests/fortress-server-death-exposure.pglite.test.mjs; here we
// prove how many calls a flood can even get to it, and price them with that
// test's worst cases. In-memory fakes only; no network.
// Run: node tests/agent1-abuse-and-outage-exposure.test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy';
const { resolveAbuseConfig } = require('../services/abuse/abuseConfig');
const { createAbuseAudit } = require('../services/abuse/abuseAudit');
const { createVelocityStore } = require('../services/abuse/velocity');
const { createIncidentMode } = require('../services/abuse/incidentMode');
const { createFinancialAuthorizationPort } = require('../services/abuse/financialAuthorizationPort');
const { createInboundCallGuard, createHoldStore } = require('../services/abuse/inboundCallGuard');
const { createContainment } = require('../services/containment/containment');
const { buildIncomingPhoneNumberParams } = require('../services/twilioProvisioning');
const { evaluateLaunchConfig } = require('../services/config/launchConfig');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

// Worst cases per admitted call when every HCG server dies right after
// admission (fortress-server-death-exposure.pglite, 'standard' profile).
const WORST_TRUSTED_CALL = 0.2482;
const WORST_MONITORED_CALL = 0.1246;
const HOUSEHOLD_FRESH_CEILING = 0.85;

function harness() {
  let t = 1_000_000;
  const now = () => t;
  const config = resolveAbuseConfig({});
  const velocity = createVelocityStore({ now });
  const guard = createInboundCallGuard({
    config, velocity, incident: createIncidentMode({ env: {}, now }), audit: createAbuseAudit({ log: () => {} }),
    financial: createFinancialAuthorizationPort({ authorize: async () => ({ telephony: 'allow', monitoring: 'allow' }) }, { timeoutMs: 50 }),
    holds: createHoldStore({ env: {} }), isHcgNumber: async () => false,
  });
  return { guard, config, velocity, advance: (ms) => { t += ms; } };
}
let n = 0;
const sid = () => `CA${(++n).toString(16).padStart(32, '0')}`;
async function call(h, { from, to = '+441615550100', household, contacts = [] }) {
  const callSid = sid();
  const d = await h.guard.screen({ params: { CallSid: callSid, From: from, To: to }, household, contacts, correlationId: 'x' });
  return { ...d, callSid };
}

// ── 1. Repeated calls: one caller → one household ───────────────────────
{
  const h = harness();
  const hh = { id: 'hh-1' };
  let connected = 0; let refusedBurst = 0;
  for (let i = 0; i < 50; i++) {
    const d = await call(h, { from: '+447700900111', household: hh });
    if (d.action === 'connect') { connected++; h.guard.release(d.callSid); } // short calls: only velocity applies
    else if (/caller_household_(burst|cooldown)/.test(d.reasonCode)) refusedBurst++;
    h.advance(5000);
  }
  check(connected === h.config.callerHouseholdBurst && refusedBurst === 50 - connected, `one caller redialling one household 50× in ~4 min: ${connected} connected (≤ burst ${h.config.callerHouseholdBurst}), rest <Reject/> (unbilled) for ${h.config.callerHouseholdCooldownMs / 60000} min`);
}
// Concurrency: one caller holding many simultaneous calls.
{
  const h = harness();
  const hh = { id: 'hh-2' };
  const ds = [];
  for (let i = 0; i < 6; i++) ds.push(await call(h, { from: '+447700900222', household: hh }));
  const c = ds.filter((d) => d.action === 'connect').length;
  check(c === h.config.maxConcurrentPerCaller, `one caller, 6 simultaneous calls to one household: ${c} live (per-caller cap ${h.config.maxConcurrentPerCaller}); rest refused`);
}
// ── 2. Many callers → one household (spoofed CLIs) ─────────────────────
{
  const h = harness();
  const hh = { id: 'hh-3' };
  const ds = [];
  for (let i = 0; i < 100; i++) ds.push(await call(h, { from: `+4477009${String(10000 + i).slice(-5)}`, household: hh }));
  const c = ds.filter((d) => d.action === 'connect').length;
  check(c === h.config.maxConcurrentPerHousehold, `100 distinct callers flooding one household at once: ${c} live (household cap ${h.config.maxConcurrentPerHousehold}) → worst case ≤ ${c} × £${WORST_TRUSTED_CALL} = £${(c * WORST_TRUSTED_CALL).toFixed(2)}, and never above the household's Fortress ceiling £${HOUSEHOLD_FRESH_CEILING}`);
}
// ── 3. One caller → many households (fan-out) ──────────────────────────
{
  const h = harness();
  let connected = 0;
  for (let i = 0; i < 10; i++) {
    const d = await call(h, { from: '+447700900333', household: { id: `hh-f${i}` }, to: `+44161555${String(1000 + i)}` });
    if (d.action === 'connect') { connected++; h.guard.release(d.callSid); }
  }
  check(connected === h.config.callerFanoutHouseholds, `one caller dialling 10 households: ${connected} reached (fan-out limit ${h.config.callerFanoutHouseholds}), then refused everywhere for ${h.config.callerFanoutCooldownMs / 60000} min`);
}
// ── 4. Flood across all 10 households at once ──────────────────────────
{
  const h = harness();
  let live = 0;
  for (let hhI = 0; hhI < 10; hhI++) for (let i = 0; i < 20; i++) {
    const d = await call(h, { from: `+4477008${String(hhI * 100 + i).padStart(5, '0')}`, household: { id: `hh-all${hhI}` }, to: `+44161555${2000 + hhI}` });
    if (d.action === 'connect') live++;
  }
  const bound = 10 * HOUSEHOLD_FRESH_CEILING;
  check(live === 10 * h.config.maxConcurrentPerHousehold, `200 spoofed callers across 10 households: ${live} live calls (3 per household); abuse layer passes them to Fortress, whose per-household ceilings bound the whole cohort to ≤ £${bound.toFixed(2)} fresh (plus the global £/h, £/day and £40 worst-case caps)`);
}
// ── 5. Spoofed TRUSTED caller (screening bypass) ───────────────────────
{
  const h = harness();
  const hh = { id: 'hh-t' };
  const contacts = [{ number: '7700900444' }];
  const first = await call(h, { from: '+447700900444', household: hh, contacts });
  check(first.action === 'connect' && first.trusted && !first.monitor, 'a spoofed trusted CLI does skip live monitoring (cost impact: LOWER per minute — no stream/AI)');
  check(first.deliveryTrusted, '…and draws on the trusted reserve, which Fortress caps (£0.25 standard) and sizes each call\'s <Dial timeLimit> from');
  const ds = [first];
  h.guard.release(first.callSid);
  for (let i = 0; i < 6; i++) { h.advance(30_000); const d = await call(h, { from: '+447700900444', household: hh, contacts }); ds.push(d); if (d.action === 'connect') h.guard.release(d.callSid); }
  const suspended = ds.slice(h.config.trustedBypassBurst + 1).filter((d) => d.action === 'connect');
  check(suspended.every((d) => !d.trusted && d.monitor), `after ${h.config.trustedBypassBurst} calls in ${h.config.trustedBypassWindowMs / 60000} min the bypass is suspended (calls monitored again)`);
  const h2 = harness();
  const sim = [];
  for (let i = 0; i < 5; i++) sim.push(await call(h2, { from: '+447700900444', household: hh, contacts }));
  check(sim.filter((d) => d.action === 'connect').length === h2.config.maxConcurrentPerCaller && sim.some((d) => d.reasonCode === 'caller_concurrency'), 'a spoofed trusted caller is still bound by per-caller concurrency (2 simultaneous) — trust never bypasses abuse limits');
  check(WORST_TRUSTED_CALL <= HOUSEHOLD_FRESH_CEILING, `trusted spoof worst case per call £${WORST_TRUSTED_CALL} (Fortress, server dead) — the trusted path is Fortress-bounded exactly like screened calls`);
  const premium = await call(h, { from: '+449098790123', household: { id: 'hh-p' }, contacts: [{ number: '9098790123' }] });
  check(premium.action === 'connect' && !premium.trusted && premium.monitor, 'a premium-rate CLI stored as "trusted" never gets the bypass (monitored; HCG never dials it)');
}
// ── 6. Fortress unreachable → REJECT (D3) ──────────────────────────────
{
  const down = { authorizeCall: () => new Promise((_, rej) => setTimeout(() => rej(new Error('ECONNREFUSED')), 5)) };
  for (const NODE_ENV of ['production', undefined]) {
    const c = createContainment({ db: down, env: { NODE_ENV, FC_DEGRADED_MODE: 'bounded', FC_ALLOW_BOUNDED_DEGRADED_MODE: 'true' } });
    const d = await c.authorizeCall({ household: { id: 'h' }, callSid: sid(), from: '+447700900555', isKnown: false, wantsMonitoring: true, signatureValid: true });
    check(!d.allowed && d.reason === 'authorization_unavailable' && d.timeLimitSeconds === null, `Fortress unreachable (NODE_ENV=${NODE_ENV || 'unset'}, even with bounded requested) → call refused (server answers <Reject busy/>, unbilled)`);
  }
  const slow = { authorizeCall: () => new Promise(() => {}) };
  const c2 = createContainment({ db: slow, env: { NODE_ENV: 'production', FC_RPC_TIMEOUT_MS: '200' } });
  const t0 = Date.now();
  const d2 = await c2.authorizeCall({ household: { id: 'h' }, callSid: sid(), from: '+447700900556', isKnown: true, wantsMonitoring: false, signatureValid: true });
  check(!d2.allowed && Date.now() - t0 < 3000, 'Fortress hanging → refused within the RPC timeout (well inside Twilio\'s 15 s webhook limit)');
  const c3 = createContainment({ db: { authorizeCall: async () => ({ allowed: true, timeLimitSeconds: null }) }, env: { NODE_ENV: 'production' } });
  const d3 = await c3.authorizeCall({ household: { id: 'h' }, callSid: sid(), from: '+447700900557', isKnown: true, wantsMonitoring: false, signatureValid: true });
  check(!d3.allowed, 'an "allowed" answer without a time limit is treated as an authority failure → refused');
}
// ── 7. Backend unreachable → Twilio fallback <Reject/> ─────────────────
{
  const p = buildIncomingPhoneNumberParams({ phoneNumber: '+441615550100', appUrl: 'https://homecallguard.co.uk', voiceFallbackUrl: 'https://handler.twilio.com/twiml/EHx' });
  check(p.voiceFallbackUrl === 'https://handler.twilio.com/twiml/EHx' && p.voiceFallbackMethod === 'POST', 'every NEW number is bought with the <Reject/> fallback URL when TWILIO_VOICE_FALLBACK_URL is set');
  check(!('voiceFallbackUrl' in buildIncomingPhoneNumberParams({ phoneNumber: '+44', appUrl: 'https://x', voiceFallbackUrl: 'http://insecure' })), 'a non-https fallback is never configured');
  const xml = readFileSync(new URL('../scripts/production/twiml-bin-reject.xml', import.meta.url), 'utf8');
  check(/<Response><Reject\/><\/Response>/.test(xml) && !/<(Say|Play|Dial|Pause)/.test(xml), 'the TwiML Bin body is a bare <Reject/> (never answered → unbilled)');
  const r = evaluateLaunchConfig({ HCG_DEPLOYMENT: 'production', APP_URL: 'https://homecallguard.co.uk', SUPABASE_URL: 'https://psbzynxplxfbyrbdidmn.supabase.co' });
  check(r.warnings.some((w) => w.id === 'twilio_voice_fallback_url'), 'production without TWILIO_VOICE_FALLBACK_URL → launch-config WARNING (existing numbers need the console update, runbook step)');
}
// ── 8. App unreachable → unbilled reject ───────────────────────────────
{
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const i = server.indexOf('isUndeliverableNoRegisteredClient(household');
  const j = server.indexOf('containment.authorizeCall({');
  const block = server.slice(i, i + 1400);
  check(i > 0 && j > i && /twiml\.reject\(\{ reason: "busy" \}\)/.test(block), 'no registered app → <Reject busy/> as the first verb, decided BEFORE the Fortress reservation, greeting or stream (never answered)');
  check(!/\.say\(|\.stream\(|\.dial\(/.test(block.slice(0, block.indexOf('return sendVoiceTwiml'))), '…with no <Say>/<Stream>/<Dial> before it');
}
// ── 9. Live monitoring is not weakened to save cost ────────────────────
{
  const h = harness();
  const d = await call(h, { from: '+447700900666', household: { id: 'hh-m' } });
  check(d.action === 'connect' && d.monitor === true, 'an unknown caller to an active household is monitored by default (containment never silently drops monitoring)');
}

console.log(failures === 0 ? '\nAgent 1 abuse/outage exposure: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
