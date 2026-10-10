#!/usr/bin/env node
// Read-only Twilio configuration verifier — DESIGN + IMPLEMENTATION, NEVER RUN
// (WS1 2026-10-10). Status: written and unit-tested with a stubbed fetch only
// (tests/ws1-twilio-config-verifier.test.mjs). It has never been pointed at a
// real Twilio account.
//
// Purpose: after Andrew's console steps (docs/launch/2026-10-09-PROVIDER-
// CONTAINMENT-CHECKLIST.md §2), independently read back what the console now
// says, so the evidence is not only screenshots:
//   C1 every IncomingPhoneNumber: VoiceUrl → <expected app>/voice, and
//      VoiceFallbackUrl = the <Reject/> Bin URL
//   C2 every TwiML Application (Voice SDK app): VoiceFallbackUrl = Bin URL
//   C3 voice dialing permissions: no country has low-risk/high-risk numbers enabled
//   C4 usage triggers: at least one totalprice (daily) and one sms-outbound
//      trigger; prints each trigger's SID, category, value and callback host
//   C5 balance (read-only figure; auto-recharge is NOT exposed by the API)
// NOT verifiable through the API (console evidence only): messaging geo
// permissions, auto-recharge state, 24-hour max call duration setting.
//
// SAFETY DESIGN
//   - DEFAULT IS --dry-run: prints the exact GET requests it WOULD make and
//     exits. No credential is read and no network request is made.
//   - --execute additionally requires a RESTRICTED read key:
//       TWILIO_READ_KEY_SID (SK…) + TWILIO_READ_KEY_SECRET
//     It refuses if only the master TWILIO_AUTH_TOKEN is available, or if the
//     key SID is not an SK… API key. (Restricted-key permission names must be
//     checked in the Twilio console when the key is created — unverified here.)
//   - Only HTTP GET, only to the allowlisted hosts/paths below
//     (assertAllowedRequest). Never POST/DELETE; never follows a URL that
//     came back in a response except Twilio's own next_page_uri on the same
//     allowlisted path.
//   - Never prints the key secret, auth headers, or phone-number owner data;
//     numbers are printed masked (+44…1234).
//
// Usage:
//   node scripts/production/verify-twilio-config-readonly.mjs \
//     --account AC… --app-url https://www.homecallguard.co.uk \
//     --fallback-url https://handler.twilio.com/twiml/EH…     [--execute]
//
// Exit: 0 all PASS · 2 any STOP · 1 refused / usage error.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class RefusalError extends Error {}

const API = 'https://api.twilio.com';
const VOICE = 'https://voice.twilio.com';

export function plannedRequests(account) {
  if (!/^AC[0-9a-f]{32}$/.test(String(account || ''))) throw new RefusalError('--account must be an AC… account SID (32 hex)');
  return [
    { id: 'C1', url: `${API}/2010-04-01/Accounts/${account}/IncomingPhoneNumbers.json?PageSize=100` },
    { id: 'C2', url: `${API}/2010-04-01/Accounts/${account}/Applications.json?PageSize=100` },
    { id: 'C3', url: `${VOICE}/v1/DialingPermissions/Countries?PageSize=250` },
    { id: 'C4', url: `${API}/2010-04-01/Accounts/${account}/Usage/Triggers.json?PageSize=100` },
    { id: 'C5', url: `${API}/2010-04-01/Accounts/${account}/Balance.json` },
  ];
}

const ALLOWED = [
  /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC[0-9a-f]{32}\/(IncomingPhoneNumbers|Applications|Usage\/Triggers|Balance)\.json(\?[\w=&%.-]*)?$/,
  /^https:\/\/voice\.twilio\.com\/v1\/DialingPermissions\/Countries(\?[\w=&%.-]*)?$/,
];
export function assertAllowedRequest({ method, url }) {
  if (method !== 'GET') throw new RefusalError(`only GET is allowed (got ${method})`);
  if (!ALLOWED.some((re) => re.test(url))) throw new RefusalError(`URL not on the read-only allowlist: ${String(url).slice(0, 120)}`);
  return true;
}

export function resolveCredentials(env) {
  const sid = env.TWILIO_READ_KEY_SID;
  const secret = env.TWILIO_READ_KEY_SECRET;
  if (!sid || !secret) {
    throw new RefusalError(env.TWILIO_AUTH_TOKEN
      ? 'refusing to use the master TWILIO_AUTH_TOKEN; create a restricted read-only API key and set TWILIO_READ_KEY_SID/TWILIO_READ_KEY_SECRET'
      : 'TWILIO_READ_KEY_SID and TWILIO_READ_KEY_SECRET are required with --execute');
  }
  if (!/^SK[0-9a-f]{32}$/.test(sid)) throw new RefusalError('TWILIO_READ_KEY_SID must be an SK… API key SID');
  return { sid, secret };
}

export const maskNumber = (n) => (typeof n === 'string' && n.length > 6 ? `${n.slice(0, 3)}…${n.slice(-4)}` : '…');
const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };

