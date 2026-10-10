// Agent 1 (2026-10-11) — static guard over every COST-CAPABLE surface:
// paid calls, AI, SMS, number purchase, email.
//
// Part A — module inventory. Every source line in server.js, routes/**,
//   services/**, middleware/** that calls a paid provider primitive must sit
//   in an allowlisted module. A NEW call site anywhere fails this test until
//   it is reviewed and added (with its guard) below.
// Part B — routes. Any HTTP route whose handler reaches a cost entry point
//   must be in COST_ROUTES with its guard (signed webhook, auth, admin, rate
//   limit), and every Twilio TwiML route must mount twilioSignatureGuard.
//   The /media-stream WebSocket must authorise each stream by token.
// Part C — outbound / premium / loop structure: no code can place an
//   outbound PSTN/SIP call, the only <Dial> noun is the household <Client>,
//   the provider REST client is built in exactly one place.
// Part D — OpenAI: every spend call site is behind an authorised path.
//
// Complements (does not repeat): ws1-unauthenticated-surface (classified
// unauthenticated routes), ws1-admin-route-guards, twilio-duration-bounds
// (TwiML verbs + egress guard), destination-cost-policy, telephony-abuse-*.
// Run: node tests/agent1-cost-surface-guards.test.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT, listRoutes, hasToken } from './helpers/ws1RouteInventory.mjs';

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') out.push(...walk(p)); } else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const files = [path.join(ROOT, 'server.js'), ...['routes', 'services', 'middleware'].flatMap((d) => walk(path.join(ROOT, d)))];
const SRC = new Map(files.map((f) => [path.relative(ROOT, f), stripComments(readFileSync(f, 'utf8'))]));

