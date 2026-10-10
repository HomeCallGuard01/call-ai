// Level 2 end-to-end: Magrathea → Twilio BYOC inbound calls through the REAL
// server.js (WS7, 2026-10-11). Written BEFORE the WS6 BYOC code lands so it
// can be validated the moment it merges.
//
// Harness: tests/helpers/byoc/ (real server.js child process; fake Supabase
// whose RPCs run the real Fortress SQL on PGlite; Twilio REST answered
// locally with test-controlled provider truth; OpenAI → local counter; all
// other network refused). No real call, SMS, AI request or purchase.
//
// Webhooks are shaped exactly like an inbound BYOC call from Magrathea as
// Twilio presents it (tests/helpers/byoc/byocWebhooks.mjs): To = the
// household's DDI, From = the caller (07… / +44… / 0044…), Direction=inbound,
// no CallerName, no Diversion / X- headers (Twilio discards them on BYOC),
// AccountSid = the BYOC (sub)account, signed with that account's token.
//
// Two account topologies are exercised (names aligned with WS6's
// services/telephony/twilioAccounts.js):
//   A  SINGLE ACCOUNT (WS6 "default and RECOMMENDED"): the BYOC trunk lives
//      in HCG's runtime subaccount — TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN
//      ARE the subaccount's. Needs no new signature code.
//   B  TWO ACCOUNTS (WS6 optional): Twilio-hosted numbers on the primary
//      account, BYOC trunk on TWILIO_BYOC_ACCOUNT_SID / TWILIO_BYOC_AUTH_TOKEN.
//
// Sections:
//   CORE      — must pass today and after WS6 (failure ⇒ exit 1).
//   WS6       — EXPECTED-FAIL-UNTIL-WS6: depends on unmerged WS6 code
//               (national/URI number canonicalisation, multi-token
//               signatures, BYOC household lookup). Reported, never fails the
//               run — unless BYOC_E2E_STRICT=1, which makes every one strict
//               (run that after merging ws6).
//
// Run:   node tests/byoc-e2e.test.mjs
// Strict (after ws6):  BYOC_E2E_STRICT=1 node tests/byoc-e2e.test.mjs

import {
  createByocWorld, bootServer, postSigned, createReporter, sleep, wsProbe, startFrame,
  isReject, connectsTo, monitored, announced, noPstn, timeLimit, streamTokenOf,
} from './helpers/byoc/harness.mjs';
import { byocVoiceParams, byocDialActionParams, byocCallStatusParams, callerVariants, newCallSid } from './helpers/byoc/byocWebhooks.mjs';

const R = createReporter();
const { check, expectWs6, section } = R;

// ── Accounts (synthetic) ─────────────────────────────────────────────────
const PARENT_SID = 'AC00000000000000000000000000000000'; // the inert launch-run SID
const PARENT_TOKEN = 'test_parent_account_auth_token';
const BYOC_SID = `AC${'b7c0'.repeat(8)}`;
const BYOC_TOKEN = 'test_byoc_subaccount_auth_token';
const WRONG_TOKEN = 'test_some_other_account_token';

const SINGLE_ACCOUNT_ENV = { TWILIO_ACCOUNT_SID: BYOC_SID, TWILIO_AUTH_TOKEN: BYOC_TOKEN };
const TWO_ACCOUNT_ENV = { TWILIO_ACCOUNT_SID: PARENT_SID, TWILIO_AUTH_TOKEN: PARENT_TOKEN, TWILIO_BYOC_ACCOUNT_SID: BYOC_SID, TWILIO_BYOC_AUTH_TOKEN: BYOC_TOKEN };