// ── evaluators (pure) ───────────────────────────────────────────────────
export function evaluateNumbers(numbers, { appUrl, fallbackUrl }) {
  const bad = [];
  for (const n of numbers) {
    const problems = [];
    if (n.voice_url !== `${appUrl}/voice`) problems.push(`voice_url host ${hostOf(n.voice_url) || 'none'}`);
    if (n.voice_fallback_url !== fallbackUrl) problems.push(n.voice_fallback_url ? `fallback ${hostOf(n.voice_fallback_url)}` : 'no fallback');
    if (problems.length) bad.push(`${maskNumber(n.phone_number)}: ${problems.join(', ')}`);
  }
  if (!numbers.length) return { id: 'C1', status: 'STOP', detail: 'no numbers returned' };
  return { id: 'C1', status: bad.length ? 'STOP' : 'PASS', detail: bad.length ? bad.join('; ') : `${numbers.length} number(s): /voice + <Reject/> fallback` };
}
export function evaluateApplications(apps, { fallbackUrl }) {
  const voiceApps = apps.filter((a) => a.voice_url);
  const bad = voiceApps.filter((a) => a.voice_fallback_url !== fallbackUrl).map((a) => `${a.sid.slice(0, 6)}… fallback ${a.voice_fallback_url ? hostOf(a.voice_fallback_url) : 'none'}`);
  return { id: 'C2', status: bad.length || !voiceApps.length ? 'STOP' : 'PASS', detail: !voiceApps.length ? 'no TwiML App with a voice URL' : bad.length ? bad.join('; ') : `${voiceApps.length} app(s) with <Reject/> fallback` };
}
export function evaluateDialingPermissions(countries) {
  const on = countries.filter((c) => c.low_risk_numbers_enabled || c.high_risk_special_numbers_enabled || c.high_risk_tollfraud_numbers_enabled).map((c) => c.iso_code);
  return { id: 'C3', status: on.length ? 'STOP' : 'PASS', detail: on.length ? `outbound voice enabled for: ${on.join(', ')}` : `${countries.length} countries, outbound voice off everywhere (GB included)` };
}
export function evaluateTriggers(triggers) {
  const has = (cat) => triggers.some((t) => t.usage_category === cat);
  const missing = ['totalprice', 'sms-outbound'].filter((c) => !has(c));
  const list = triggers.map((t) => `${t.sid.slice(0, 6)}… ${t.usage_category} ${t.trigger_by}≥${t.trigger_value} ${t.recurring || 'once'} → ${hostOf(t.callback_url) || 'email only'}`).join('; ');
  return { id: 'C4', status: missing.length ? 'STOP' : 'PASS', detail: missing.length ? `missing trigger category: ${missing.join(', ')}; have: ${list || 'none'}` : list };
}
export function evaluateBalance(b) {
  return { id: 'C5', status: b && b.balance !== undefined ? 'PASS' : 'STOP', detail: b && b.balance !== undefined ? `balance ${b.balance} ${b.currency} (auto-recharge state is console-only)` : 'no balance returned' };
}

// ── runner ──────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const a = { execute: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--execute') a.execute = true;
    else if (k === '--dry-run') a.execute = false;
    else if (['--account', '--app-url', '--fallback-url'].includes(k)) { a[k.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i]; }
    else throw new RefusalError(`unknown argument "${k}"`);
  }
  return a;
}

export async function run(argv, { env = process.env, fetchImpl = globalThis.fetch, out = console.log, err = console.error } = {}) {
  let args; let plan; let creds = null;
  try {
    args = parseArgs(argv);
    plan = plannedRequests(args.account);
    if (!/^https:\/\/[^\s/]+$/.test(String(args.appUrl || ''))) throw new RefusalError('--app-url must be an https origin with no path');
    if (!/^https:\/\/\S+$/.test(String(args.fallbackUrl || ''))) throw new RefusalError('--fallback-url must be the https URL of the <Reject/> TwiML Bin');
    for (const p of plan) assertAllowedRequest({ method: 'GET', url: p.url });
    if (args.execute) creds = resolveCredentials(env);
  } catch (e) {
    if (e instanceof RefusalError) { err(`✗ REFUSED: ${e.message}`); return 1; }
    throw e;
  }
  if (!args.execute) {
    out('DRY RUN (default) — no credential read, no request made. Would GET:');
    for (const p of plan) out(`  ${p.id}  GET ${p.url}`);
    out('Not verifiable by API (console evidence only): messaging geo permissions, auto-recharge, 24-hour max call duration.');
    return 0;
  }
  const auth = `Basic ${Buffer.from(`${creds.sid}:${creds.secret}`).toString('base64')}`;
  async function getAll(url, key) {
    const items = []; let next = url; let pages = 0;
    while (next && pages++ < 20) {
      assertAllowedRequest({ method: 'GET', url: next });
      const res = await fetchImpl(next, { method: 'GET', headers: { Authorization: auth, Accept: 'application/json' }, redirect: 'error' });
      if (!res.ok) throw new Error(`GET ${new URL(next).pathname} → HTTP ${res.status}`);
      const body = await res.json();
      if (key === null) return body;
      items.push(...(body[key] || []));
      const nextUri = body.next_page_uri || (body.meta && body.meta.next_page_url) || null;
      next = nextUri ? (nextUri.startsWith('http') ? nextUri : `${API}${nextUri}`) : null;
    }
    return items;
  }
  const [c1, c2, c3, c4, c5] = plan;
  const results = [];
  const step = async (id, fn) => { try { results.push(await fn()); } catch (e) { results.push({ id, status: 'STOP', detail: e instanceof RefusalError ? `REFUSED: ${e.message}` : `error: ${e.message}` }); } };
  await step('C1', async () => evaluateNumbers(await getAll(c1.url, 'incoming_phone_numbers'), args));
  await step('C2', async () => evaluateApplications(await getAll(c2.url, 'applications'), args));
  await step('C3', async () => evaluateDialingPermissions(await getAll(c3.url, 'content')));
  await step('C4', async () => evaluateTriggers(await getAll(c4.url, 'usage_triggers')));
  await step('C5', async () => evaluateBalance(await getAll(c5.url, null)));
  for (const r of results) out(`${r.status === 'PASS' ? 'PASS' : 'STOP'}  ${r.id}  ${r.detail}`);
  return results.some((r) => r.status !== 'PASS') ? 2 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
