// Sign-out must remove this device's Twilio push binding (2026-09-29, P0
// call-delivery resilience). Previously every sign-out path reset only
// local state, so the old household's protected calls kept ringing on
// the phone after sign-out, including after a different household
// signed in on the same device. Pure helpers are transpiled from the
// real TypeScript and exercised; call-site ordering is checked in source.
//
// Run with: node tests/mobile-voice-unregister.test.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobile = (...p) => path.join(__dirname, '..', 'mobile', ...p);

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { failures++; console.error(`✗ ${message}`); }
}

const ts = require('../mobile/node_modules/typescript');
const js = ts.transpileModule(readFileSync(mobile('lib', 'registrationFreshness.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'setTimeout', 'clearTimeout', js)(mod, mod.exports, setTimeout, clearTimeout);
const { isInviteForIdentity, withTimeout } = mod.exports;

// --- wrong-household invite guard ---
check(isInviteForIdentity('client:household-aaa', 'household-aaa'), 'invite for this household (client: prefix) → accepted');
check(isInviteForIdentity('household-aaa', 'household-aaa'), 'invite for this household (bare identity) → accepted');
check(!isInviteForIdentity('client:household-bbb', 'household-aaa'), "another household's invite → rejected");
check(isInviteForIdentity('client:household-bbb', null), 'cold start (no registered identity yet) → never rejected');
check(isInviteForIdentity('', 'household-aaa') && isInviteForIdentity(undefined, 'household-aaa'), 'missing callee → never rejected');

// --- bounded best-effort ---
async function asyncChecks() {
  check((await withTimeout(Promise.resolve(7), 50)) === 7, 'withTimeout passes a fast result through');
  let timedOut = false;
  try { await withTimeout(new Promise(() => {}), 20); } catch (e) { timedOut = /timed out/.test(e.message); }
  check(timedOut, 'withTimeout rejects a hung unregister after the bound (sign-out cannot hang)');
  let passedErr = false;
  try { await withTimeout(Promise.reject(new Error('boom')), 50); } catch (e) { passedErr = e.message === 'boom'; }
  check(passedErr, 'withTimeout surfaces the underlying error');
}

// --- voiceClient.ts ---
const vc = readFileSync(mobile('lib', 'voiceClient.ts'), 'utf8');
check(/export async function unregisterForIncomingCalls\(\): Promise<boolean>/.test(vc), 'unregisterForIncomingCalls exported');
const fn = (vc.match(/export async function unregisterForIncomingCalls[\s\S]*?\n\}\n/) || [''])[0];
check(fn.includes('await voice.unregister(retained)') && fn.includes('await voice.unregister(fresh.token)'), 'tries the retained token, then a fresh one');
check(fn.includes('withTimeout(attempt(), UNREGISTER_TIMEOUT_MS)') && /catch \(err\) \{[\s\S]*return false;/.test(fn), 'bounded and never throws');
check(vc.includes('lastRegistrationToken = registeredWith.token;') && vc.includes('registeredIdentity = registeredWith.identity || null;'), 'token and identity retained only after a successful register');
const reset = (vc.match(/export function resetVoiceRegistrationState\(\): void \{[\s\S]*?\n\}/) || [''])[0];
check(reset.includes('lastRegistrationToken = null;') && reset.includes('registeredIdentity = null;'), 'reset clears the retained token and identity');
const inviteHandler = (vc.match(/voice\.on\(Voice\.Event\.CallInvite[\s\S]*?seenCallSids\.has\(callSid\)/) || [''])[0];
check(inviteHandler.includes('isInviteForIdentity(callInvite.getTo(), registeredIdentity)') && inviteHandler.includes('callInvite.reject()'),
  'invite guard runs first in the CallInvite handler and rejects a wrong-household invite');
check(!inviteHandler.includes('reportCallInviteReceived'), 'a wrong-household invite is not reported as this household\'s call');
const web = readFileSync(mobile('lib', 'voiceClient.web.ts'), 'utf8');
check(/export async function unregisterForIncomingCalls\(\): Promise<boolean>/.test(web), 'web stub exports the same function (web bundle keeps building)');

// --- every sign-out path unregisters BEFORE resetting and signing out ---
const sites = [
  ['app/(tabs)/account/index.tsx', /unregisterForIncomingCalls\(\)\.finally\(\(\) => \{\s*resetVoiceRegistrationState\(\);\s*clearSetupCompletedAt\(\);\s*supabase\.auth\.signOut\(\);/],
  ['app/(tabs)/index.tsx', /unregisterForIncomingCalls\(\)\.finally\(\(\) => \{\s*resetVoiceRegistrationState\(\);\s*clearSetupCompletedAt\(\);\s*supabase\.auth\.signOut\(\)\.finally/],
  ['app/(tabs)/account/delete-account.tsx', /await unregisterForIncomingCalls\(\);\s*resetVoiceRegistrationState\(\);\s*clearSetupCompletedAt\(\);\s*await supabase\.auth\.signOut\(\);/],
];
for (const [file, pattern] of sites) {
  const src = readFileSync(mobile(...file.split('/')), 'utf8');
  check(pattern.test(src), `${file}: unregister → reset → sign-out, in that order`);
}

asyncChecks().then(() => {
  if (failures) {
    console.error(`\n✗ ${failures} mobile-voice-unregister checks FAILED`);
    process.exit(1);
  }
  console.log('\n✓ All mobile-voice-unregister checks passed');
});
