// Telephony abuse P0 — module-level adversarial tests (2026-10-03).
//
// Covers what the black-box server test cannot reach without real provider
// credentials: number-purchase races/timeouts/partial failures, mass
// sign-up, destination-format bypasses, SMS destination policy, incident
// mode and financial-port failure semantics, TwiML egress, webhook
// AccountSid. Every Twilio/Supabase collaborator is an in-memory fake —
// nothing here can reach a network.
//
// Run with: node tests/telephony-abuse-controls.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:9';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'dummy';

const { parsePhoneNumber, evaluateNumberForPurpose, PURPOSES, CLASSES, sameNumber } = require('../services/abuse/numberPolicy');
const { resolveAbuseConfig } = require('../services/abuse/abuseConfig');
const { createAbuseAudit } = require('../services/abuse/abuseAudit');
const { createVelocityStore } = require('../services/abuse/velocity');
const { createIncidentMode, ACTIONS } = require('../services/abuse/incidentMode');
const { createFinancialAuthorizationPort } = require('../services/abuse/financialAuthorizationPort');
const { createInboundCallGuard, createHoldStore } = require('../services/abuse/inboundCallGuard');
const { createTwilioWebhookIntegrity } = require('../services/abuse/webhookIntegrity');
const { inspectTwiml, createTwimlEgressGuard, REJECT_TWIML } = require('../services/abuse/twimlEgressGuard');
const { createAccountRisk, normaliseEmailBase } = require('../services/abuse/accountRisk');
const { createProvisioningGuard, findOrphanedTaggedNumbers } = require('../services/abuse/provisioningGuard');
const { ensureTwilioNumberProvisioned } = require('../services/twilioProvisioning');
const { setHouseholdPhoneNumber } = require('../services/householdPhoneNumber');
const { createCostCaps, guardSmsClient } = require('../services/liveMonitoring/costCaps');
const { normaliseContactNumber } = require('../services/phone');

