// Financial containment P0 — server.js wiring invariants (source-level,
// like tests/financial-safety-callpath.test.mjs: server.js boots a listener
// and real clients on require, so the call path is pinned by structure).
// Run with: node tests/financial-containment-wiring.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const server = readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

function routeBody(route) {
  const start = server.indexOf(`app.post("${route}"`);
  if (start < 0) return '';
  const next = server.indexOf('\napp.', start + 10);
  return server.slice(start, next < 0 ? undefined : next);
}

const voice = routeBody('/voice');
const iAdmit = voice.indexOf('callAdmission.admit(');
const iContain = voice.indexOf('containment.authorizeCall(');
const iRejectContain = voice.indexOf('if (!containmentDecision.allowed)');
const iFirstDial = voice.indexOf('dialHouseholdOrFailClosed(');
const iSay = voice.indexOf('twiml.say(');
check(iContain > iAdmit && iContain > 0, '/voice: containment authorisation runs after 056 admission');
check(iRejectContain > iContain && iRejectContain < iFirstDial && iRejectContain < iSay, '/voice: a refusal returns <Reject> BEFORE any billable verb (<Say>/<Dial>)');
check(/if \(!containmentDecision\.allowed\) \{[\s\S]{0,400}twiml\.reject\(/.test(voice), '/voice: refusal is <Reject> (unbilled)');
check(/timeLimit: Math\.min\(admission\.maxCallSeconds, containmentDecision\.timeLimitSeconds\)/.test(voice), '/voice: Dial timeLimit = min(056 max, containment backstop)');
check(/wantsMonitoring && !containmentDecision\.monitoring/.test(voice), '/voice: no monitoring unless the reservation covers it');
check(/signatureValid: genuineTwilioRequest/.test(voice) && /const genuineTwilioRequest = isGenuineTwilioRequest\(\{/.test(voice), '/voice: signature computed for every request and passed to containment');
check(/containment\.settleCall\(\{ callSid, source: "no_dial" \}\)/.test(server), 'a response without <Dial> settles its reservation immediately');

for (const route of ['/call-delivery-failed', '/call-status']) {
  const body = routeBody(route);
  check(/if \(isSignedTwilioRequest\(req\)\) \{\s*callAdmission\.end[\s\S]{0,200}containment\.settleCall/.test(body), `${route}: only a Twilio-signed callback settles/releases (forged "ended" can't free a live call)`);
  check(!/^\s*callAdmission\.end\(/m.test(body.replace(/if \(isSignedTwilioRequest\(req\)\) \{[\s\S]*?\n  \}/, '')), `${route}: no unsigned path releases the 056 admission session`);
}

const proc = routeBody('/process');
check(/const aiAuthorized = [\s\S]{0,200}isSignedTwilioRequest\(req\)[\s\S]{0,200}containment\.authorizeSpend\(\{ category: "ai"/.test(proc), '/process: paid OpenAI call requires a signed request AND a containment authorisation');
check(/if \(aiAuthorized\) \{\s*try \{\s*const aiResponse = await openai\.chat\.completions\.create/.test(proc), '/process: the OpenAI call sits inside the authorised branch only');

check(/smsClient: containedSmsClient,/.test(server) && !/smsClient: twilioRestClient,/.test(server), 'media streams never get the raw Twilio SMS client');
check(/createSmsBudget\(\{[\s\S]{0,200}containment,/.test(server), 'SMS budget wired to containment (fail-closed, closes the null-period bypass)');
check(/markMonitoringStarted\(params\.callSid\)/.test(server), 'stream attach requires containment confirmation before paid transcription');
check(/containmentSweeper\.start\(\)/.test(server), 'lease sweeper started in every instance');
check(/createTwilioCallControl\(\{\s*client: twilioRestClient/.test(server), 'sweeper ends calls through the provider REST API (parent call)');

const inventory = JSON.parse(readFileSync(path.join(__dirname, '..', 'docs', 'finance', 'cost-surfaces.json'), 'utf8'));
const statuses = Object.keys(inventory.statusKey);
check(inventory.surfaces.length >= 15 && inventory.surfaces.every((x) => statuses.includes(x.status) && x.id && x.cost && x.trigger),
  `cost-surface inventory: ${inventory.surfaces.length} surfaces, every one has a valid status (${statuses.join('/')})`);
check(inventory.surfaces.filter((x) => x.status !== 'ENFORCED').every((x) => x.residual), 'every surface that is not ENFORCED names its residual gap');

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log('\nAll financial-containment wiring checks passed.');
