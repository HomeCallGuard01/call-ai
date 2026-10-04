// Provider cost paths closed in the soft-launch integration (2026-10-04),
// from docs/integration/2026-10-04-PROVIDER_FINANCIAL_CONTAINMENT_FINAL.md:
//   T4  HCG failure must not create a billable apology/error call
//   T9  dormant /process: no orphan paid route, no unbounded <Dial>
// (T7 SMS: tests/sms-fail-closed-adversarial.test.mjs; T11 usage alert:
//  tests/provider-usage-alert-breaker.test.mjs.)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const { createTwimlEgressGuard, REJECT_TWIML } = require('../services/abuse/twimlEgressGuard');
const { buildIncomingPhoneNumberParams } = require('../services/twilioProvisioning');
const twilio = require('twilio');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

// ── T9: /process ─────────────────────────────────────────────────────────
const proc = server.slice(server.indexOf('app.post("/process"'), server.indexOf('// RED-LINE TERMINATION'));
const gate = proc.indexOf('process.env.PROCESS_ROUTE_ENABLED !== "true"');
check(gate > 0, '/process is gated on PROCESS_ROUTE_ENABLED');
check(gate < proc.indexOf('authorizeSpend') && gate < proc.indexOf('openai.chat') && gate < proc.indexOf('attachLiveMonitoring') && gate < proc.indexOf('dialHouseholdOrFailClosed'), '/process: the gate runs before ANY paid action (AI, monitoring, Dial)');
check(/twiml\.hangup\(\);\s*return sendVoiceTwiml\(req, res, twiml\);/.test(proc.slice(gate, gate + 900)), '/process disabled → <Hangup/> through the egress guard');
check(/max_tokens:\s*5/.test(proc), '/process AI classification has bounded output (max_tokens)');
{
  // Even if re-enabled, the /process TwiML shape (monitoring + Dial with no timeLimit) never leaves.
  const audits = [];
  const guard = createTwimlEgressGuard({ ownHost: 'hcg.test', audit: { record: (r) => audits.push(r) } });
  const t = new twilio.twiml.VoiceResponse();
  t.say('x'); t.start().stream({ url: 'wss://hcg.test/media-stream' });
  const d = t.dial({ action: '/call-delivery-failed', timeout: 20, ringTone: 'uk' }); d.client('household_h1');
  const out = guard(t.toString(), { expectedClientIdentity: 'household_h1', route: '/process' });
  check(out === REJECT_TWIML && audits.some((a) => /dial_without_time_limit/.test(a.facts.violations)), 're-enabled /process shape (Dial without timeLimit) → whole response replaced by unbilled <Reject/>, audited');
  const t2 = new twilio.twiml.VoiceResponse();
  const d2 = t2.dial({ action: '/call-delivery-failed', timeout: 20, timeLimit: 1800 }); d2.client('household_h1');
  check(guard(t2.toString(), { expectedClientIdentity: 'household_h1' }) !== REJECT_TWIML, 'the /voice shape with a Fortress timeLimit still passes');
}
const voice = server.slice(server.indexOf('app.post("/voice"'), server.indexOf('app.post("/webhooks/provider-usage-alert"'));
check(/dialOptions = \{ timeLimit: Math\.min\(admission\.maxCallSeconds, containmentDecision\.timeLimitSeconds\) \}/.test(voice), '/voice Dial timeLimit = min(admission, Fortress reservation)');

// ── T4: HCG failure paths ────────────────────────────────────────────────
const handler = server.slice(server.indexOf('const TWILIO_VOICE_TWIML_ROUTES'), server.indexOf('// START SERVER'));
check(/isTwilioVoiceTwimlRoute\(req\)\)\s*\{\s*return res\.status\(200\)\.type\("text\/xml"\)\.send\(REJECT_TWIML\)/.test(handler), 'unhandled error on a voice webhook → 200 <Reject/> (unbilled), not a 500 Twilio would answer');
for (const r of ['/voice', '/process', '/call-delivery-failed', '/red-line-terminate']) check(handler.includes(`"${r}"`), `${r} is covered by the voice-error <Reject/> handler`);
check(handler.indexOf('REJECT_TWIML') < handler.indexOf('res.status(500)'), 'non-voice routes keep their plain 500');
check(/const \{ REJECT_TWIML \} = require\("\.\/services\/abuse\/twimlEgressGuard"\)/.test(server), 'server.js imports the same REJECT_TWIML the egress guard uses');
const failClosed = server.slice(server.indexOf('"CALL ROUTING ERROR: no household matches the dialled Twilio number"'), server.indexOf('// Restoring progressive monitoring'));
check(/twiml\.reject\(\{ reason: "busy" \}\)/.test(failClosed) && !/twiml\.say\(/.test(failClosed), 'no household for the dialled number → <Reject/>, never an answered apology');
{
  const p = buildIncomingPhoneNumberParams({ phoneNumber: '+447700900123', appUrl: 'https://hcg.test', voiceFallbackUrl: 'https://handler.twilio.com/twiml/EHxxxxxxxx' });
  check(p.voiceFallbackUrl === 'https://handler.twilio.com/twiml/EHxxxxxxxx' && p.voiceFallbackMethod === 'POST', 'TWILIO_VOICE_FALLBACK_URL is set on newly purchased numbers');
  for (const bad of [undefined, '', 'http://insecure.example/x', 'javascript:alert(1)', 'https://a b']) {
    check(!('voiceFallbackUrl' in buildIncomingPhoneNumberParams({ phoneNumber: '+447700900123', appUrl: 'https://hcg.test', voiceFallbackUrl: bad })), `invalid/absent fallback (${JSON.stringify(bad)}) is omitted, not sent`);
  }
}

console.log(failures === 0 ? '\nProvider cost paths: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
