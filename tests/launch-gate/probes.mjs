// Executable launch-gate probes against the CURRENT working tree.
//
// Each probe returns { id, scenarios, controls, kind, status, detail }:
//   status PASS     — the probed property holds in this tree
//   status FAIL     — the probed property is violated (a real gap)
//   status UNPROVEN — the probe could not run (target code absent/changed)
//   kind 'behavioural' — calls real module code with fakes (no network)
//   kind 'static'      — inspects source text; weaker, and named as such
//
// Probes never make network calls, never read .env, never touch a DB.
// They are designed to be re-run unchanged on the integrated branch: a
// probe that FAILs on main should PASS once the owning workstream lands.

import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { duplicatesInTree } from './lib/migrations.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(ROOT, 'package.json'));
const read = rel => readFileSync(join(ROOT, rel), 'utf8');

// Some modules construct a Supabase client at require time. Dummy values
// only — guarantees nothing real can be reached even if a .env existed.
process.env.SUPABASE_URL = 'https://launch-gate-dummy.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'launch-gate-dummy';
process.env.SUPABASE_ANON_KEY = 'launch-gate-dummy';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.RESEND_API_KEY;
delete process.env.Resend_API_Key;

/** Source text of an Express route registration up to the next top-level app.<verb>( */
function routeSource(src, method, path) {
  const marker = `app.${method}("${path}"`;
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const rest = src.slice(start + marker.length);
  const next = rest.search(/\napp\.(get|post|put|delete|patch|use|all)\(/);
  return marker + (next < 0 ? rest : rest.slice(0, next));
}

const probes = [];
const probe = (meta, fn) => probes.push({ ...meta, fn });

// ---------------------------------------------------------------- SECURITY

probe({ id: 'PR-01', scenarios: ['S12', 'S20'], controls: ['A1'], kind: 'static',
  title: 'Every Twilio-facing HTTP webhook rejects requests without a valid Twilio signature' }, () => {
  const src = read('server.js');
  const routes = ['/voice', '/process', '/red-line-terminate', '/call-delivery-failed', '/call-status'];
  const unguarded = [];
  for (const r of routes) {
    const s = routeSource(src, 'post', r);
    if (s === null) continue; // route removed entirely is acceptable
    const firstLine = s.split('\n')[0];
    const middlewareGuard = /signature|twilioguard|requiretwilio|twilioWebhookGuard/i.test(firstLine);
    const inlineReject = /isGenuineTwilioRequest[\s\S]{0,400}status\(403\)|status\(403\)[\s\S]{0,200}signature/i.test(s);
    if (!middlewareGuard && !inlineReject) unguarded.push(r);
  }
  // A router-level guard (app.use(twilioSignatureGuard...)) also counts.
  const routerGuard = /app\.use\([^)]*(twilioSignatureGuard|requireTwilioSignature)/.test(src);
  if (routerGuard) return { status: 'PASS', detail: 'router-level Twilio signature guard present' };
  return unguarded.length
    ? { status: 'FAIL', detail: `no enforced signature check on: ${unguarded.join(', ')}` }
    : { status: 'PASS', detail: 'all Twilio webhook routes present enforce a signature' };
});

probe({ id: 'PR-02', scenarios: ['S12', 'S20'], controls: ['A1', 'C7'], kind: 'static',
  title: '/media-stream never takes the SMS destination or household from client-supplied stream parameters' }, () => {
  const p = 'services/liveMonitoring/mediaStreamHandler.js';
  if (!existsSync(join(ROOT, p))) return { status: 'UNPROVEN', detail: `${p} not found` };
  const src = read(p);
  const bad = [];
  if (/customParameters\.toNumber/.test(src)) bad.push('toNumber (SMS destination)');
  if (/customParameters\.householdId/.test(src)) bad.push('householdId');
  if (/customParameters\.protectedNumber/.test(src)) bad.push('protectedNumber (SMS sender)');
  return bad.length
    ? { status: 'FAIL', detail: `unauthenticated WebSocket start message controls: ${bad.join(', ')}` }
    : { status: 'PASS', detail: 'stream identity not read from customParameters' };
});

probe({ id: 'PR-03', scenarios: ['S5'], controls: ['C3'], kind: 'behavioural',
  title: 'A foreign number never matches a UK trusted contact (caller-ID tail collision)' }, () => {
  const { normaliseNumber } = require('./services/phone.js');
  const uk = '07700900123';
  const pairs = [['+17700900123', 'US +1 770…'], ['+337700900123', 'FR +33 7…'], ['+6177009001230'.slice(0, 13), 'AU']];
  const collide = pairs.filter(([f]) => normaliseNumber(f) === normaliseNumber(uk)).map(([, l]) => l);
  return collide.length
    ? { status: 'FAIL', detail: `trusted-contact matching (last 10 digits) treats ${collide.join(', ')} as the UK contact ${uk}` }
    : { status: 'PASS', detail: 'no cross-country tail collision' };
});

// ---------------------------------------------------------- TELEPHONY FRAUD

probe({ id: 'PR-04', scenarios: ['S3', 'S4'], controls: ['C1', 'C2'], kind: 'behavioural',
  title: 'Customer-supplied destination numbers reject premium-rate, personal, and non-geographic high-cost ranges' }, () => {
  const { normaliseUkPhoneToE164 } = require('./services/phone.js');
  const high = ['09001234567', '09098790000', '08712345678', '07012345678', '+447012345678', '+449001234567', '0044 908 123 4567'];
  const accepted = high.filter(n => normaliseUkPhoneToE164(n) !== null);
  return accepted.length
    ? { status: 'FAIL', detail: `accepted as a household destination number: ${accepted.join(', ')}` }
    : { status: 'PASS', detail: 'all high-cost ranges rejected' };
});

probe({ id: 'PR-05', scenarios: ['S3', 'S4', 'S9', 'S10'], controls: ['C1', 'C2', 'C4'], kind: 'static',
  title: 'No call path places an outbound PSTN leg (TwiML <Number> or REST calls.create)' }, () => {
  const files = ['server.js', ...['services', 'routes', 'database'].flatMap(d => walk(d))];
  const hits = [];
  for (const f of files) {
    const s = read(f);
    s.split('\n').forEach((line, i) => {
      if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) return;
      if (/\bdial\.number\(|\.calls\.create\(|\bdial\.sip\(/.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  return hits.length
    ? { status: 'FAIL', detail: `outbound PSTN/SIP leg found — each needs a destination allow-list + cost gate: ${hits.join(', ')}` }
    : { status: 'PASS', detail: 'no outbound PSTN/SIP leg in server/services/routes/database' };
});

probe({ id: 'PR-06', scenarios: ['S8', 'S26'], controls: ['B1'], kind: 'static',
  title: 'Every TwiML <Dial> carries a timeLimit (hard PSTN duration bound, independent of monitoring)' }, () => {
  const src = read('server.js');
  const dials = [...src.matchAll(/twiml\.dial\(([^)]*)\)/g)].map(m => m[1]);
  if (!dials.length) return { status: 'UNPROVEN', detail: 'no twiml.dial( found in server.js' };
  const missing = dials.filter(a => !/timeLimit/.test(a));
  return missing.length
    ? { status: 'FAIL', detail: `${missing.length}/${dials.length} <Dial> without timeLimit — the 30-min monitoring cap does not end the PSTN leg` }
    : { status: 'PASS', detail: `${dials.length} <Dial> all carry timeLimit` };
});

probe({ id: 'PR-07', scenarios: ['S14'], controls: ['C7'], kind: 'behavioural',
  title: 'Number purchase that succeeds but whose DB assignment throws/times out is released (no orphan rental)' }, async () => {
  const { ensureTwilioNumberProvisioned } = require('./services/twilioProvisioning.js');
  let removed = 0;
  let purchased = 0;
  const client = {
    availablePhoneNumbers: () => ({ local: { list: async () => [{ phoneNumber: '+441000000001' }] } }),
    incomingPhoneNumbers: Object.assign(
      sid => ({ remove: async () => { removed++; } }),
      { create: async () => { purchased++; return { sid: 'PN_fake', phoneNumber: '+441000000001' }; } }
    ),
  };
  const r = await ensureTwilioNumberProvisioned(
    { id: 'hh-orphan', twilio_number: null, twilio_provisioning_attempts: 0 },
    { client, assign: async () => { throw new Error('simulated DB timeout'); }, recordFailure: async () => {}, sendAlert: async () => {}, appUrl: 'https://example.invalid' }
  );
  if (!purchased) return { status: 'UNPROVEN', detail: `purchase never attempted (result ${JSON.stringify(r)})` };
  return removed
    ? { status: 'PASS', detail: 'purchased number released after assignment failure' }
    : { status: 'FAIL', detail: 'number purchased, assignment threw, number NOT released — orphaned rental; retries (max attempts) can repeat this' };
});

probe({ id: 'PR-08', scenarios: ['S22'], controls: ['D7'], kind: 'static',
  title: 'RevenueCat grant path distinguishes SANDBOX from PRODUCTION before granting entitlement or provisioning' }, () => {
  const src = read('routes/mobileApi.js');
  const i = src.indexOf('classification === "grant"');
  if (i < 0) return { status: 'UNPROVEN', detail: 'RevenueCat grant branch not found (refactored?)' };
  const block = src.slice(i, i + 4000);
  const provIdx = block.indexOf('updateTwilioNumberForEntitlementChange');
  if (provIdx < 0) return { status: 'UNPROVEN', detail: 'provisioning call not found in grant branch (refactored?)' };
  // The provisioning call must sit behind an environment decision made earlier in the same branch.
  const before = block.slice(0, provIdx);
  const gated = /(isSandbox|environment)[\s\S]*\b(if|else)\b/.test(before);
  return gated
    ? { status: 'PASS', detail: 'Twilio provisioning in the RevenueCat grant path is gated on event environment (entitlement may still be recorded — scenario S22 needs proof a sandbox entitlement cannot enable cost)' }
    : { status: 'FAIL', detail: 'grant path provisions without an environment gate — sandbox purchase ⇒ real entitlement + real Twilio number' };
});

probe({ id: 'PR-09', scenarios: ['S16'], controls: ['G1', 'E1'], kind: 'static',
  title: 'Inbound routing looks a household up by number with an indexed filter, not a full-table scan' }, () => {
  const src = read('database/households.js');
  const i = src.indexOf('async function getHouseholdByTwilioNumber');
  if (i < 0) return { status: 'UNPROVEN', detail: 'getHouseholdByTwilioNumber not found' };
  const body = src.slice(i, i + 900);
  return /\.select\("\*"\)\s*;/.test(body) && !/\.eq\(|\.in\(|\.match\(|\.rpc\(/.test(body)
    ? { status: 'FAIL', detail: 'unfiltered select("*") over households then in-memory find — subject to the API row cap (Supabase default 1000) and O(n) per call; at scale some households would silently stop receiving calls (inference; not load-tested)' }
    : { status: 'PASS', detail: 'filtered lookup' };
});

probe({ id: 'PR-10', scenarios: [], controls: ['I6'], kind: 'behavioural',
  title: 'This tree has no duplicate migration numbers' }, () => {
  const files = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql'));
  const d = duplicatesInTree(files);
  return d.length
    ? { status: 'FAIL', detail: d.map(x => `${x.number}: ${x.files.join(' + ')}`).join('; ') }
    : { status: 'PASS', detail: `${files.length} top-level migrations, numbers unique` };
});

probe({ id: 'PR-11', scenarios: ['S1', 'S2'], controls: ['A8', 'C8'], kind: 'static',
  title: 'Unauthenticated account-creation and auth endpoints are rate-limited' }, () => {
  const src = read('server.js') + read('routes/mobileApi.js');
  const limiter = /rateLimit\(|express-rate-limit|ipRateLimit|registrationRateLimit/i.test(src);
  return limiter
    ? { status: 'PASS', detail: 'a rate limiter is referenced (verify it covers /register, /api/v1/register, /login, /forgot-password)' }
    : { status: 'FAIL', detail: 'no rate limiter on /register, /api/v1/register, /login, /forgot-password, /resend-confirmation, /api/v1/waiting-list' };
});

probe({ id: 'PR-12', scenarios: ['S18', 'S19', 'S20'], controls: ['B4', 'B5', 'G6'], kind: 'static',
  title: 'A server-side emergency stop exists that refuses new calls/monitoring (not just alerts)' }, () => {
  const files = ['server.js', ...walk('services')];
  const hit = files.find(f => /EMERGENCY_DISABLED|telephony_suspended|monitoring_suspended|killSwitch|KILL_SWITCH/.test(read(f)));
  return hit
    ? { status: 'PASS', detail: `emergency control referenced in ${hit} (manual test M-G6 still required)` }
    : { status: 'FAIL', detail: 'no kill switch / suspension flag in server or services' };
});

function walk(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []
  );
}

export async function runProbes() {
  const out = [];
  for (const p of probes) {
    const { fn, ...meta } = p;
    let r;
    try {
      r = await fn();
    } catch (err) {
      r = { status: 'UNPROVEN', detail: `probe could not run: ${err.message}` };
    }
    out.push({ ...meta, ...r });
  }
  return out;
}