let failures = 0;
let total = 0;
const check = (c, m) => { total++; if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const quietAudit = () => createAbuseAudit({ log: () => {} });

// ═══ 1. Destination policy ═══════════════════════════════════════════════
{
  const premiumVariants = ['09098790123', '+449098790123', '0044 909 879 0123', '+44 (0)909 879 0123', '‪+44 909 879 0123‬', '０９０９８７９０１２３', '(0909) 879-0123', '449098790123'];
  check(premiumVariants.every((v) => parsePhoneNumber(v).class === CLASSES.UK_PREMIUM_RATE && parsePhoneNumber(v).e164 === '+449098790123'),
    `alternate formatting of a premium-rate number (${premiumVariants.length} variants incl. 0044, +44 (0), bidi marks, fullwidth digits) all canonicalise to the same blocked class`);
  for (const purpose of [PURPOSES.SMS_WARNING, PURPOSES.HOUSEHOLD_PHONE, PURPOSES.PSTN_DIAL]) {
    check(premiumVariants.every((v) => !evaluateNumberForPurpose(purpose, v).allowed), `premium-rate refused for ${purpose.name} in every format`);
  }
  const blocked = {
    '07012345678': CLASSES.UK_PERSONAL_NUMBERING, '07612345678': CLASSES.UK_PAGING, '07624123456': CLASSES.CROWN_DEPENDENCY,
    '01481123456': CLASSES.CROWN_DEPENDENCY, '08712345678': CLASSES.UK_SERVICE_REVENUE_SHARE, '08001234567': CLASSES.UK_FREEPHONE,
    '05612345678': CLASSES.UK_CORPORATE_OR_VOIP, '+33612345678': CLASSES.INTERNATIONAL, '+881612345678': CLASSES.GLOBAL_SERVICE,
    '+88216123456': CLASSES.GLOBAL_SERVICE, '+97912345678': CLASSES.GLOBAL_SERVICE, '118118': CLASSES.SHORT_CODE, '999': CLASSES.EMERGENCY,
    '+19005550100': CLASSES.INTERNATIONAL, '00 1 900 555 0100': CLASSES.INTERNATIONAL,
  };
  for (const [n, cls] of Object.entries(blocked)) {
    const p = parsePhoneNumber(n);
    check(p.class === cls && !evaluateNumberForPurpose(PURPOSES.SMS_WARNING, n).allowed && !evaluateNumberForPurpose(PURPOSES.HOUSEHOLD_PHONE, n).allowed,
      `${n} → ${cls}, refused as SMS destination and as household phone`);
  }
  const malformed = ['+44+7700900123', '+4407700900123', '+44 7700 900123 ext 2', '+447700900123#', '+447700900123;w1234', '07700 9OO123', '٠٧٧٠٠٩٠٠١٢٣', '+0447700900123', '+4477009001234567', '7', '', null, ['07700900123', '09098790123'], 'client:household_x', 'sip:x@evil.example', `+44${'7'.repeat(70)}`];
  check(malformed.every((v) => parsePhoneNumber(v).class === CLASSES.MALFORMED && parsePhoneNumber(v).e164 === null), `malformed E.164 / dial-string tricks / parameter-pollution arrays never parse (${malformed.length} cases)`);
  check(malformed.every((v) => !evaluateNumberForPurpose(PURPOSES.SMS_WARNING, v).allowed), 'every malformed destination is refused');
  check(evaluateNumberForPurpose(PURPOSES.SMS_WARNING, '07700 900123').allowed && evaluateNumberForPurpose(PURPOSES.HOUSEHOLD_PHONE, '0161 555 0100').allowed, 'genuine UK mobile (SMS) and UK geographic (household phone) remain allowed');
  check(!evaluateNumberForPurpose(PURPOSES.HOUSEHOLD_PHONE, '0161 555 0100', { isHcgNumber: (e) => e === '+441615550100' }).allowed, 'an HCG-owned number is refused as a household destination (loop)');
  check(!evaluateNumberForPurpose(PURPOSES.SMS_WARNING, '+447781123456', { denyPrefixes: ['+447781'] }).allowed, 'operator deny-prefix list (ABUSE_DENY_E164_PREFIXES) blocks a sub-range without a code change');
  check(PURPOSES.PSTN_DIAL.allow.length === 0 && !evaluateNumberForPurpose(PURPOSES.PSTN_DIAL, '07700900123').allowed, 'PSTN dial purpose allows nothing — HCG has no PSTN delivery leg');
  check(!sameNumber('+337700900555', '7700900555') && sameNumber('07700 900555', '7700900555'), 'caller matching is full-number: last-10-digit collisions across countries no longer match');
  check(normaliseContactNumber('+33 6 12 34 56 78') === '+33612345678' && normaliseContactNumber('07700 900555') === '7700900555', 'trusted-contact storage: international kept as E.164, UK unchanged (legacy 10-digit)');
}

// ═══ 2. SMS destination + incident gate ═══════════════════════════════════
{
  const caps = createCostCaps({ maxStreamsPerHousehold: 2, maxTranscriptionsPerHouseholdPerDay: 9, maxTranscriptionsPerHour: 9, maxSmsPerHouseholdPerDay: 9, maxSmsPerHour: 99 });
  const from = '+441615550100';
  check(['+447012345678', '+447612345678', '+447624123456', '+449098790123', '+33612345678'].every((to) => !caps.allowSms('h', { to, from })), 'SMS to 070 / 076 / 07624 / 09 / international refused (old /^\\+447/ regex allowed the first three)');
  check(!caps.allowSms('h', { to: '07700900123', from }) && caps.allowSms('h', { to: '+447700900123', from }), 'SMS destination must already be canonical E.164 UK mobile');
  const sent = [];
  const client = { messages: { create: async (p) => { sent.push(p); return { sid: 'SM1' }; } } };
  const gated = guardSmsClient(client, caps, 'h', async () => false);
  let refused = false; try { await gated.messages.create({ to: '+447700900124', from, body: 'x' }); } catch { refused = true; }
  check(refused && sent.length === 0, 'incident mode (paid-action gate) stops a new SMS before the provider is called');
  const gateThrows = guardSmsClient(client, caps, 'h', async () => { throw new Error('down'); });
  refused = false; try { await gateThrows.messages.create({ to: '+447700900125', from, body: 'x' }); } catch { refused = true; }
  check(refused && sent.length === 0, 'paid-action gate unavailable → SMS fails closed');
}

// ═══ 3. Household phone number (client-chosen destination) ═══════════════
{
  const admin = { calls: [], rpc: async (name, args) => { admin.calls.push({ name, args }); return { error: null }; } };
  const r1 = await setHouseholdPhoneNumber('h1', '0909 879 0123', { admin, isHcgNumber: async () => false });
  const r2 = await setHouseholdPhoneNumber('h1', '+44 7012 345678', { admin, isHcgNumber: async () => false });
  check(r1.ok === false && r1.error === 'invalid_input' && r2.ok === false && admin.calls.length === 0, 'mobile/web client cannot set a premium or 070 number as the household (SMS) destination — refused before any write');
  const r3 = await setHouseholdPhoneNumber('h1', '0161 555 0100', { admin, isHcgNumber: async (e) => e === '+441615550100' });
  check(r3.ok === false && r3.policyReason === 'hcg_owned_number' && admin.calls.length === 0, 'an HCG-owned number cannot be set as the household destination (forwarding cycle)');
  const r4 = await setHouseholdPhoneNumber('h1', '07700 900123', { admin, isHcgNumber: async () => { throw new Error('db down'); } });
  check(r4.ok === false && r4.error === 'failed' && admin.calls.length === 0, 'HCG-number lookup unavailable → write refused (fail closed)');
}

// ═══ 4. Inbound guard — failure semantics not reachable black-box ═══════
function guardHarness({ financial = null, financialBreaker = null, env = {}, countLiveCalls, isHcgNumber, clock } = {}) {
  let t = 1_000_000;
  const now = clock || (() => t);
  const config = resolveAbuseConfig({ ...env });
  const velocity = createVelocityStore({ now });
  const incident = createIncidentMode({ env, financialBreaker, now });
  const audit = quietAudit();
  const guard = createInboundCallGuard({ config, velocity, incident, audit, financial: createFinancialAuthorizationPort(financial, { timeoutMs: 50 }), holds: createHoldStore({ env }), isHcgNumber, countLiveCalls });
  return { guard, velocity, incident, audit, advance: (ms) => { t += ms; } };
}
const hh = { id: 'hh-1' };
const params = (o = {}) => ({ CallSid: `CA${Math.random().toString(16).slice(2).padEnd(32, '0')}`, From: '+447700900777', To: '+441615550100', ...o });
{
  const { guard, audit } = guardHarness({ financial: { authorize: () => new Promise(() => {}) } });
  const d = await guard.screen({ params: params(), household: hh, contacts: [], correlationId: 'c1' });
  check(d.action === 'connect' && d.monitor === true && d.flags.includes('financial_authorization_unavailable') && audit.recent().some((r) => r.reasonCode === 'financial_authorization_unavailable'),
    'financial authorisation unavailable (timeout) → call delivered, monitoring kept under local caps, audited critical');
  const h2 = guardHarness({ financial: { authorize: async () => { throw new Error('rpc down'); } }, env: { ABUSE_FINANCIAL_UNAVAILABLE_POLICY: 'unmonitored' } });
  const d2 = await h2.guard.screen({ params: params(), household: hh, contacts: [], correlationId: 'c2' });
  check(d2.action === 'connect' && d2.monitor === false, "financial unavailable with policy 'unmonitored' → delivered without new paid monitoring");
  const h3 = guardHarness({ financial: { authorize: async () => ({ telephony: 'garbage' }) } });
  const d3 = await h3.guard.screen({ params: params(), household: hh, contacts: [], correlationId: 'c3' });
  check(d3.action === 'connect' && d3.flags.includes('financial_authorization_unavailable'), 'malformed financial response is treated as unavailable, never as an approval of anything unusual');
  const h4 = guardHarness({ financial: { authorize: async () => ({ telephony: 'reject', monitoring: 'deny', reason: 'telephony_kill_switch' }) } });
  const p4 = params();
  const d4 = await h4.guard.screen({ params: p4, household: hh, contacts: [], correlationId: 'c4' });
  check(d4.action === 'reject' && d4.reasonCode === 'financial:telephony_kill_switch' && h4.velocity.activeLeases(`conc:hh:${hh.id}`) === 0, 'financial kill switch → reject, and the call\'s concurrency leases are released');
  const h5 = guardHarness({ financial: { authorize: async () => ({ telephony: 'allow', monitoring: 'deny', reason: 'household_daily_ceiling' }) } });
  const d5 = await h5.guard.screen({ params: params({ From: '+447700900555' }), household: hh, contacts: [{ number: '7700900555' }], correlationId: 'c5' });
  check(d5.action === 'connect' && d5.trusted === true && d5.monitor === false, 'trusted contact still passes financial authorisation first (it is consulted for every call); £ ceiling degrades monitoring, not delivery');
}
{
  let called = 0;
  const order = [];
  const h = guardHarness({ financial: { authorize: async () => { called++; order.push('financial'); return { telephony: 'allow', monitoring: 'allow' }; } }, isHcgNumber: async (e) => { order.push('loop'); return e === '+441615550200'; } });
  const d = await h.guard.screen({ params: params({ From: '+441615550200' }), household: hh, contacts: [{ number: '1615550200' }], correlationId: 'o1' });
  check(d.action === 'reject' && d.reasonCode === 'loop_hcg_number_as_caller' && called === 0, 'ORDER: an HCG number stored as a "trusted contact" is refused by the loop check before trust or financial authorisation are consulted');
  for (let i = 0; i < 8; i++) await h.guard.screen({ params: params({ From: '+447700900555' }), household: hh, contacts: [{ number: '7700900555' }], correlationId: 'o2' });
  const before = called;
  const d2 = await h.guard.screen({ params: params({ From: '+447700900555' }), household: hh, contacts: [{ number: '7700900555' }], correlationId: 'o3' });
  check(d2.action === 'reject' && d2.reasonCode === 'caller_household_burst' && called === before, 'ORDER: a trusted CLI flooding a household is refused by velocity before financial authorisation (no reservation created)');
}
{
  const h = guardHarness({ env: { HCG_INCIDENT_MODE: 'full_stop' } });
  const d = await h.guard.screen({ params: params({ From: '+447700900555' }), household: hh, contacts: [{ number: '7700900555' }], correlationId: 'g1' });
  check(d.action === 'reject' && d.reasonCode === 'incident_mode_full_stop', 'global incident full_stop refuses even a trusted contact (trust never bypasses the global breaker)');
}
{
  const h = guardHarness({ isHcgNumber: async () => { throw new Error('directory down'); } });
  const d = await h.guard.screen({ params: params(), household: hh, contacts: [], correlationId: 'u1' });
  check(d.action === 'connect' && d.flags.includes('loop_check_unavailable'), 'abuse control unavailable (HCG-number directory throws) → call still delivered, flagged — never a 500 to Twilio');
}
{
  // Victim-lockout via leaked leases: callers hang up during the
  // announcement (no callback ever arrives). Provider truth clears them.
  let live = 0;
  const h = guardHarness({ countLiveCalls: async () => live });
  for (let i = 0; i < 3; i++) await h.guard.screen({ params: params({ From: `+44770090070${i}` }), household: hh, contacts: [], correlationId: 'l' });
  const d = await h.guard.screen({ params: params({ From: '+447700900799' }), household: hh, contacts: [], correlationId: 'l4' });
  check(d.action === 'connect', 'leaked concurrency leases (calls whose end we never saw) cannot lock a household out: provider reports 0 live calls → delivered');
  live = 3;
  const h2 = guardHarness({ countLiveCalls: async () => live });
  for (let i = 0; i < 3; i++) await h2.guard.screen({ params: params({ From: `+44770090071${i}` }), household: hh, contacts: [], correlationId: 'l' });
  const d2 = await h2.guard.screen({ params: params({ From: '+447700900798' }), household: hh, contacts: [], correlationId: 'l5' });
  check(d2.action === 'reject' && d2.reasonCode === 'household_concurrency', 'provider confirms 3 live calls → 4th refused (engaged line)');
  const h3 = guardHarness({ countLiveCalls: async () => { throw new Error('twilio down'); } });
  for (let i = 0; i < 3; i++) await h3.guard.screen({ params: params({ From: `+44770090072${i}` }), household: hh, contacts: [], correlationId: 'l' });
  const d3 = await h3.guard.screen({ params: params({ From: '+447700900797' }), household: hh, contacts: [], correlationId: 'l6' });
  check(d3.action === 'connect', 'provider count unavailable → no unproven refusal (delivery preferred)');
  const h4 = guardHarness({});
  for (let i = 0; i < 3; i++) await h4.guard.screen({ params: params({ From: `+44770090073${i}` }), household: hh, contacts: [], correlationId: 'l' });
  h4.advance(11 * 60 * 1000);
  const d4 = await h4.guard.screen({ params: params({ From: '+447700900796' }), household: hh, contacts: [], correlationId: 'l7' });
  check(d4.action === 'connect', 'without any provider, a leaked lease expires after the 10-minute TTL');
}
{
  const h = guardHarness({});
  for (let i = 0; i < 9; i++) await h.guard.screen({ params: params({ From: '+447700900810' }), household: hh, contacts: [], correlationId: 'cd' });
  const blocked = await h.guard.screen({ params: params({ From: '+447700900810' }), household: hh, contacts: [], correlationId: 'cd2' });
  h.advance(16 * 60 * 1000);
  const after = await h.guard.screen({ params: params({ From: '+447700900810' }), household: hh, contacts: [], correlationId: 'cd3' });
  check(blocked.action === 'reject' && after.action === 'connect', 'caller→household cooldown is temporary (15 min): a throttle, never a permanent block');
}

// ═══ 5. Incident mode semantics ═══════════════════════════════════════════
{
  let t = 0;
  const im = createIncidentMode({ env: {}, now: () => t });
  im.trip('test', 1000);
  check((await im.state()).level === 'contain' && (await im.check(ACTIONS.INBOUND_CALL)).allowed && (await im.check(ACTIONS.MONITORING)).allowed && !(await im.check(ACTIONS.SMS)).allowed && !(await im.check(ACTIONS.PROVISION_NUMBER)).allowed,
    'automatic trip is capped at contain: no purchases, no SMS; calls and monitoring continue');
  t = 2000;
  check((await im.state()).level === 'normal', 'automatic trip expires');
  const fb = createIncidentMode({ env: {}, financialBreaker: async () => ({ telephonySuspended: true }) });
  check((await fb.state()).level === 'suspend_paid' && (await fb.check(ACTIONS.INBOUND_CALL)).allowed, 'financial breaker telephonySuspended maps to suspend_paid — refusing calls needs an explicit full_stop');
  let up = true; t = 0;
  const down = createIncidentMode({ env: {}, financialBreaker: async () => { if (!up) throw new Error('down'); return { level: 'normal' }; }, now: () => t, cacheMs: 0, staleMs: 60_000 });
  await down.state(); up = false; t = 1000;
  check(!(await down.check(ACTIONS.PROVISION_NUMBER)).allowed && (await down.check(ACTIONS.SMS)).allowed, 'breaker unreadable (fresh): purchases fail closed, other actions keep last known state');
  t = 120_000;
  check(!(await down.check(ACTIONS.SMS)).allowed && (await down.check(ACTIONS.INBOUND_CALL)).allowed, 'breaker unreadable beyond staleness: falls back to contain (no SMS/purchases), calls still delivered');
}

// ═══ 6. TwiML egress guard ════════════════════════════════════════════════
{
  const own = 'hcg.test';
  const ok = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>x</Say><Start><Stream url="wss://hcg.test/media-stream"><Parameter name="streamToken" value="t"/></Stream></Start><Dial action="/call-delivery-failed" timeout="20"><Client>household_h1</Client></Dial></Response>';
  check(inspectTwiml(ok, { ownHost: own, expectedClientIdentity: 'household_h1' }).ok, 'the real /voice TwiML shape passes');
  const bad = {
    '<Response><Dial><Number>+449098790123</Number></Dial></Response>': 'forbidden_verb:Number',
    '<Response><Dial><Sip>sip:x@evil.example</Sip></Dial></Response>': 'forbidden_verb:Sip',
    '<Response><Dial><Conference>x</Conference></Dial></Response>': 'forbidden_verb:Conference',
    '<Response><Dial><Client>household_other</Client></Dial></Response>': 'client_identity_mismatch',
    '<Response><Start><Stream url="wss://evil.example/media-stream"/></Start></Response>': 'foreign_url:Stream.url',
    '<Response><Dial action="https://evil.example/x"><Client>household_h1</Client></Dial></Response>': 'foreign_url:Dial.action',
    '<Response><Redirect>https://evil.example/twiml</Redirect></Response>': 'foreign_url:Redirect.body',
    '<Response><Enqueue>q</Enqueue></Response>': 'forbidden_verb:Enqueue',
    '<Response><Dial action="//evil.example/x"><Client>household_h1</Client></Dial></Response>': 'foreign_url:Dial.action',
  };
  for (const [xml, v] of Object.entries(bad)) {
    const r = inspectTwiml(xml, { ownHost: own, expectedClientIdentity: 'household_h1' });
    check(!r.ok && r.violations.includes(v), `egress guard refuses ${v}`);
  }
  const g = createTwimlEgressGuard({ ownHost: own, audit: quietAudit() });
  check(g('<Response><Dial><Number>+881612345678</Number></Dial></Response>', { expectedClientIdentity: 'household_h1' }) === REJECT_TWIML, 'a violating response is replaced by an unbilled <Reject/>');
}

// ═══ 7. Webhook AccountSid / unexpected provider ═════════════════════════
{
  const audit = quietAudit();
  const wi = createTwilioWebhookIntegrity({ config: { ...resolveAbuseConfig({ TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32) }) }, audit });
  const mkReq = (body) => ({ body, path: '/voice', get: () => 'sig' });
  const mkRes = () => { const r = { code: 200, status(c) { r.code = c; return r; }, end() { return r; }, type() { return r; }, send() { return r; } }; return r; };
  const res1 = mkRes(); let nexted = false;
  wi.middleware(mkReq({ CallSid: 'CA' + '1'.repeat(32), AccountSid: 'AC' + 'b'.repeat(32) }), res1, () => { nexted = true; });
  check(res1.code === 403 && !nexted, 'webhook for a different Twilio account (unexpected provider / mis-pointed number) → 403');
  const res2 = mkRes(); nexted = false;
  wi.middleware(mkReq({ CallSid: 'CA' + '2'.repeat(32), AccountSid: 'AC' + 'a'.repeat(32) }), res2, () => { nexted = true; });
  check(nexted, 'own account passes');
}