// ── Households: each holds a Magrathea DDI (0306 999 0xxx drama range) ───
const mk = (n, key) => ({
  id: `0000b70c-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  twilio_number: `+4430699901${String(n).padStart(2, '0')}`,
  phone_number: `+4477009002${String(n).padStart(2, '0')}`,
  email: `byoc-${key}@example.invalid`,
  voice_client_registered_at: new Date().toISOString(),
  auth_user_id: null,
  activation_verified_at: null,
});
const H = {
  trust: mk(1, 'trust'), unknown: mk(2, 'unknown'), held: mk(3, 'held'), budget: mk(4, 'budget'),
  kill: mk(5, 'kill'), conc: mk(6, 'conc'), concB: mk(7, 'concb'), ddiForms: mk(8, 'ddiforms'),
  twoAcct: mk(9, 'twoacct'), hosted: mk(10, 'hosted'),
};
H.hosted.twilio_number = '+441614960010'; // a Twilio-hosted (non-BYOC) number, for the two-account control
const UNASSIGNED_DDI = '+443069990199';

// Trusted contacts are stored E.164 (how the app saves them today); the BYOC
// caller arrives in another presentation. One contact per presentation so
// the trusted-burst rule (4 calls / 5 min per caller) never interferes.
const TRUSTED = {
  e164: '+447700900555', national: '+447700900556', idd00: '+447700900557', sipUri: '+447700900558',
  kill: '+447700900559', held: '+447700900560', twoAcct: '+447700900561',
};
const contacts = [
  ...['e164', 'national', 'idd00', 'sipUri'].map((k, i) => ({ id: `ct${i}`, household_id: H.trust.id, name: `Synthetic ${k}`, number: TRUSTED[k], created_at: '2026-10-01T00:00:00Z' })),
  { id: 'ctk', household_id: H.kill.id, name: 'Synthetic kill', number: TRUSTED.kill, created_at: '2026-10-01T00:00:00Z' },
  { id: 'cth', household_id: H.held.id, name: 'Synthetic held', number: TRUSTED.held, created_at: '2026-10-01T00:00:00Z' },
  { id: 'ct2', household_id: H.twoAcct.id, name: 'Synthetic two-account', number: TRUSTED.twoAcct, created_at: '2026-10-01T00:00:00Z' },
];

const world = await createByocWorld({ households: Object.values(H), contacts });
const { q } = world;
await q('select public.fc_refresh_entitled_count($1)', [new Date().toISOString()]);

let adjustN = 0;
const budgetTo = (hh, gbp) => q('select public.fc_admin_adjust($1,$2,$3,$4,$5,$6,$7,$8,$9)', [hh.id, gbp - 50, 'byoc e2e scenario budget', 'tester', `byoc-${++adjustN}`, 'test', null, null, new Date().toISOString()]);
const reservation = async (callSid) => (await q("select household_id, state, monitored, is_known, deny_reason from public.fc_reservations where idempotency_key = 'call:' || $1", [callSid]))[0] || null;
const activeFor = async (hh) => (await q("select count(*)::int n, coalesce(sum(reserved_gbp),0)::float s, coalesce(sum(worst_case_gbp),0)::float w from public.fc_reservations where household_id = $1 and state in ('active','terminating')", [hh.id]))[0];
async function waitState(callSid, want, tries = 40) {
  let r = null;
  for (let i = 0; i < tries; i++) { r = await reservation(callSid); if (r && r.state === want) return r; await sleep(50); }
  return r;
}

const allTwiml = [];
function voice(srv, { hh = null, to = hh && hh.twilio_number, from, accountSid, token, extra } = {}) {
  const params = byocVoiceParams({ to, from, accountSid, extra });
  return postSigned(srv.port, '/voice', params, token).then((r) => { if (r.status === 200) allTwiml.push(r.text); return { ...r, params }; });
}
const dialEnded = (srv, params, token, over = {}) => postSigned(srv.port, '/call-delivery-failed', byocDialActionParams({ callSid: params.CallSid, to: params.To, from: params.From, accountSid: params.AccountSid, ...over }), token);
const statusEnded = (srv, params, token) => postSigned(srv.port, '/call-status', byocCallStatusParams({ callSid: params.CallSid, to: params.To, from: params.From, accountSid: params.AccountSid }), token);
const smsSpy = (srv) => srv.logs().split('\n').filter((l) => l.startsWith('TWILIO_SPY ')).map((l) => JSON.parse(l.slice(11))).filter((e) => e.method === 'post' && /Messages\.json$/.test(e.uri));
const netBlocked = (srv) => srv.logs().split('\n').filter((l) => l.startsWith('NET_BLOCKED '));

// Worst case: N simultaneous BYOC calls to one DDI from N distinct callers.
// The provider (Twilio) sees all N inbound legs ringing in the account that
// owns the BYOC trunk — that is what the abuse layer's countLiveCalls asks.
async function concurrencyBurst(srv, hh, { accountSid, token, n = 10, callerBase }) {
  const callers = Array.from({ length: n }, (_, i) => `${callerBase}${String(i).padStart(2, '0')}`);
  world.setProviderLiveCalls(callers.map((from) => ({ accountSid, to: hh.twilio_number, from, status: 'ringing' })));
  const logStart = srv.logs().length;
  const res = await Promise.all(callers.map((from) => voice(srv, { hh, from, accountSid, token })));
  await sleep(200);
  // Which layer refused? (abuse reasonCode / 056 admission / Fortress), for the report.
  const reasons = {};
  for (const line of srv.logs().slice(logStart).split('\n')) {
    let m = /ABUSE DECISION.*"reasonCode":"([a-z_:]+)".*"action":"reject"|ABUSE DECISION.*"action":"reject".*"reasonCode":"([a-z_:]+)"/.exec(line);
    if (m) { const k = `abuse:${m[1] || m[2]}`; reasons[k] = (reasons[k] || 0) + 1; continue; }
    m = /CALL REFUSED BY (FINANCIAL SAFETY|FINANCIAL CONTAINMENT): \S+ (\S+)/.exec(line);
    if (m) { const k = `${m[1] === 'FINANCIAL SAFETY' ? 'admission056' : 'fortress'}:${m[2]}`; reasons[k] = (reasons[k] || 0) + 1; }
  }
  const verifyQueries = srv.logs().slice(logStart).split('\n').filter((l) => l.startsWith('TWILIO_SPY ') && l.includes('Calls.json')).map((l) => JSON.parse(l.slice(11)));
  console.log(`    burst refusal reasons: ${JSON.stringify(reasons)}; provider live-call queries: ${verifyQueries.length} (answered ${verifyQueries.map((v) => v.answered).join(',') || '-'})`);
  const delivered = res.filter((r) => r.status === 200 && connectsTo(r.text, hh));
  const refused = res.filter((r) => r.status === 200 && isReject(r.text));
  const act = await activeFor(hh);
  world.setProviderLiveCalls([]);
  return { res, delivered, refused, act, reasons };
}

// ═════════════════════════════════════════════════════════════════════════
// A — SINGLE ACCOUNT (BYOC trunk in HCG's runtime subaccount)
// ═════════════════════════════════════════════════════════════════════════
const A = await bootServer(world, SINGLE_ACCOUNT_ENV);
const asByoc = { accountSid: BYOC_SID, token: BYOC_TOKEN };
try {
  section('A / CORE — single account: BYOC subaccount is TWILIO_ACCOUNT_SID');

  // A1 trusted caller (contact stored E.164, caller presented E.164)
  const t1 = await voice(A, { hh: H.trust, from: TRUSTED.e164, ...asByoc });
  check(t1.status === 200 && connectsTo(t1.text, H.trust) && !monitored(t1.text) && !announced(t1.text) && noPstn(t1.text),
    'A1 trusted BYOC caller (+44…) → <Dial><Client> own household only, no announcement, no <Stream>, no PSTN leg');
  check(timeLimit(t1.text) > 0 && timeLimit(t1.text) <= 14400, `A1 trusted call carries a provider-enforced <Dial timeLimit> (${timeLimit(t1.text)} s)`);
  const r1 = await reservation(t1.params.CallSid);
  check(r1 && r1.state === 'active' && r1.household_id === H.trust.id && r1.is_known === true && r1.monitored === false, 'A1 Fortress reservation: active, this household, is_known, unmonitored');
  const e1 = await dialEnded(A, t1.params, BYOC_TOKEN);
  check(e1.status === 200 && (await waitState(t1.params.CallSid, 'settled'))?.state === 'settled', 'A1 signed BYOC /call-delivery-failed → 200 and the reservation settles');

  // A2 unknown caller (national presentation, as Magrathea sends it)
  const unknownCaller = callerVariants('+447700900701');
  const aiBefore = world.aiLog.length;
  const u1 = await voice(A, { hh: H.unknown, from: unknownCaller.national, ...asByoc });
  const tok = streamTokenOf(u1.text);
  check(u1.status === 200 && announced(u1.text) && monitored(u1.text) && connectsTo(u1.text, H.unknown) && noPstn(u1.text),
    'A2 unknown BYOC caller (07…) → announcement + <Start><Stream> + <Dial><Client> own household');
  check(Boolean(tok) && !u1.text.includes(H.unknown.phone_number),
    'A2 stream carries ONLY a single-use streamToken (customer mobile never in TwiML)');
  check(timeLimit(u1.text) > 0, `A2 unknown call carries <Dial timeLimit> (${timeLimit(u1.text)} s)`);
  const r2 = await reservation(u1.params.CallSid);
  check(r2 && r2.state === 'active' && r2.household_id === H.unknown.id && r2.monitored === true && r2.is_known === false, 'A2 Fortress reservation: active, monitored, not known');

  // A3 media-stream token issued under a BYOC call: accepted once, refused on replay
  const g = await wsProbe(A.port, [startFrame('MZbyocA1', u1.params.CallSid, { streamToken: tok })], { holdMs: 3000 });
  await sleep(800);
  check(g.opened && !g.closedByServer && world.aiLog.slice(aiBefore).some((p) => p.includes('audio/transcriptions')), 'A3 BYOC stream token + its CallSid → stream accepted and transcribed (control)');
  const replay = await wsProbe(A.port, [startFrame('MZbyocA2', u1.params.CallSid, { streamToken: tok })]);
  check(replay.closedByServer, 'A3 replay of the used BYOC stream token on a new socket → closed');
  const sms = smsSpy(A);
  check(sms.every((m) => m.to === H.unknown.phone_number && m.from === H.unknown.twilio_number), `A3 any warning SMS (${sms.length}) goes only to the household's own mobile, from its own DDI`);
  const e2 = await statusEnded(A, u1.params, BYOC_TOKEN);
  check(e2.status === 200 && (await waitState(u1.params.CallSid, 'settled'))?.state === 'settled', 'A2 signed BYOC /call-status (completed) → 200 and the reservation settles');

  // A4 withheld / anonymous callers
  for (const [label, from] of [['anonymous', 'anonymous'], ['Twilio withheld sentinel', '+266696687']]) {
    const w = await voice(A, { hh: H.unknown, from, ...asByoc });
    const wr = await reservation(w.params.CallSid);
    check(w.status === 200 && connectsTo(w.text, H.unknown) && monitored(w.text) && wr && wr.is_known === false,
      `A4 withheld caller (${label}) → delivered and monitored, never trusted`);
    await dialEnded(A, w.params, BYOC_TOKEN);
  }

  // A5 unknown To: a DDI routed to the trunk but assigned to no household
  const nx = await voice(A, { to: UNASSIGNED_DDI, from: '+447700900702', ...asByoc });
  const nxr = await reservation(nx.params.CallSid);
  const leaks = Object.values(H).filter((h) => nx.text.includes(h.id) || nx.text.includes(h.phone_number) || nx.text.includes(h.twilio_number));
  check(nx.status === 200 && isReject(nx.text) && noPstn(nx.text), 'A5 unassigned DDI → bare <Reject> (unbilled)');
  check(leaks.length === 0 && (!nxr || nxr.household_id === null), 'A5 no household id / number in the response and no reservation attributed to any household');

  // A6 refused: household held
  await q("select public.fc_set_household_hold($1, true, 'byoc e2e hold', 'test', 'admin')", [H.held.id]);
  const hd = await voice(A, { hh: H.held, from: TRUSTED.held, ...asByoc });
  const hdu = await voice(A, { hh: H.held, from: '+447700900703', ...asByoc });
  check(isReject(hd.text) && isReject(hdu.text) && (await activeFor(H.held)).n === 0, 'A6 held household → <Reject> for trusted and unknown BYOC callers, nothing reserved');

  // A7 refused: Fortress (household budget exhausted) for an unknown caller
  await budgetTo(H.budget, 0);
  const bx = await voice(A, { hh: H.budget, from: '+447700900704', ...asByoc });
  check(isReject(bx.text), 'A7 Fortress refusal (household budget exhausted) → <Reject> for an unknown BYOC caller');

  // A8 signatures
  const wrong = await voice(A, { hh: H.unknown, from: '+447700900705', accountSid: BYOC_SID, token: WRONG_TOKEN });
  check(wrong.status === 403 && !streamTokenOf(wrong.text) && !(await reservation(wrong.params.CallSid)), 'A8 BYOC /voice signed with the WRONG account token → 403, no token, nothing reserved');
  const parentSigned = await voice(A, { hh: H.unknown, from: '+447700900706', accountSid: BYOC_SID, token: PARENT_TOKEN });
  check(parentSigned.status === 403 && !(await reservation(parentSigned.params.CallSid)), 'A8 request signed with the PARENT token when only the subaccount token is configured → 403');
  const parentClaim = await voice(A, { hh: H.unknown, from: '+447700900707', accountSid: PARENT_SID, token: PARENT_TOKEN });
  check(parentClaim.status === 403, 'A8 request claiming the parent AccountSid, parent-signed, on a subaccount-only deployment → 403');
  const unsigned = await voice(A, { hh: H.unknown, from: '+447700900708', accountSid: BYOC_SID, token: null });
  check(unsigned.status === 403, 'A8 unsigned BYOC /voice → 403');
  const forgedEnd = await postSigned(A.port, '/call-delivery-failed', byocDialActionParams({ callSid: newCallSid(), to: H.unknown.twilio_number, from: '+447700900709', accountSid: BYOC_SID }), WRONG_TOKEN);
  check(forgedEnd.status === 403, 'A8 /call-delivery-failed signed with the wrong token → 403');

  // A9 worst case: 10 concurrent BYOC calls to one DDI
  const burst = await concurrencyBurst(A, H.conc, { accountSid: BYOC_SID, token: BYOC_TOKEN, n: 10, callerBase: '+4477009008' });
  check(burst.delivered.length >= 1 && burst.delivered.length <= 3 && burst.delivered.length + burst.refused.length === 10,
    `A9 10 simultaneous BYOC calls → ${burst.delivered.length} delivered (≤ 3 per-household concurrency), ${burst.refused.length} <Reject>`);
  check(burst.act.n === burst.delivered.length && burst.act.s <= 50 + 1e-9, `A9 Fortress: ${burst.act.n} active reservations = delivered calls, Σ reserved £${burst.act.s.toFixed(4)} within the £50 household budget`);
  check(burst.delivered.every((r) => timeLimit(r.text) > 0), 'A9 every admitted call carries a <Dial timeLimit> backstop');
  for (const r of burst.delivered) await dialEnded(A, r.params, BYOC_TOKEN);

  // ── A / WS6 — number canonicalisation & BYOC household lookup ─────────
  section('A / WS6 — EXPECTED-FAIL-UNTIL-WS6 (reported, strict with BYOC_E2E_STRICT=1)');
  const n1 = await voice(A, { hh: H.trust, from: callerVariants(TRUSTED.national).national, ...asByoc });
  expectWs6('W1', connectsTo(n1.text, H.trust) && !monitored(n1.text), 'trusted contact stored +44…, BYOC caller presented NATIONAL (07…) → trusted bypass');
  if (connectsTo(n1.text, H.trust)) await dialEnded(A, n1.params, BYOC_TOKEN);
  const n2 = await voice(A, { hh: H.trust, from: callerVariants(TRUSTED.idd00).idd00, ...asByoc });
  expectWs6('W2', connectsTo(n2.text, H.trust) && !monitored(n2.text), 'trusted contact stored +44…, BYOC caller presented 0044… → trusted bypass');
  if (connectsTo(n2.text, H.trust)) await dialEnded(A, n2.params, BYOC_TOKEN);
  const n3 = await voice(A, { hh: H.trust, from: `sip:${callerVariants(TRUSTED.sipUri).national}@hcg.sip.ie1.twilio.com;user=phone`, ...asByoc });
  expectWs6('W3', connectsTo(n3.text, H.trust) && !monitored(n3.text), 'trusted caller presented as a SIP URI (sip:07…@host;user=phone) → canonicalised → trusted bypass');
  if (connectsTo(n3.text, H.trust)) await dialEnded(A, n3.params, BYOC_TOKEN);
  const ddiNoPlus = H.ddiForms.twilio_number.slice(1);
  const d1 = await voice(A, { hh: H.ddiForms, to: ddiNoPlus, from: '+447700900710', ...asByoc });
  expectWs6('W4', connectsTo(d1.text, H.ddiForms), `BYOC To without the plus (${ddiNoPlus}, Magrathea Request-URI form) → household resolved and delivered`);
  if (connectsTo(d1.text, H.ddiForms)) await dialEnded(A, d1.params, BYOC_TOKEN);
  const d2 = await voice(A, { hh: H.ddiForms, to: `sip:${H.ddiForms.twilio_number}@hcg.sip.ie1.twilio.com`, from: '+447700900711', ...asByoc });
  expectWs6('W5', connectsTo(d2.text, H.ddiForms), 'BYOC To as a SIP URI (sip:+44…@hcg.sip.ie1.twilio.com — the host contains a digit) → household resolved and delivered');
  if (connectsTo(d2.text, H.ddiForms)) await dialEnded(A, d2.params, BYOC_TOKEN);
  const d3 = await voice(A, { hh: H.ddiForms, to: `0044${H.ddiForms.twilio_number.slice(3)}`, from: '+447700900712', ...asByoc });
  expectWs6('W6', connectsTo(d3.text, H.ddiForms), 'BYOC To in 0044… form → household resolved and delivered');
  if (connectsTo(d3.text, H.ddiForms)) await dialEnded(A, d3.params, BYOC_TOKEN);
  const s1 = await voice(A, { hh: H.unknown, from: 'sip:anonymous@anonymous.invalid', ...asByoc });
  const s1r = await reservation(s1.params.CallSid);
  expectWs6('W7', connectsTo(s1.text, H.unknown) && monitored(s1.text) && s1r && s1r.is_known === false, 'withheld caller presented as sip:anonymous@… → delivered, monitored, never trusted');
  if (connectsTo(s1.text, H.unknown)) await dialEnded(A, s1.params, BYOC_TOKEN);
  expectWs6('W8', /INBOUND NUMBERS CANONICALISED/.test(A.logs()) && !/INBOUND NUMBERS CANONICALISED[^\n]*\+?44770090/.test(A.logs()), 'canonicalisation is logged (field + form) and never logs a caller number');

  // A10 kill switch (last in A: the incident state is cached for 5 s)
  section('A / CORE — kill switch');
  await q("select public.fc_set_kill_switch(true, 'byoc e2e emergency stop', 'tester')");
  await sleep(5200);
  const kt = await voice(A, { hh: H.kill, from: TRUSTED.kill, ...asByoc });
  const ku = await voice(A, { hh: H.kill, from: '+447700900713', ...asByoc });
  check(isReject(kt.text) && isReject(ku.text), 'A10 Fortress kill switch on → every BYOC call <Reject>, trusted caller included');
  await q("select public.fc_set_kill_switch(false, 'byoc e2e emergency stop over', 'tester')");

  check(allTwiml.every(noPstn), `A egress: no response contained a PSTN/SIP/conference leg (${allTwiml.length} responses)`);
  check(netBlocked(A).length === 0, `A no outbound network attempt was made (NET_BLOCKED lines: ${netBlocked(A).length})`);
} finally {
  A.stop();
}

// ═════════════════════════════════════════════════════════════════════════
// B — TWO ACCOUNTS (primary hosted numbers + TWILIO_BYOC_* subaccount)
// ═════════════════════════════════════════════════════════════════════════
await sleep(5200); // let the kill-switch reset outlive any cached incident state
const B = await bootServer(world, TWO_ACCOUNT_ENV);
try {
  section('B / CORE — two accounts: must hold before and after WS6');
  const hostedOk = await voice(B, { hh: H.hosted, from: '+447700900720', accountSid: PARENT_SID, token: PARENT_TOKEN });
  check(hostedOk.status === 200 && connectsTo(hostedOk.text, H.hosted), 'B1 control: Twilio-hosted call on the primary account, primary-signed → delivered (BYOC config does not disturb hosted numbers)');
  if (connectsTo(hostedOk.text, H.hosted)) await dialEnded(B, hostedOk.params, PARENT_TOKEN);
  const crossSigned = await voice(B, { hh: H.hosted, from: '+447700900721', accountSid: PARENT_SID, token: BYOC_TOKEN });
  check(crossSigned.status === 403, 'B2 request CLAIMING the primary account but signed with the BYOC token → 403 (BYOC token never validates primary traffic)');
  const wrongB = await voice(B, { hh: H.twoAcct, from: '+447700900722', accountSid: BYOC_SID, token: WRONG_TOKEN });
  check(wrongB.status === 403 && !(await reservation(wrongB.params.CallSid)), 'B3 BYOC-account request signed with a wrong token → 403, nothing reserved');
  const otherAcct = await voice(B, { hh: H.twoAcct, from: '+447700900723', accountSid: `AC${'9'.repeat(32)}`, token: WRONG_TOKEN });
  check(otherAcct.status === 403, 'B4 request from an unconfigured third account → 403');

  section('B / WS6 — EXPECTED-FAIL-UNTIL-WS6 (multi-token signatures)');
  const bu = await voice(B, { hh: H.twoAcct, from: '+447700900724', accountSid: BYOC_SID, token: BYOC_TOKEN });
  const btok = streamTokenOf(bu.text);
  expectWs6('W9', bu.status === 200 && connectsTo(bu.text, H.twoAcct) && monitored(bu.text) && Boolean(btok), `BYOC-subaccount /voice signed with TWILIO_BYOC_AUTH_TOKEN → accepted: announcement + stream token + Client (status ${bu.status})`);
  const bur = await reservation(bu.params.CallSid);
  expectWs6('W10', bur && bur.state === 'active' && bur.monitored === true && bur.household_id === H.twoAcct.id, 'BYOC-subaccount unknown call → Fortress reservation active and monitored');
  if (btok) {
    const bg = await wsProbe(B.port, [startFrame('MZbyocB1', bu.params.CallSid, { streamToken: btok })], { holdMs: 2500 });
    const brp = await wsProbe(B.port, [startFrame('MZbyocB2', bu.params.CallSid, { streamToken: btok })]);
    expectWs6('W11', bg.opened && !bg.closedByServer && brp.closedByServer, 'stream token issued under a BYOC-subaccount call → accepted once, refused on replay');
  } else {
    expectWs6('W11', false, 'stream token issued under a BYOC-subaccount call → accepted once, refused on replay (no token issued)');
  }
  const bend = await dialEnded(B, bu.params, BYOC_TOKEN);
  expectWs6('W12', bend.status === 200 && (await waitState(bu.params.CallSid, 'settled', 20))?.state === 'settled', `BYOC-subaccount /call-delivery-failed signed with the BYOC token → 200 and settles (status ${bend.status})`);
  const bstat = await postSigned(B.port, '/call-status', byocCallStatusParams({ callSid: newCallSid(), to: H.twoAcct.twilio_number, from: '+447700900725', accountSid: BYOC_SID }), BYOC_TOKEN);
  expectWs6('W13', bstat.status === 200, `BYOC-subaccount /call-status signed with the BYOC token → 200 (status ${bstat.status})`);
  const bt = await voice(B, { hh: H.twoAcct, from: callerVariants(TRUSTED.twoAcct).national, accountSid: BYOC_SID, token: BYOC_TOKEN });
  expectWs6('W14', connectsTo(bt.text, H.twoAcct) && !monitored(bt.text), 'BYOC-subaccount trusted caller (national presentation) → bypass');
  if (connectsTo(bt.text, H.twoAcct)) await dialEnded(B, bt.params, BYOC_TOKEN);
  // Worst case in two-account mode: the REST client is bound to the PRIMARY
  // account, so provider truth for BYOC-subaccount calls is invisible to the
  // abuse layer's live-call verification (WS6 documents this limitation).
  const burstB = await concurrencyBurst(B, H.concB, { accountSid: BYOC_SID, token: BYOC_TOKEN, n: 10, callerBase: '+4477009009' });
  expectWs6('W15', burstB.delivered.length >= 1 && burstB.delivered.length <= 3 && burstB.act.s <= 50 + 1e-9,
    `two-account worst case: 10 simultaneous BYOC-subaccount calls → ${burstB.delivered.length} delivered (must be ≤ 3), Σ reserved £${burstB.act.s.toFixed(4)} ≤ £50`);
  for (const r of burstB.delivered) await dialEnded(B, r.params, BYOC_TOKEN);
  check(netBlocked(B).length === 0, `B no outbound network attempt was made (NET_BLOCKED lines: ${netBlocked(B).length})`);
} finally {
  B.stop();
}

const inv = (await q('select public.fc_check_invariants() as r'))[0]?.r;
check(inv && (inv.ok === true || inv.violations === 0 || (Array.isArray(inv.violations) && inv.violations.length === 0)), `Fortress invariants hold after the whole run (${JSON.stringify(inv).slice(0, 120)})`);

await world.close();
const s = R.summary();
console.log(`\n${s.failures === 0 ? 'BYOC e2e: all strict checks passed' : `BYOC e2e: ${s.failures} strict check(s) FAILED`}`);
process.exitCode = s.failures === 0 ? 0 : 1;
