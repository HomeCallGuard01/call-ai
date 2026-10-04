// Staging finding F-1 (Andrew's decision, 2026-10-04): when a household's
// receiving app has never registered, an approved call cannot be delivered.
// HCG must not consume paid resources merely to play an apology, and the
// customer must never be shown as protected in that state.
//   - /voice decides this BEFORE the Fortress reservation, the "monitored"
//     announcement and the media stream → a bare <Reject/> (never answered,
//     never billed); the evidence is still recorded and alerted;
//   - /call-delivery-failed (Dial already running) ends the call with
//     <Hangup/> at once (tests/call-delivery-fallback.test.mjs);
//   - canonical protection: appReachable gate (tests/canonical-protection).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { isUndeliverableNoRegisteredClient, computeProtectionStatus } = require('../services/callRouting');
const { buildVoiceClientIdentity } = require('../services/voiceAccessToken');
const { deriveActivationState } = require('../services/lifecycle/activationState');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const hh = (o = {}) => ({ id: 'hh-f1', self_protecting: true, twilio_number: '+441000000123', twilio_provisioning_status: 'active', voice_client_registered_at: null, ...o });
const id = (h) => buildVoiceClientIdentity(h.id);

// ── The pure decision ────────────────────────────────────────────────────
check(isUndeliverableNoRegisteredClient(hh(), id(hh())) === true, 'self-protecting household, app never registered → undeliverable');
check(isUndeliverableNoRegisteredClient(hh({ voice_client_registered_at: '2026-09-01T00:00:00Z' }), id(hh())) === false, 'app registered (even long ago) → deliverable (Dial)');
check(isUndeliverableNoRegisteredClient(null, null) === false, 'no household → not this branch (handled by the no-household <Reject/>)');

// ── /voice ordering: the reject happens before every paid step ───────────
const server = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const voice = server.slice(server.indexOf('app.post("/voice"'), server.indexOf('app.post("/webhooks/provider-usage-alert"'));
const iUndeliv = voice.indexOf('isUndeliverableNoRegisteredClient(household');
const iReserve = voice.indexOf('containment.authorizeCall(');
const iAnnounce = voice.indexOf('This number is monitored and protected by Home Call Guard');
const iStream = voice.indexOf('attachLiveMonitoring(twiml');
const iDial = voice.indexOf('dialHouseholdOrFailClosed(twiml');
check(iUndeliv > 0 && iUndeliv < iReserve && iUndeliv < iAnnounce && iUndeliv < iStream && iUndeliv < iDial, '/voice: the no-registered-app decision precedes the Fortress reservation, announcement, stream and Dial');
const branch = voice.slice(iUndeliv, voice.indexOf('// FINANCIAL CONTAINMENT — reserve before any HCG-funded spend'));
check(/twiml\.reject\(\{ reason: "busy" \}\);\s*return sendVoiceTwiml\(req, res, twiml/.test(branch) && !/twiml\.say\(/.test(branch), 'the branch answers with a bare <Reject reason="busy"/> — no <Say>, nothing before it');
check(/recordRoutingTelemetry\(household/.test(branch) && /sendCriticalAlert\(\s*"self_protecting_no_registered_client"/.test(branch) && /callAdmission\.end\(/.test(branch), 'still recorded (routing + delivery_failed telemetry), alerted, and the admission session closed');
const fn = server.slice(server.indexOf('function dialHouseholdOrFailClosed('), server.indexOf('// Restoring progressive monitoring'));
check(!/cannot be connected right now/.test(fn), 'dialHouseholdOrFailClosed no longer plays a paid apology in any branch');

// ── Never shown as protected in this state ───────────────────────────────
const p = computeProtectionStatus(hh({ activation_verified_at: '2026-10-01T00:00:00Z', delivery_verified_at: '2026-10-01T00:00:00Z' }), new Date('2026-10-04T12:00:00Z'));
check(p.deliveryReady === false && p.fullyProtected === false, 'legacy status: app not registered → not deliveryReady, not fullyProtected');
const a = deriveActivationState({ household: hh({ id: 'hh-f1', status: 'active', auth_user_id: 'a', email: 'x@example.com', activation_verified_at: '2026-10-01T00:00:00Z' }), entitlements: [{ entitlement_type: 'paid_subscription', status: 'active', source: 'stripe', starts_at: '2026-09-01T00:00:00Z', ends_at: null }], financialHold: null }, new Date('2026-10-04T12:00:00Z'));
check(a.protected === false && a.blockers.includes('appReachable') && a.stage === 'awaiting_app', `canonical status: stage ${a.stage}, blocker appReachable (actionable in customer and admin UX)`);

console.log(failures === 0 ? '\nF-1 no paid apology: all checks hold.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
