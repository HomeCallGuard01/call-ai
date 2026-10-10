// Every TwiML response HCG can produce is terminal, a <Dial> with a
// Fortress-derived timeLimit, or a bounded (non-looping) chain.
// Written for docs/launch/2026-10-10-TWILIO-DURATION-EVIDENCE.md §3.
//
// Static (source) inventory + behavioural checks on the pure builders and
// the egress guard. Fails if:
//   - a new twiml.dial( site appears, or the one site can emit a <Dial>
//     without the timeLimit passed in from /voice's Fortress decision;
//   - any <Redirect>, <Gather>, <Enqueue>, <Connect> or REST url-redirect is
//     introduced (none exist today; each would need its own bound);
//   - <Pause>/<Record> appear outside their known, bounded, dormant sites;
//   - a Dial action handler can return anything but a terminal response;
//   - the egress guard stops rejecting a <Dial> without a valid timeLimit.
//
// Run with: node tests/twilio-duration-bounds.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

// Strip // and /* */ comments (good enough for this codebase's style; string
// literals containing "//" are URLs only inside quotes — kept by the guard below).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .split('\n')
    .map((l) => { const i = l.search(/(^|[^:"'`])\/\//); return i === -1 ? l : l.slice(0, i + (l[i] === '/' ? 0 : 1)); })
    .join('\n');
}
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(c|m)?js$/.test(f)) out.push(p);
  }
  return out;
}
const SOURCES = ['server.js', ...walk(path.join(ROOT, 'services')).map((p) => path.relative(ROOT, p)), ...walk(path.join(ROOT, 'routes')).map((p) => path.relative(ROOT, p))];
const code = Object.fromEntries(SOURCES.map((f) => [f, stripComments(readFileSync(path.join(ROOT, f), 'utf8'))]));
const sites = (re) => Object.entries(code).flatMap(([f, src]) => [...src.matchAll(re)].map((m) => `${f}:${src.slice(0, m.index).split('\n').length}`));

// ---------------- 1. Verb inventory ----------------
const dialSites = sites(/\btwiml\.dial\(/g);
check(dialSites.length === 1 && dialSites[0].startsWith('server.js:'), `exactly one <Dial> builder in the codebase (${dialSites.join(', ')})`);
check(sites(/\btwiml\.(redirect|gather|enqueue|connect|refer|pay)\(/g).length === 0, 'no <Redirect>/<Gather>/<Enqueue>/<Connect>/<Refer>/<Pay> is ever built (so no TwiML loop exists to bound)');
// Hand-written TwiML documents (strings containing <Response) — e.g. the
// Fortress 'announce' termination and the guard's REJECT_TWIML.
const literalTwiml = Object.entries(code).flatMap(([f, src]) => [...src.matchAll(/(["'`])((?:(?!\1)[^\n])*<Response(?:(?!\1)[^\n])*)\1/g)].map((m) => ({ f, s: m[2] })));
check(literalTwiml.length >= 2 && literalTwiml.every(({ s }) => !/<(Redirect|Gather|Dial|Enqueue|Connect|Pause|Record)\b/.test(s)),
  `hand-written TwiML documents (${literalTwiml.length}: ${[...new Set(literalTwiml.map((x) => x.f))].join(', ')}) contain only terminal verbs`);
const pauseSites = sites(/\btwiml\.pause\(/g);
check(pauseSites.length === 1 && /twiml\.pause\(\{ length: 1 \}\)/.test(code['server.js']), `<Pause> only once, length 1 s (${pauseSites.join(', ')}) — in the dormant /process route`);
const recordSites = sites(/\btwiml\.record\(/g);
check(recordSites.length === 1 && recordSites[0].startsWith('services/callDeliveryFallback.js'), `<Record> only in the non-production voicemail prototype (${recordSites.join(', ')}) — and the egress guard forbids <Record>`);
const restUpdates = sites(/\.calls\([^)]*\)\.update\(/g);
check(restUpdates.every((s) => /services\/(liveMonitoring\/callTermination|containment\/twilioCallControl)\.js/.test(s)),
  `REST call updates only in red-line termination and Fortress termination (${restUpdates.join(', ')})`);
const urlUpdates = sites(/\.update\(\{\s*url:/g);
check(urlUpdates.every((s) => s.startsWith('services/liveMonitoring/callTermination.js')) && /redLineRedirectUrl: buildRedLineTerminateUrl\(APP_URL\)/.test(code['server.js']),
  'the only REST url-redirect targets /red-line-terminate');

// ---------------- 2. The one <Dial>: timeLimit comes from the Fortress decision ----------------
const srv = code['server.js'];
check(/twiml\.dial\(\{ action: "\/call-delivery-failed", timeout: 20, ringTone: "uk", \.\.\.\(dialOptions\.timeLimit \? \{ timeLimit: dialOptions\.timeLimit \} : \{\}\) \}\)/.test(srv),
  '<Dial action="/call-delivery-failed" timeout="20" timeLimit=dialOptions.timeLimit> (no timeLimit ⇒ egress guard rejects the whole response)');
check(/const dialOptions = \{ timeLimit: Math\.min\(admission\.maxCallSeconds, containmentDecision\.timeLimitSeconds\) \};/.test(srv),
  '/voice: timeLimit = min(SAFETY_MAX_CALL_MINUTES×60, fc_authorize_call timeLimitSeconds)');
const voiceBody = srv.slice(srv.indexOf('app.post("/voice"'), srv.indexOf('app.post("/webhooks/provider-usage-alert"'));
const iRefuse = voiceBody.indexOf('if (!containmentDecision.allowed)');
const iDialOpts = voiceBody.indexOf('const dialOptions');
check(iRefuse > 0 && iRefuse < iDialOpts && /if \(!containmentDecision\.allowed\) \{[\s\S]*?twiml\.reject\(\{ reason: "busy" \}\);\s*return sendVoiceTwiml/.test(voiceBody),
  '/voice: a refused Fortress authorisation returns <Reject> before any dial options exist');
const voiceDials = [...voiceBody.matchAll(/dialHouseholdOrFailClosed\(([^)]*)\)/g)].map((m) => m[1]);
check(voiceDials.length === 2 && voiceDials.every((a) => a.trim() === 'twiml, household, dialOptions'), `/voice dials twice (trusted / unknown branch), both with dialOptions (${voiceDials.length})`);
check((voiceBody.match(/return sendVoiceTwiml\(/g) || []).length >= 6 && !/res\.(send|end)\(/.test(voiceBody), '/voice: every exit goes through sendVoiceTwiml (egress guard)');
const processBody = srv.slice(srv.indexOf('app.post("/process"'), srv.indexOf('app.post("/red-line-terminate"'));
check(/if \(process\.env\.PROCESS_ROUTE_ENABLED !== "true"\) \{[\s\S]*?twiml\.hangup\(\);/.test(processBody) && /dialHouseholdOrFailClosed\(twiml, household\)/.test(processBody),
  '/process (dormant): <Hangup/> unless PROCESS_ROUTE_ENABLED; its Dial has no timeLimit → guard turns it into <Reject/>');

// Containment JS: an "allowed" authorisation without a positive integer time limit is never used.
const cjs = code['services/containment/containment.js'];
check(/if \(r\.allowed && !\(Number\.isInteger\(r\.timeLimitSeconds\) && r\.timeLimitSeconds > 0\)\) throw new Error\('authorisation without a valid time limit'\);/.test(cjs),
  'containment.authorizeCall: an allowed answer without a valid time limit is treated as an authority failure (→ degraded mode, reject by default)');

// ---------------- 3. Dial action handlers are terminal ----------------
const { buildDeliveryFailedResponse, MODES } = require('../services/callDeliveryFallback.js');
const twilio = require('twilio');
for (const status of ['completed', 'answered', 'no-answer', 'busy', 'failed', 'canceled', undefined, 'garbage']) {
  const tw = new twilio.twiml.VoiceResponse();
  buildDeliveryFailedResponse(tw, { dialCallStatus: status, mode: MODES.OFF });
  check(tw.toString().endsWith('<Hangup/></Response>') && !/<(Dial|Redirect|Gather|Pause|Play|Say)/.test(tw.toString()),
    `/call-delivery-failed (mode off) DialCallStatus=${status}: bare <Hangup/>`);
}
const vm = new twilio.twiml.VoiceResponse();
buildDeliveryFailedResponse(vm, { dialCallStatus: 'no-answer', mode: MODES.VOICEMAIL_PROTOTYPE });
check(/maxLength="60"/.test(vm.toString()) && vm.toString().endsWith('<Hangup/></Response>'), 'voicemail prototype (never production): <Record maxLength=60> then <Hangup/>');
check(require('../services/callDeliveryFallback.js').resolveFallbackMode({ NODE_ENV: 'production', CALL_DELIVERY_FALLBACK_MODE: 'voicemail_prototype' }) === MODES.OFF, 'voicemail prototype is forced off in production');
for (const route of ['/call-delivery-failed', '/call-status', '/red-line-terminate']) {
  const start = srv.indexOf(`app.post("${route}"`);
  const body = srv.slice(start, srv.indexOf('\n});', start));
  const verbs = [...body.matchAll(/twiml\.(\w+)\(/g)].map((m) => m[1]);
  check(start > 0 && verbs.every((v) => ['hangup', 'say'].includes(v)) && /twiml\.hangup\(\)|buildDeliveryFailedResponse/.test(body),
    `${route}: only ${[...new Set(verbs)].join('/') || 'buildDeliveryFailedResponse'} — terminal`);
}

// ---------------- 4. Egress guard: <Dial> without a valid timeLimit never leaves HCG ----------------
const { inspectTwiml, MAX_DIAL_TIME_LIMIT_SECONDS } = require('../services/abuse/twimlEgressGuard.js');
const ctx = { ownHost: 'hcg.example', expectedClientIdentity: 'household_x' };
const dial = (attrs) => `<?xml version="1.0" encoding="UTF-8"?><Response><Dial action="/call-delivery-failed" timeout="20"${attrs}><Client>household_x</Client></Dial></Response>`;
check(inspectTwiml(dial(' timeLimit="300"'), ctx).ok, 'guard accepts <Dial timeLimit="300">');
for (const [a, why] of [['', 'missing'], [' timeLimit="0"', '0'], [` timeLimit="${MAX_DIAL_TIME_LIMIT_SECONDS + 1}"`, '> 4 h'], [' timeLimit="NaN"', 'NaN'], [' timeLimit="12.5"', 'non-integer']]) {
  check(!inspectTwiml(dial(a), ctx).ok, `guard rejects <Dial> with timeLimit ${why}`);
}
const processTwiml = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>x</Say><Pause length="1"/><Start><Stream url="wss://hcg.example/media-stream"/></Start><Dial action="/call-delivery-failed" timeout="20" ringTone="uk"><Client>household_x</Client></Dial></Response>';
check(!inspectTwiml(processTwiml, ctx).ok, 'guard rejects the dormant /process response (Dial without timeLimit)');
check(!inspectTwiml('<Response><Redirect>https://evil.example/x</Redirect></Response>', ctx).ok, 'guard rejects a foreign <Redirect>');
check(MAX_DIAL_TIME_LIMIT_SECONDS === 14400, 'guard ceiling = 14400 s = 067 max_call_seconds ceiling');

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll Twilio duration-bound checks passed.');
