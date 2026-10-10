// WS1 2026-10-10 — scripts/production/verify-twilio-config-readonly.mjs.
// Stubbed fetch only: no real Twilio request is ever made by this test.
//
// Run: node tests/ws1-twilio-config-verifier.test.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as V from '../scripts/production/verify-twilio-config-readonly.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const AC = 'AC' + '0'.repeat(32);
const SK = 'SK' + 'a'.repeat(32);
const APP = 'https://www.homecallguard.co.uk';
const BIN = 'https://handler.twilio.com/twiml/EH' + 'b'.repeat(32);
const base = ['--account', AC, '--app-url', APP, '--fallback-url', BIN];
const sink = () => { const lines = []; return { lines, fn: (l) => lines.push(String(l)) }; };
const noFetch = () => { throw new Error('fetch must not be called'); };

// TwiML Bin body is exactly the containment checklist's <Reject/>.
const bin = readFileSync(path.join(ROOT, 'scripts', 'production', 'twiml-bin-reject.xml'), 'utf8');
check(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<Response><Reject\/><\/Response>\n$/.test(bin), 'twiml-bin-reject.xml = <Response><Reject/></Response> (unbilled rejection)');

// Default dry-run: no fetch, no credentials.
{
  const o = sink();
  const code = await V.run(base, { env: { TWILIO_AUTH_TOKEN: 'master' }, fetchImpl: noFetch, out: o.fn, err: o.fn });
  check(code === 0 && /DRY RUN/.test(o.lines.join('\n')) && o.lines.filter((l) => /GET https:/.test(l)).length === 5, 'default is a dry run: prints 5 planned GETs, makes no request, reads no credential');
}
// Refusals.
for (const [env, label] of [[{ TWILIO_AUTH_TOKEN: 'master' }, 'only the master auth token'], [{}, 'no read key'], [{ TWILIO_READ_KEY_SID: AC, TWILIO_READ_KEY_SECRET: 's' }, 'a key SID that is not SK…']]) {
  const o = sink();
  const code = await V.run([...base, '--execute'], { env, fetchImpl: noFetch, out: o.fn, err: o.fn });
  check(code === 1 && /REFUSED/.test(o.lines.join('\n')), `--execute refused with ${label}`);
}
{
  const o = sink();
  check(await V.run(['--account', 'ACnope', '--app-url', APP, '--fallback-url', BIN], { fetchImpl: noFetch, out: o.fn, err: o.fn }) === 1, 'malformed account SID refused');
  check(await V.run([...base, '--update'], { fetchImpl: noFetch, out: o.fn, err: o.fn }) === 1, 'unknown option refused');
}
for (const [req, label] of [
  [{ method: 'POST', url: `https://api.twilio.com/2010-04-01/Accounts/${AC}/IncomingPhoneNumbers.json` }, 'POST'],
  [{ method: 'DELETE', url: `https://api.twilio.com/2010-04-01/Accounts/${AC}/Usage/Triggers.json` }, 'DELETE'],
  [{ method: 'GET', url: `https://api.twilio.com/2010-04-01/Accounts/${AC}/Calls.json` }, 'GET Calls (not allowlisted)'],
  [{ method: 'GET', url: 'https://evil.example/2010-04-01/Accounts/x/Balance.json' }, 'foreign host'],
]) check((() => { try { V.assertAllowedRequest(req); return false; } catch (e) { return e instanceof V.RefusalError; } })(), `request refused: ${label}`);

// --execute with a stub Twilio: PASS and STOP evaluation, GET only, secret never printed.
function stubFetch(fixtures, log) {
  return async (url, init) => {
    log.push({ url, method: init.method, auth: init.headers.Authorization });
    const p = new URL(url).pathname;
    const key = Object.keys(fixtures).find((k) => p.endsWith(k));
    return { ok: true, status: 200, json: async () => fixtures[key] };
  };
}
const good = {
  'IncomingPhoneNumbers.json': { incoming_phone_numbers: [{ phone_number: '+441615550100', voice_url: `${APP}/voice`, voice_fallback_url: BIN }], next_page_uri: null },
  'Applications.json': { applications: [{ sid: 'AP' + 'c'.repeat(32), voice_url: `${APP}/voice-sdk-outbound-not-supported`, voice_fallback_url: BIN }] },
  '/Countries': { content: [{ iso_code: 'GB', low_risk_numbers_enabled: false, high_risk_special_numbers_enabled: false, high_risk_tollfraud_numbers_enabled: false }], meta: { next_page_url: null } },
  'Triggers.json': { usage_triggers: [{ sid: 'UT' + 'd'.repeat(32), usage_category: 'totalprice', trigger_by: 'price', trigger_value: '10', recurring: 'daily', callback_url: `${APP}/webhooks/provider-usage-alert` }, { sid: 'UT' + 'e'.repeat(32), usage_category: 'sms-outbound', trigger_by: 'count', trigger_value: '20', recurring: 'daily', callback_url: null }] },
  'Balance.json': { balance: '40.00', currency: 'GBP' },
};
{
  const log = []; const o = sink();
  const code = await V.run([...base, '--execute'], { env: { TWILIO_READ_KEY_SID: SK, TWILIO_READ_KEY_SECRET: 'SUPERSECRETVALUE' }, fetchImpl: stubFetch(good, log), out: o.fn, err: o.fn });
  const text = o.lines.join('\n');
  check(code === 0 && ['C1', 'C2', 'C3', 'C4', 'C5'].every((id) => text.includes(`PASS  ${id}`)), '--execute (stub): all five checks PASS on a correctly contained account');
  check(log.length === 5 && log.every((l) => l.method === 'GET') && log.every((l) => l.auth.startsWith('Basic ')), 'exactly 5 GET requests, authenticated with the read key');
  check(!text.includes('SUPERSECRETVALUE') && !text.includes(Buffer.from(`${SK}:SUPERSECRETVALUE`).toString('base64')) && !text.includes('+441615550100'), 'output never contains the secret, the auth header or a full phone number');
}
{
  const bad = structuredClone(good);
  bad['IncomingPhoneNumbers.json'].incoming_phone_numbers.push({ phone_number: '+447700900999', voice_url: `${APP}/voice`, voice_fallback_url: null });
  bad['/Countries'].content.push({ iso_code: 'CU', low_risk_numbers_enabled: true });
  bad['Triggers.json'].usage_triggers = [];
  const log = []; const o = sink();
  const code = await V.run([...base, '--execute'], { env: { TWILIO_READ_KEY_SID: SK, TWILIO_READ_KEY_SECRET: 'x' }, fetchImpl: stubFetch(bad, log), out: o.fn, err: o.fn });
  const text = o.lines.join('\n');
  check(code === 2 && /STOP  C1  \+44…0999: no fallback/.test(text) && /STOP  C3  outbound voice enabled for: CU/.test(text) && /STOP  C4  missing trigger category: totalprice, sms-outbound/.test(text), '--execute (stub): a number without fallback, an enabled country and missing triggers each STOP');
}

console.log(failures === 0 ? '\nAll WS1 Twilio config verifier checks passed.' : `\n${failures} WS1 Twilio config verifier check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
