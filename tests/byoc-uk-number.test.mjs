// WS6 Magrathea → Twilio BYOC (2026-10-11): UK number canonicalisation for
// inbound calls (services/telephony/ukNumber.js), the webhook-integrity
// middleware's canonicalisation step, household lookup by a Magrathea DDI in any format, and
// trusted-contact matching for national-format callers.
//
// Run: node tests/byoc-uk-number.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { toE164, canonicaliseNumber, sameLine, canonicalInboundValue, canonicaliseInboundParams, unwrapTelephonyUri } = require('../services/telephony/ukNumber.js');
const { createTwilioWebhookIntegrity } = require('../services/abuse/webhookIntegrity.js');
const { getHouseholdByTwilioNumber } = require('../database/households.js');
const { sameNumber } = require('../services/abuse/numberPolicy.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

// ── 1. canonical forms ────────────────────────────────────────────────────
const MOBILE = '+447700900123';
for (const raw of ['+447700900123', '+44 7700 900123', '+44 (0)7700 900123', '07700900123', '07700 900 123', '00447700900123', '447700900123',
  'sip:+447700900123@hcg.sip.ie1.twilio.com', 'sip:07700900123@87.238.72.129;user=phone', 'sips:447700900123@host', 'tel:+447700900123', 'sip:%2B447700900123@host']) {
  check(toE164(raw) === MOBILE, `${JSON.stringify(raw)} → ${MOBILE}`);
}
const DDI = '+443300884327';
for (const raw of ['+443300884327', '03300884327', '443300884327', '00443300884327', 'sip:443300884327@hcg-byoc.sip.ie1.twilio.com', 'sip:+443300884327@hcg-byoc.sip.ie1.twilio.com;transport=udp']) {
  check(toE164(raw) === DDI, `Magrathea DDI form ${JSON.stringify(raw)} → ${DDI}`);
}
check(toE164('01632960123') === '+441632960123', 'UK geographic national 01… → +44');
check(toE164('02079460123') === '+442079460123', 'UK geographic national 02… → +44');
check(toE164('016977 4567') === '+44169774567', '9-digit-NSN geographic area (016977) → +44');
check(unwrapTelephonyUri('sip:+441@ie1.example') === '+441', 'URI host digits are never part of the number');

// ── 2. withheld / malformed / ambiguous never canonicalise ────────────────
for (const w of ['anonymous', 'Anonymous', 'restricted', 'unavailable', 'private', 'withheld', '+266696687', 'sip:anonymous@87.238.72.129']) {
  const c = canonicaliseNumber(w);
  check(c.withheld && c.e164 === null, `${JSON.stringify(w)} is withheld (no E.164)`);
}
for (const bad of [undefined, null, '', '   ', 'client:hh-123', '07700', '+44 07700 900123', '7700900123x', '07700900123#', ['07700900123', '07700900124'], 12345, '<sip:+447700900123@h>']) {
  check(toE164(bad) === null, `${JSON.stringify(bad)} does not canonicalise`);
}

// ── 3. +1 / international collisions ──────────────────────────────────────
check(toE164('+11615550201') === '+11615550201', '+1 number stays +1 (no UK collapse)');
check(!sameLine('+11615550201', '01615550201'), '+1 1615550201 is NOT the UK line 01615550201 (shares last 10 digits)');
check(!sameLine('+33770090012', '07700900123'), 'French number never equals a UK mobile');
check(sameLine('07700900123', '+447700900123') && sameLine('sip:07700900123@h', '0044 7700 900123'), 'same UK line across formats');
check(!sameLine('anonymous', 'anonymous'), 'two withheld values never match');

// ── 4. inbound param rewrite: only non-canonical values change ────────────
check(canonicalInboundValue('+447700900123') === null, 'already E.164 → untouched (Twilio-hosted calls unchanged)');
check(canonicalInboundValue('07700900123') === MOBILE, 'national 07… → E.164');
check(canonicalInboundValue('client:hh-1') === null, 'client: identity never rewritten (SDK-origin check still sees it)');
check(canonicalInboundValue('anonymous') === null, 'plain withheld left exactly as sent');
check(canonicalInboundValue('sip:anonymous@1.2.3.4') === 'anonymous', 'withheld SIP URI → anonymous');
check(canonicalInboundValue('sip:+12025550100@h') === '+12025550100', 'international number inside a SIP URI is unwrapped');
check(canonicalInboundValue('12025550100') === null, 'bare non-UK digits are never guessed');
const twilioHosted = { CallSid: 'CA' + '0'.repeat(32), From: '+447700900123', To: '+441615550201', Caller: '+447700900123', Called: '+441615550201' };
const r0 = canonicaliseInboundParams(twilioHosted);
check(r0.changes.length === 0 && JSON.stringify(r0.params) === JSON.stringify(twilioHosted), 'a Twilio-hosted webhook is passed through byte-for-byte');
const byoc = { CallSid: 'CA' + '1'.repeat(32), From: '07700900123', Caller: '07700900123', To: '443300884327', Called: 'sip:443300884327@hcg-byoc.sip.ie1.twilio.com', ForwardedFrom: '07700900999', AccountSid: 'AC' + '2'.repeat(32) };
const r1 = canonicaliseInboundParams(byoc);
check(r1.params.From === MOBILE && r1.params.Caller === MOBILE && r1.params.To === DDI && r1.params.Called === DDI && r1.params.ForwardedFrom === '+447700900999', 'BYOC webhook: every number field canonicalised');
check(r1.params.AccountSid === byoc.AccountSid && r1.params.CallSid === byoc.CallSid, 'non-number fields untouched');
check(byoc.From === '07700900123', 'the input object is not mutated (pure)');
check(!JSON.stringify(r1.changes).includes('7700900'), 'change log never contains a number');

// ── 5. integrity middleware canonicalises after its checks ────────────────
{
  const logs = [];
  const wi = createTwilioWebhookIntegrity({ config: { twilioAccountSid: byoc.AccountSid, webhookReplayWindowMs: 60000 }, audit: { record: () => {} }, env: {}, log: (l, f) => logs.push([l, f]) });
  const req = { path: '/voice', body: { ...byoc } };
  let nextCalled = false;
  req.get = () => 'sig';
  wi.middleware(req, {}, () => { nextCalled = true; });
  check(nextCalled && req.body.From === MOBILE && req.body.To === DDI, 'integrity middleware rewrites req.body after its checks and calls next()');
  check(req.twilioRawNumberParams && req.twilioRawNumberParams.From === '07700900123', 'raw values kept on req.twilioRawNumberParams');
  check(logs.length === 1 && !JSON.stringify(logs).includes('7700900'), 'one log line, no number in it');
  const req2 = { path: '/voice', body: { ...twilioHosted, AccountSid: byoc.AccountSid }, get: () => 'sig2' };
  wi.middleware(req2, {}, () => {});
  check(logs.length === 1 && req2.twilioRawNumberParams === undefined && req2.body.From === twilioHosted.From, 'Twilio-hosted request: no rewrite, no log');
  const refused = { code: 200, status(c) { refused.code = c; return refused; }, end() { return refused; } };
  const req3 = { path: '/voice', body: { ...byoc, AccountSid: 'AC' + '9'.repeat(32), CallSid: 'CA' + '8'.repeat(32) }, get: () => 'sig3' };
  wi.middleware(req3, refused, () => {});
  check(refused.code === 403 && req3.body.From === '07700900123', 'a refused request is never rewritten');
}

// ── 6. household lookup by a Magrathea DDI in any format ──────────────────
function fakeAdmin(rows) {
  return {
    from() {
      let filtered = rows.slice(); let range = null; let limit = null;
      const q = {
        select() { return q; },
        in(col, vals) { filtered = filtered.filter((r) => vals.includes(r[col])); return q; },
        not(col) { filtered = filtered.filter((r) => r[col] != null); return q; },
        order() { return q; },
        range(a, b) { range = [a, b]; return q; },
        limit(n) { limit = n; return q; },
        then(resolve) { let out = filtered; if (range) out = out.slice(range[0], range[1] + 1); if (limit) out = out.slice(0, limit); resolve({ data: out, error: null }); },
      };
      return q;
    },
  };
}
{
  const rows = [{ id: 'hh-magrathea', twilio_number: DDI }, { id: 'hh-twilio', twilio_number: '+441615550201' }, { id: 'hh-us-lookalike', twilio_number: '+13300884327' }];
  const admin = fakeAdmin(rows);
  for (const to of [DDI, '443300884327', '03300884327', '00443300884327', 'sip:443300884327@hcg-byoc.sip.ie1.twilio.com', 'sip:+443300884327@hcg-byoc.sip.ie1.twilio.com;transport=tls']) {
    const hh = await getHouseholdByTwilioNumber(to, { admin });
    check(hh && hh.id === 'hh-magrathea', `Magrathea DDI as ${JSON.stringify(to)} resolves to its household`);
  }
  check((await getHouseholdByTwilioNumber('+441615550201', { admin })).id === 'hh-twilio', 'existing Twilio-hosted number unchanged');
  check((await getHouseholdByTwilioNumber('+13300884327', { admin })).id === 'hh-us-lookalike', '+1 look-alike resolves only to its own row');
  check(await getHouseholdByTwilioNumber('+11615550201', { admin: fakeAdmin([{ id: 'uk', twilio_number: '+441615550201' }]) }) === null, 'a +1 number sharing the last 10 digits never resolves to the UK HCG number');
  check(await getHouseholdByTwilioNumber('anonymous', { admin }) === null, 'withheld To resolves to nothing');
}

// ── 7. trusted-contact matching for national-format callers ───────────────
// The abuse layer's trusted decision is numberPolicy.sameNumber(contact, from.e164).
{
  const contacts = ['7700900123', '+447700900123', '+12025550100']; // legacy 10-digit UK row, E.164 row, international row
  const fromNational = canonicaliseInboundParams({ From: '07700900123' }).params.From;
  check(sameNumber(contacts[0], fromNational) && sameNumber(contacts[1], fromNational), 'BYOC national caller 07… matches legacy 10-digit AND E.164 stored contacts');
  check(!sameNumber(contacts[0], canonicaliseInboundParams({ From: '+17700900123' }).params.From), '+1 caller sharing the last 10 digits is NOT trusted');
  check(sameNumber(contacts[2], canonicaliseInboundParams({ From: 'sip:+12025550100@h' }).params.From), 'international contact still matches when presented inside a SIP URI');
}

console.log(failures === 0 ? '\nAll BYOC number checks passed.' : `\n${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