// ═══ 8. Number provisioning ════════════════════════════════════════════════
function fakeTwilio({ createDelayMs = 0, createFailsOnce = null, returnNumber = null } = {}) {
  const state = { owned: [], creates: 0, removes: [], lists: 0, failedOnce: false };
  const incoming = (sid) => ({ remove: async () => { state.removes.push(sid); state.owned = state.owned.filter((n) => n.sid !== sid); } });
  incoming.list = async ({ friendlyName } = {}) => { state.lists++; return state.owned.filter((n) => !friendlyName || n.friendlyName === friendlyName); };
  incoming.create = async (params) => {
    state.creates++;
    if (createDelayMs) await new Promise((r) => setTimeout(r, createDelayMs));
    const n = { sid: `PN${state.creates}`, phoneNumber: returnNumber || params.phoneNumber, friendlyName: params.friendlyName };
    state.owned.push(n);
    if (createFailsOnce && !state.failedOnce) { state.failedOnce = true; throw new Error(createFailsOnce); } // provider succeeded, response lost
    return n;
  };
  let seq = 0;
  return { state, client: { availablePhoneNumbers: () => ({ local: { list: async () => [{ phoneNumber: `+44161555${String(1000 + (++seq)).slice(-4)}` }] } }), incomingPhoneNumbers: incoming } };
}
function provisioningHarness({ env = {}, signals = {}, financialBreaker = null } = {}) {
  const config = resolveAbuseConfig(env);
  const velocity = createVelocityStore();
  const incident = createIncidentMode({ env, financialBreaker });
  const audit = quietAudit();
  const accountRisk = createAccountRisk({ config, countRecentNumbersForHousehold: async () => 0, countHouseholdsWithPhone: async () => 0, countHouseholdsWithEmailBase: async () => 0, ...signals });
  const guard = createProvisioningGuard({ config, incident, velocity, audit, accountRisk });
  const assigned = new Map();
  const deps = (fake, extra = {}) => ({
    client: fake.client, abuseGuard: guard, appUrl: 'https://hcg.test',
    assign: async (id, n) => { if (assigned.has(id)) return false; assigned.set(id, n); return true; },
    recordFailure: async () => {}, sendAlert: async () => {}, isQuarantinedNumber: async () => false, ...extra,
  });
  return { guard, deps, assigned, audit, incident };
}
const household = (i, extra = {}) => ({ id: `hh-${i}`, twilio_number: null, twilio_provisioning_attempts: 0, email: `user${i}@example.invalid`, ...extra });
{
  const h = provisioningHarness();
  const fake = fakeTwilio({ createDelayMs: 30 });
  const hhA = household(1);
  const [r1, r2, r3] = await Promise.all([ensureTwilioNumberProvisioned(hhA, h.deps(fake)), ensureTwilioNumberProvisioned(hhA, h.deps(fake)), ensureTwilioNumberProvisioned(hhA, h.deps(fake))]);
  check(fake.state.creates === 1 && r1.success && r2.success && r3.success && r1.twilioNumber === r2.twilioNumber, 'three concurrent purchases for one household → exactly ONE number bought (single-flight), all callers get the same result');
  check(fake.state.owned[0].friendlyName === 'hcg-hh-hh-1', 'the purchased number carries the provider-side idempotency tag');
}
{
  const h = provisioningHarness();
  const fake = fakeTwilio({ createFailsOnce: 'ETIMEDOUT' });
  const hh2 = household(2);
  const first = await ensureTwilioNumberProvisioned(hh2, h.deps(fake));
  const retry = await ensureTwilioNumberProvisioned(hh2, h.deps(fake));
  check(first.success === false && retry.success === true && retry.adopted === true && fake.state.creates === 1, 'retry after a timeout (purchase actually succeeded) ADOPTS the tagged number — no second purchase');
}
{
  const h = provisioningHarness();
  const fake = fakeTwilio();
  const hh3 = household(3);
  let failAssign = true;
  const first = await ensureTwilioNumberProvisioned(hh3, h.deps(fake, { assign: async (id, n) => { if (failAssign) throw new Error('db write failed'); h.assigned.set(id, n); return true; } }));
  failAssign = false;
  const retry = await ensureTwilioNumberProvisioned(hh3, h.deps(fake, { assign: async (id, n) => { h.assigned.set(id, n); return true; } }));
  check(first.success === false && retry.adopted === true && fake.state.creates === 1 && fake.state.removes.length === 0, 'partial failure (bought, DB assign failed) reconciles on retry by adoption — no orphan, no second purchase');
  const orphans = await findOrphanedTaggedNumbers(fake.client, []);
  check(orphans.length === 1 && orphans[0].householdId === 'hh-3', 'tagged numbers not assigned to any household are discoverable for reconciliation (read-only)');
}
{
  const h = provisioningHarness();
  const fake = fakeTwilio();
  fake.state.owned.push({ sid: 'PNQ', phoneNumber: '+441615559000', friendlyName: 'hcg-hh-hh-4' });
  const r = await ensureTwilioNumberProvisioned(household(4), h.deps(fake, { isQuarantinedNumber: async (n) => n === '+441615559000' }));
  check(r.success && !r.adopted && r.twilioNumber !== '+441615559000', 'a tagged number still in quarantine is never adopted (its pending release would remove a live number)');
  const h2 = provisioningHarness();
  const fake2 = fakeTwilio();
  fake2.state.owned.push({ sid: 'PNQ2', phoneNumber: '+441615559001', friendlyName: 'hcg-hh-hh-5' });
  const r2 = await ensureTwilioNumberProvisioned(household(5), h2.deps(fake2, { isQuarantinedNumber: async () => { throw new Error('db down'); } }));
  check(r2.success === false && fake2.state.creates === 0, 'quarantine state unreadable → no adoption AND no purchase (fail closed)');
}
{
  const h = provisioningHarness();
  const fake = fakeTwilio({ returnNumber: '+449098790123' });
  const r = await ensureTwilioNumberProvisioned(household(6), h.deps(fake));
  check(r.success === false && fake.state.removes.length === 1 && !h.assigned.has('hh-6'), 'provider response mismatch (different / premium number returned) → released immediately, never assigned');
}
{
  const h = provisioningHarness({ signals: { countRecentNumbersForHousehold: async () => 2 } });
  const fake = fakeTwilio();
  const r = await ensureTwilioNumberProvisioned(household(7), h.deps(fake));
  check(r.held === true && r.reason === 'account_risk_hold' && fake.state.creates === 0, 'repeated provisioning (buy → abandon → repeat: 2 numbers in 30 days) → held BEFORE any purchase');
  const r2 = await ensureTwilioNumberProvisioned(household(7), { ...h.deps(fake), abuseOverride: 'admin' });
  check(r2.success === true && fake.state.creates === 1 && h.audit.recent().some((a) => a.reasonCode === 'account_risk_admin_override'), 'admin retry can release an account-risk hold (audited)');
}
{
  const h = provisioningHarness({ signals: { countHouseholdsWithPhone: async () => 1 } });
  const r = await ensureTwilioNumberProvisioned(household(8, { phone_number: '+447700900123' }), h.deps(fakeTwilio()));
  check(r.held === true, 'same protected phone number already on another account → held');
  check(normaliseEmailBase('J.Smith+hcg7@GoogleMail.com') === 'jsmith@gmail.com' && normaliseEmailBase('a+1@example.invalid') === 'a@example.invalid', 'email alias normalisation (gmail dots, +tags, googlemail, case)');
  const h2 = provisioningHarness({ signals: { countHouseholdsWithEmailBase: async (base) => (base === 'jsmith@gmail.com' ? 2 : 0) } });
  const r2 = await ensureTwilioNumberProvisioned(household(9, { email: 'j.s.m.i.t.h+3@gmail.com' }), h2.deps(fakeTwilio()));
  check(r2.held === true, 'repeated email aliases (third account on one gmail base) → held');
  const h3 = provisioningHarness({ signals: { countRecentNumbersForHousehold: async () => { throw new Error('db down'); } } });
  const f3 = fakeTwilio();
  const r3 = await ensureTwilioNumberProvisioned(household(10), h3.deps(f3));
  check(r3.held === true && f3.state.creates === 0, 'provisioning history unreadable → held (fail closed before spending)');
}
{
  const h = provisioningHarness();
  const fake = fakeTwilio();
  const results = [];
  for (let i = 0; i < 100; i++) results.push(await ensureTwilioNumberProvisioned(household(100 + i), h.deps(fake)));
  check(fake.state.creates === 10 && results.slice(10).every((r) => r.held === true), `100 account creations each wanting a number → only the global hourly ceiling (10) is bought; 90 held (bought ${fake.state.creates})`);
  check((await h.incident.state()).level === 'contain', 'hitting the purchase ceiling trips contain mode automatically');
}
{
  const h = provisioningHarness({ env: { HCG_INCIDENT_MODE: 'contain' } });
  const fake = fakeTwilio();
  const r = await ensureTwilioNumberProvisioned(household(300), h.deps(fake));
  check(r.held === true && fake.state.creates === 0 && fake.state.lists === 0, 'incident mode contain → no purchase and no provider call at all');
  const h2 = provisioningHarness({ financialBreaker: async () => { throw new Error('breaker down'); } });
  const f2 = fakeTwilio();
  const r2 = await ensureTwilioNumberProvisioned(household(301), h2.deps(f2));
  check(r2.held === true && r2.reason === 'incident_state_unavailable' && f2.state.creates === 0, 'financial breaker unavailable → purchases fail closed');
}
{
  const fake = fakeTwilio();
  const r = await ensureTwilioNumberProvisioned(household(400), { client: fake.client, abuseGuard: null, env: { NODE_ENV: 'production' }, assign: async () => true, recordFailure: async () => {}, sendAlert: async () => {} });
  check(r.held === true && r.reason === 'abuse_guard_not_configured' && fake.state.creates === 0, 'production with no abuse guard configured refuses to buy (fail closed)');
}