// ── Part A: provider primitives → allowed modules ───────────────────────
const PRIMITIVES = {
  'Twilio REST client construction': { re: /\btwilio\(\s*[\w$.]+\s*,/, allow: ['services/twilioClient.js'] },
  'number purchase (incomingPhoneNumbers.create)': { re: /incomingPhoneNumbers(\([^)]*\))?\s*\.create\(/, allow: ['services/twilioProvisioning.js', 'services/telephony/numberProviders/twilio.js'] },
  'SMS send (messages.create)': { re: /messages\s*\.create\(/, allow: ['services/liveMonitoring/smsWarning.js', 'services/liveMonitoring/costCaps.js', 'services/usage/smsBudget.js'] },
  'OUTBOUND call creation (calls.create)': { re: /calls\s*\.create\(/, allow: [] },
  'live-call control (calls(sid).update)': { re: /calls\([^)]*\)\s*\.update\(/, allow: ['services/liveMonitoring/callTermination.js', 'services/containment/twilioCallControl.js'] },
  'OpenAI client construction': { re: /new OpenAI\(/, allow: ['server.js', 'services/healthChecks.js'] },
  'OpenAI paid request': { re: /(chat\.completions|audio\.transcriptions|audio\.translations|responses|embeddings|images|audio\.speech)\s*\.create\(/, allow: ['server.js', 'services/liveMonitoring/transcribeChunk.js'] },
  'email send (Resend / Supabase Auth mailer)': { re: /api\.resend\.com|resetPasswordForEmail\(|auth\.resend\(|auth\.signUp\(|inviteUserByEmail\(/, allow: ['server.js', 'services/registrationRequest.js', 'services/alerting.js', 'services/allowance/allowanceNotices.js', 'services/opsEvents/emailSender.js'] },
  'Twilio API key / subaccount management': { re: /\b(newKeys|keys|accounts)\s*\.create\(|\.accounts\([^)]*\)\s*\.update\(/, allow: [] },
};
for (const [name, { re, allow }] of Object.entries(PRIMITIVES)) {
  const hits = [...SRC].filter(([, s]) => re.test(s)).map(([f]) => f).sort();
  const unexpected = hits.filter((f) => !allow.includes(f));
  check(unexpected.length === 0, `${name}: only in reviewed modules (${allow.join(', ') || 'NONE allowed'})${unexpected.length ? ` — UNREVIEWED: ${unexpected.join(', ')}` : ''}`);
  const stale = allow.filter((f) => !hits.includes(f));
  check(stale.length === 0, `${name}: allowlist has no stale entries${stale.length ? ` (stale: ${stale.join(', ')})` : ''}`);
}

// ── Part B: cost-capable routes ─────────────────────────────────────────
const ENTRY = {
  ai: /\bopenai\.|transcribeClient/,
  number: /ensureTwilioNumberProvisioned|updateTwilioNumberForEntitlementChange|handleProcessedWebhookEvent|purchaseTwilioNumber|provisionNumber/,
  email: /auth\.resend\(|resetPasswordForEmail|auth\.signUp\(|handleRegisterRequest|handleResendConfirmationRequest|sendCriticalAlert|api\.resend\.com/,
  sms: /sendWarningSms|messages\.create|smsBudget/,
  call: /dialHouseholdOrFailClosed|\.dial\(|\.stream\(|calls\([^)]*\)\.update|calls\.create|streamAuth\.issue/,
};
// guard: middleware token that must be in the chain, or `marker` that must be in the handler.
const SIG = { mw: 'twilioSignatureGuard' };
const COST_ROUTES = {
  'POST /voice': { kinds: 'paid call (answer + <Dial><Client>) + stream token + alerts', ...SIG },
  'POST /process': { kinds: 'AI (gpt-4o-mini) — dormant unless PROCESS_ROUTE_ENABLED', ...SIG, marker: 'isSignedTwilioRequest(req)' },
  'POST /call-delivery-failed': { kinds: 'alerts on delivery failure', ...SIG },
  'POST /register': { kinds: 'email (Supabase sign-up mail)', mw: 'RateLimiter.limit(' },
  'POST /resend-confirmation': { kinds: 'email', mw: 'RateLimiter.limit(' },
  'POST /forgot-password': { kinds: 'email', mw: 'RateLimiter.limit(' },
  'POST /api/v1/register': { kinds: 'email', mw: 'RateLimiter.limit(' },
  'POST /api/v1/register/resend': { kinds: 'email', mw: 'RateLimiter.limit(' },
  'POST /admin/api/households/:id/retry-provisioning': { kinds: 'number purchase', mw: 'requireAdmin' },
  'POST /admin/api/households/:id/grant-complimentary': { kinds: 'number purchase (entitlement change)', mw: 'requireAdmin' },
  'POST /admin/api/households/:id/revoke-complimentary': { kinds: 'number release/reconfigure', mw: 'requireAdmin' },
  'GET /billing/reconcile-session': { kinds: 'number purchase after a VERIFIED Stripe session', mw: 'requireAuth' },
  'POST /billing/webhook': { kinds: 'number purchase + alerts', marker: 'stripe.webhooks.constructEvent(' },
  'POST /api/v1/billing/apple/revenuecat-webhook': { kinds: 'number purchase + alerts', marker: 'REVENUECAT_WEBHOOK_AUTHORIZATION' },
};
const routes = listRoutes();
const byFile = new Map();
for (const r of routes) { if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push(r); }
const detected = new Map();
for (const [file, rs] of byFile) {
  const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  rs.sort((a, b) => a.line - b.line);
  rs.forEach((r, i) => {
    // Handler = from the declaration to its closing `});` at column 0 (or the next route).
    let end = i + 1 < rs.length ? rs[i + 1].line - 1 : Math.min(lines.length, r.line + 400);
    for (let j = r.line; j < end; j++) if (/^\}\);?\s*$/.test(lines[j])) { end = j + 1; break; }
    const body = stripComments(lines.slice(r.line - 1, end).join('\n'));
    const kinds = Object.entries(ENTRY).filter(([, re]) => re.test(body)).map(([k]) => k);
    if (kinds.length) detected.set(`${r.method} ${r.path}`, { r, kinds, body });
  });
}
check(detected.size >= 10, `detected ${detected.size} cost-capable HTTP routes`);
for (const [key, { r, kinds, body }] of detected) {
  const g = COST_ROUTES[key];
  if (!g) { check(false, `UNREVIEWED cost-capable route ${key} (${r.file}:${r.line}; reaches ${kinds.join('+')}) — add it to COST_ROUTES with its guard`); continue; }
  const mwOk = !g.mw || (g.mw.endsWith('(') ? r.args.includes(g.mw) : hasToken(r.args, g.mw));
  const markerOk = !g.marker || body.includes(g.marker);
  check(mwOk && markerOk, `${key} [${g.kinds}] guarded by ${[g.mw, g.marker].filter(Boolean).join(' + ')} (${r.file}:${r.line})`);
}
for (const k of Object.keys(COST_ROUTES)) check(detected.has(k), `COST_ROUTES entry ${k} still exists and is still cost-capable (no stale entries)`);
// Every route Twilio fetches TwiML from must be signature-guarded.
const twimlRoutes = routes.filter((r) => r.file === 'server.js' && /VoiceResponse\(\)|text\/xml/.test(r.body.slice(0, 1500)) && r.path !== '/voice-sdk-outbound-not-supported');
check(twimlRoutes.length >= 5, `found ${twimlRoutes.length} TwiML routes`);
for (const r of twimlRoutes) {
  const ok = hasToken(r.args, 'twilioSignatureGuard') || r.body.slice(0, 600).includes('isGenuineTwilioRequest(');
  check(ok, `Twilio-facing route ${r.method} ${r.path} is signature-verified (twilioSignatureGuard or in-handler isGenuineTwilioRequest) (server.js:${r.line})`);
}
const vsdk = routes.find((r) => r.path === '/voice-sdk-outbound-not-supported');
check(vsdk && /rejectResponse\.reject\(\)/.test(vsdk.body) && !/\.dial\(|openai|messages\.create/.test(vsdk.body.slice(0, 400)), '/voice-sdk-outbound-not-supported (unsigned) only ever answers a constant <Reject/>');
// WebSocket /media-stream (AI + SMS): token-authorised per stream.
const server = SRC.get('server.js');
check(/authorizeStream:\s*\(args\)\s*=>\s*streamAuth\.authorize\(args\)/.test(server), '/media-stream: each stream is authorised by the single-use stream token (streamAuth.authorize)');
check(/streamAuth\.issue\(/.test(server) && (server.match(/streamAuth\.issue\(/g) || []).length === 1, 'stream tokens are issued in exactly one place (the signed /voice path)');

// ── Part C: outbound / premium / loop structure ─────────────────────────
const all = [...SRC].map(([f, s]) => ({ f, s }));
check(!all.some(({ s }) => /\.dial\([^)]*\)\s*\.(number|sip|conference|queue)\(|\b\w*[dD]ial\w*\s*\.(number|sip|conference|queue)\(/.test(s)), 'no <Dial><Number>/<Sip>/<Conference>/<Queue> anywhere: HCG never dials PSTN or SIP (forwarding loops impossible by construction)');
check(!all.some(({ s }) => /<Response>[^`'"]*<(Number|Sip|Conference|Queue|Enqueue|Refer)\b/.test(s)), 'no hand-written TwiML (<Response>…) string contains <Number>/<Sip>/<Conference>/<Queue>/<Enqueue>/<Refer>');
const dialFiles = all.filter(({ s }) => /\.dial\(/.test(s)).map(({ f }) => f);
const dialSites = (server.match(/\.dial\(/g) || []).length;
check(dialFiles.length === 1 && dialFiles[0] === 'server.js' && dialSites === 1 && /const dial = twiml\.dial\(\{[^\n]*\}\);\s*\n\s*dial\.client\(plan\.clientIdentity\);\s*\n\s*return;/.test(server),
  'the ONLY <Dial> in the codebase (server.js) rings the household\'s own <Client> and nothing else (never a number)');
check(!all.some(({ f, s }) => f !== 'services/twilioClient.js' && /require\(["']twilio["']\)\s*\(/.test(s)), 'no module builds an ad-hoc Twilio REST client (single source: services/twilioClient.js)');
const np = SRC.get('services/abuse/numberPolicy.js');
check(/PSTN_DIAL/.test(np), 'numberPolicy declares a PSTN_DIAL purpose (destination-cost-policy proves it refuses every destination, incl. ordinary UK mobiles)');
check(/twimlEgressGuard/.test(server) && /sendVoiceTwiml/.test(server), 'every /voice response passes the TwiML egress guard (detail: twilio-duration-bounds)');

// ── Part D: OpenAI ─────────────────────────────────────────────────────
const proc = server.slice(server.indexOf('app.post("/process"'), server.indexOf('app.post("/process"') + 6000);
check(/const aiAuthorized = openai && speech\.length > 5 && isSignedTwilioRequest\(req\)/.test(proc) && /if \(aiAuthorized\)|aiAuthorized \?|aiAuthorized\)/.test(proc), '/process: chat completion only when the request is Twilio-signed AND authorised (aiAuthorized), route dormant by default');
check(/PROCESS_ROUTE_ENABLED/.test(proc), '/process is gated by PROCESS_ROUTE_ENABLED (launchConfig: FATAL if true in production)');
check(/transcribeClient:\s*openai \? createOpenAiTranscribeClient\(openai\) : null/.test(server), 'transcription client is used only by the media-stream handler (token-authorised + Fortress-metered monitoring)');
const hc = SRC.get('services/healthChecks.js');
check(/client\.models\.list\(\)/.test(hc) && !/\.create\(/.test(hc), 'health check uses only the free models.list() (admin page), never a paid request');

console.log(failures === 0 ? '\nAgent 1 cost-surface guards: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
