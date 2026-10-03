// Mobile call-delivery security and reachability (2026-09-30, release
// readiness overnight): Voice SDK client-originated /voice guard, per-household
// rate limits on app routes, Twilio REST negative cache, explicit endpoint
// reachability, push-token rotation re-registration.
//
// Run with: node tests/mobile-call-delivery-security.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from './helpers/fakeSupabase.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(path.join(__dirname, '..', ...p), 'utf8');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { failures++; console.error(`✗ ${message}`); }
}

// --- 1. /voice rejects Voice SDK client-originated requests ---
const { isVoiceSdkClientOriginated } = require('../services/voiceWebhookGuards');
check(isVoiceSdkClientOriginated({ From: 'client:household_abc', To: '+441234567890' }), 'From client:… → client-originated');
check(isVoiceSdkClientOriginated({ From: '+447700900123', Caller: 'CLIENT:household_x' }), 'Caller client:… (any case) → client-originated');
check(!isVoiceSdkClientOriginated({ From: '+447700900123', Caller: '+447700900123' }), 'normal PSTN caller → not client-originated');
check(!isVoiceSdkClientOriginated({ From: 'anonymous' }), 'withheld caller → not client-originated');
check(!isVoiceSdkClientOriginated(null) && !isVoiceSdkClientOriginated({}), 'missing body → not client-originated (normal handling)');