// ═══ 9. Authorization boundaries (structural) ═════════════════════════════
{
  const mobileSrc = readFileSync(path.join(ROOT, 'routes/mobileApi.js'), 'utf8');
  const serverSrc = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const tokenRoute = mobileSrc.slice(mobileSrc.indexOf('router.get("/api/v1/voice/token"'), mobileSrc.indexOf('router.post("/api/v1/voice/registered"'));
  check(/householdId: req\.household\.id/.test(tokenRoute) && !/req\.(query|body)\.(identity|householdId)/.test(tokenRoute), 'voice token identity is derived from the authenticated household only — a client cannot choose another household\'s Client identity');
  check(/startsWith\("client:"\)/.test(serverSrc) && /twiml\.reject\(\)/.test(serverSrc), 'client-originated calls (outgoing grant) are rejected — a mobile client cannot place PSTN calls through HCG');
  check(!/req\.body\.(household_id|householdId)/.test(mobileSrc) && /setHouseholdPhoneNumber\(req\.household\.id, req\.body\.number\)/.test(mobileSrc), 'mobile routes never take a household id from the request body (no cross-household provisioning or destination writes)');
  check(!/req\.body\.(trusted|isKnown|monitor|provider|route)/.test(serverSrc + mobileSrc), 'no request field can mark a call trusted, skip monitoring or pick provider routing');
  check(/insertContacts\(req\.household\.id, \[\{ name, number, customer_id: null \}\]\)/.test(mobileSrc), 'contact writes are scoped to the authenticated household with server-built rows');
}

console.log(`\n${failures === 0 ? 'All telephony-abuse control checks passed' : `${failures} telephony-abuse control check(s) FAILED`} (${total} checks)`);
process.exitCode = failures === 0 ? 0 : 1;