const server = read('server.js');
// Integration 2026-10-03: /voice now sits behind the signature guard + integrity layer.
const voiceStart = server.indexOf('app.post("/voice", twilioSignatureGuard, twilioWebhookIntegrity, async (req, res) => {');
const guardIdx = server.indexOf('if (isVoiceSdkClientOriginated(req.body)) {', voiceStart);
const lookupIdx = server.indexOf('await getHouseholdByTwilioNumber(req.body.To)', voiceStart);
check(voiceStart > 0 && guardIdx > voiceStart && guardIdx < lookupIdx, '/voice guard runs before any household lookup, write or paid step');
const guardBlock = server.slice(guardIdx, server.indexOf('}', server.indexOf('return sendVoiceTwiml', guardIdx)));
check(guardBlock.includes('twiml.reject();') && !/say\(|dial\(|logCall|attachLiveMonitoring/.test(guardBlock), 'guard answers with an unbilled <Reject> only');
const outbound = server.slice(server.indexOf('app.post("/voice-sdk-outbound-not-supported"'), server.indexOf('// PROCESS UNKNOWN CALL'));
check(outbound.includes('rejectResponse.reject();') && !/dial\(|say\(/.test(outbound), 'the TwiML App fallback route exists and rejects (it never reached main before)');

// --- 2. per-household rate limiter ---
const { createHouseholdRateLimiter, LIMITS } = require('../middleware/householdRateLimit');
{
  let t = 0;
  const rl = createHouseholdRateLimiter({ name: 't', limit: 3, windowMs: 1000, now: () => t });
  const results = [1, 2, 3, 4].map(() => rl.check('hh1').allowed);
  check(results.join() === 'true,true,true,false', 'allows up to the limit, then refuses');
  check(rl.check('hh2').allowed, 'limits are per household');
  t = 1000;
  check(rl.check('hh1').allowed, 'window resets');
  const small = createHouseholdRateLimiter({ name: 's', limit: 5, windowMs: 1000, now: () => 0, maxKeys: 2 });
  small.check('a'); small.check('b');
  check(!small.check('c').allowed, 'memory bound: a new key beyond maxKeys fails closed');

  const res = { headers: {}, statusCode: 200, body: null, set(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nextCalled = 0;
  const origErr = console.error; console.error = () => {};
  const mw = createHouseholdRateLimiter({ name: 'm', limit: 1, windowMs: 60000, now: () => 0 }).middleware;
  mw({ household: { id: 'h' } }, res, () => nextCalled++);
  mw({ household: { id: 'h' } }, res, () => nextCalled++);
  console.error = origErr;
  check(nextCalled === 1 && res.statusCode === 429 && res.body.error === 'rate_limited' && res.headers['Retry-After'], 'middleware: 429 + Retry-After over the limit');
  const res2 = { status(c) { this.statusCode = c; return this; }, json() { return this; } };
  mw({}, res2, () => nextCalled++);
  check(res2.statusCode === 401, 'middleware refuses when no authenticated household');
  check(LIMITS.callInviteReports.limit >= 60 && LIMITS.voiceToken.limit >= 24, 'limits leave headroom for real use (hourly token refresh, several reports per call)');
}
const mobileApi = read('routes', 'mobileApi.js');
for (const [route, limiter] of [
  ['router.get("/api/v1/voice/token", requireAuthApi, voiceTokenLimiter, requireEntitlement', 'token'],
  ['router.post("/api/v1/voice/registered", requireAuthApi, voiceRegisteredLimiter, requireEntitlement', 'registered'],
  ['router.post("/api/v1/voice/call-invite-received", requireAuthApi, callInviteReportLimiter', 'invite received'],
  ['router.post("/api/v1/voice/call-invite-outcome", requireAuthApi, callInviteReportLimiter', 'invite outcome'],
  ['router.post("/api/v1/voice/device-readiness", requireAuthApi, deviceReadinessLimiter', 'device readiness'],
]) {
  check(mobileApi.includes(route), `${limiter} route is rate limited per household, after authentication`);
}

// --- 3. Twilio REST negative cache ---
{
  const ev = require('../database/deliveryEvidence');
  ev._resetNegativeLookupCache();
  const CHILD = 'CA' + 'c'.repeat(32);
  let fetches = 0;
  const twilioClient = { calls: () => ({ fetch: async () => { fetches++; throw new Error('not found'); } }) };
  const supabase = createFakeSupabase({ calls: [] });
  const origErr = console.error; console.error = () => {};
  await ev.resolveHouseholdCallSid({ supabase, twilioClient, callSid: CHILD, householdId: 'h1', nowMs: 0 });
  await ev.resolveHouseholdCallSid({ supabase, twilioClient, callSid: CHILD, householdId: 'h1', nowMs: 1000 });
  check(fetches === 1, 'an unknown SID is looked up at Twilio once, not on every report');
  await ev.resolveHouseholdCallSid({ supabase, twilioClient, callSid: CHILD, householdId: 'h2', nowMs: 1000 });
  check(fetches === 2, 'the cache is per household (one household cannot suppress another)');
  await ev.resolveHouseholdCallSid({ supabase, twilioClient, callSid: CHILD, householdId: 'h1', nowMs: 11 * 60 * 1000 });
  check(fetches === 3, 'entries expire after 10 minutes');
  await ev.resolveHouseholdCallSid({ supabase, twilioClient, callSid: 'not-a-sid', householdId: 'h1', nowMs: 0 });
  check(fetches === 3, 'malformed SIDs never reach Twilio');
  console.error = origErr;
  ev._resetNegativeLookupCache();
}

// --- 4. endpoint reachability ---
{
  const { assessEndpointReachability } = require('../services/endpointReachability');
  const now = new Date('2026-09-30T12:00:00Z');
  check(assessEndpointReachability({ lastRegisteredAt: null, now }).reachability === 'unregistered', 'never registered → unregistered');
  check(assessEndpointReachability({ lastRegisteredAt: '2026-09-27T14:13:20Z', health: { state: 'UNREACHABLE', reasons: ['dead token'] }, now }).reachability === 'unreachable', 'UNREACHABLE health → unreachable (registration does not override evidence)');
  check(assessEndpointReachability({ lastRegisteredAt: '2026-09-27T14:13:20Z', health: { state: 'SUSPECT', reasons: [] }, now }).reachability === 'degraded', 'SUSPECT → degraded');
  check(assessEndpointReachability({ lastRegisteredAt: '2026-09-27T14:13:20Z', health: { state: 'HEALTHY', lastSuccessAt: '2026-09-27T11:36:44Z' }, now }).reachability === 'confirmed', '9cb62adb today: delivered 3 days ago → confirmed');
  const old = assessEndpointReachability({ lastRegisteredAt: '2026-08-01T00:00:00Z', health: { state: 'UNKNOWN', lastSuccessAt: null }, now });
  check(old.reachability === 'degraded' && old.registrationAgeDays === 60 && /60 days/.test(old.reasons[0]), 'registered 60 days ago with no delivery since → degraded, not "reachable"');
  check(assessEndpointReachability({ lastRegisteredAt: '2026-09-29T00:00:00Z', health: { state: 'UNKNOWN' }, now }).reachability === 'presumed', 'recent registration, no evidence → presumed (not claimed confirmed)');
  const evidence = read('database', 'deliveryEvidence.js');
  check(/reachability: endpoint\.reachability/.test(evidence), 'delivery health exposes reachability to the dashboard/admin');
}

// --- 5. trace: endpoint_health stage ---
{
  const ev = require('../services/callDeliveryEvents');
  check(ev.EVENTS.ENDPOINT_HEALTH === 'endpoint_health', 'endpoint_health is a trace stage');
  const d = ev.sanitizeDetail('endpoint_health', { reachability: 'degraded', deliveryHealth: 'SUSPECT', deviceReady: 'not_ready', registrationAgeDays: 3, token: 'abc' });
  check(JSON.stringify(d) === '{"reachability":"degraded","deliveryHealth":"SUSPECT","deviceReady":"not_ready","registrationAgeDays":3}', 'endpoint_health detail allow-list (no token or other fields)');
  check(read('supabase', 'migrations', '064_call_delivery_events.sql').includes("'endpoint_health'"), 'migration 064 allows endpoint_health');
  const fn = server.slice(server.indexOf('function recordEndpointHealthTelemetry'), server.indexOf('function recordEndpointHealthTelemetry') + 1500);
  check(fn.includes('.catch(err =>') && !/twiml|res\./.test(fn), 'endpoint health is recorded off the response path and cannot throw into /voice');
}

// --- 6. push-token rotation (mobile) ---
{
  const ts = require('../mobile/node_modules/typescript');
  const js = ts.transpileModule(read('mobile', 'lib', 'registrationFreshness.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'setTimeout', 'clearTimeout', js)(mod, mod.exports, setTimeout, clearTimeout);
  const { hasDeviceTokenChanged } = mod.exports;
  check(hasDeviceTokenChanged('tokA', 'tokB'), 'rotated token → re-register');
  check(!hasDeviceTokenChanged('tokA', 'tokA'), 'same token → no re-register');
  check(!hasDeviceTokenChanged('tokA', null) && !hasDeviceTokenChanged(null, 'tokB') && !hasDeviceTokenChanged('tokA', ''), 'unreadable token never forces re-registration');
  const vc = read('mobile', 'lib', 'voiceClient.ts');
  check(/registeredDeviceToken = await withTimeout\(voice\.getDeviceToken\(\), 2000\)/.test(vc), 'registration records the device token, bounded by a timeout');
  check(/hasDeviceTokenChanged\(registeredDeviceToken, current\)/.test(vc), 'foreground compares tokens and re-registers on change');
  check(!/console\.[a-z]+\([^)]*(registeredDeviceToken|current\b)/.test(vc) && !/beacon\([^)]*(registeredDeviceToken|getDeviceToken)/.test(vc), 'device push token is never logged or beaconed');
  check(/registeredDeviceToken = null;/.test(vc), 'sign-out reset clears the remembered token');
}

// --- 7. token issuance stays household-scoped ---
{
  const tokenRoute = mobileApi.slice(mobileApi.indexOf('router.get("/api/v1/voice/token"'), mobileApi.indexOf('router.get("/api/v1/voice/token"') + 2500);
  check(tokenRoute.includes('householdId: req.household.id') && !/req\.(body|query)\.(identity|household)/.test(tokenRoute), 'Voice identity comes only from the authenticated household, never the request');
}

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
