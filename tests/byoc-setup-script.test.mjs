// WS8 BYOC staging scripts (2026-10-11): dry-run default, refusal logic,
// idempotent apply, read-only verify, scoped teardown, no secret output.
// Stubbed Twilio client only — nothing is called on any real account.
import { main as setup } from '../scripts/byoc/twilio-byoc-setup.mjs';
import { main as teardown } from '../scripts/byoc/twilio-byoc-teardown.mjs';
import { main as verify } from '../scripts/byoc/twilio-byoc-verify.mjs';
import { confirmationToken, NAMES, MAGRATHEA_SIGNALLING, maskNumber, parseArgs } from '../scripts/byoc/lib/byoc-config.mjs';

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const PROD = 'AC' + 'a'.repeat(32);
const SUB = 'AC' + 'b'.repeat(32);
const OTHER = 'AC' + 'c'.repeat(32);
const SUB_TOKEN = 'subtoken_' + 'x'.repeat(24);
const PARENT_TOKEN = 'parenttoken_' + 'y'.repeat(20);
const BIN = 'https://handler.twilio.com/twiml/EH' + 'd'.repeat(32);
const APP = 'https://ferret-augmented-distrust.ngrok-free.dev';
const ENV = { TWILIO_BYOC_ACCOUNT_SID: SUB, TWILIO_BYOC_AUTH_TOKEN: SUB_TOKEN, PRODUCTION_TWILIO_ACCOUNT_SID: PROD };
const COMMON = ['--app-url', APP, '--fallback-url', BIN];
const APPLY = [...COMMON, '--apply', '--expect-account', SUB, '--confirm', confirmationToken('APPLY-BYOC', SUB)];

let seq = 0;
const sid = (p) => `${p}${String(++seq).padStart(32, '0')}`;

// In-memory stub of the twilio v6 surface the scripts use. Records every call.
function makeStub({ account = { sid: SUB, ownerAccountSid: PROD, friendlyName: NAMES.subaccount, status: 'active' }, numbers = [], accounts = [] } = {}) {
  const calls = [];
  const db = { acls: [], ips: {}, trunks: [], domains: [], maps: {}, apps: [], triggers: [], accounts: [...accounts] };
  const rec = (op, what) => calls.push(`${op}:${what}`);
  const col = (name, arr, prefix, extra = {}) => {
    const list = async (q = {}) => { rec('list', name); return arr().filter((x) => !q.friendlyName || x.friendlyName === q.friendlyName); };
    const create = async (p) => { rec('create', name); const o = { sid: sid(prefix), ...p }; arr().push(o); return o; };
    const fn = (id) => ({
      update: async (p) => { rec('update', name); const o = arr().find((x) => x.sid === id); Object.assign(o, p); return o; },
      remove: async () => { rec('remove', name); const a = arr(); a.splice(a.findIndex((x) => x.sid === id), 1); return true; },
      fetch: async () => { rec('fetch', name); return arr().find((x) => x.sid === id); },
      ...(extra.child ? extra.child(id) : {}),
    });
    return Object.assign(fn, { list, create });
  };
  const client = {
    api: { v2010: { accounts: Object.assign((id) => ({
      fetch: async () => { rec('fetch', 'account'); return id === account.sid ? account : db.accounts.find((a) => a.sid === id); },
      update: async (p) => { rec('update', 'account'); const a = id === account.sid ? account : db.accounts.find((x) => x.sid === id); Object.assign(a, p); return a; },
    }), {
      list: async (q) => { rec('list', 'accounts'); return db.accounts.filter((a) => a.friendlyName === q.friendlyName); },
      create: async (p) => { rec('create', 'account'); const a = { sid: 'AC' + 'e'.repeat(32), ownerAccountSid: account.sid, status: 'active', authToken: 'NEWSUBTOKEN_SECRET', ...p }; db.accounts.push(a); return a; },
    }) } },
    incomingPhoneNumbers: { list: async () => { rec('list', 'numbers'); return numbers; } },
    sip: {
      ipAccessControlLists: col('acl', () => db.acls, 'AL', { child: (id) => ({ ipAddresses: col('ip', () => (db.ips[id] ||= []), 'IP') }) }),
      domains: col('domain', () => db.domains, 'SD', { child: (id) => ({ auth: { calls: { ipAccessControlListMappings: Object.assign(
        (aclSid) => ({ remove: async () => { rec('remove', 'map'); db.maps[id] = (db.maps[id] || []).filter((m) => m.sid !== aclSid); return true; } }),
        { list: async () => { rec('list', 'map'); return db.maps[id] || []; },
          create: async (p) => { rec('create', 'map'); (db.maps[id] ||= []).push({ sid: p.ipAccessControlListSid }); return { sid: p.ipAccessControlListSid }; } }) } } }) }),
    },
    voice: { v1: { byocTrunks: col('trunk', () => db.trunks, 'BY') } },
    applications: col('app', () => db.apps, 'AP'),
    usage: { triggers: col('trigger', () => db.triggers, 'UT'), records: { list: async () => { rec('list', 'usage'); return [{ category: 'calls-inbound', count: '1', usage: '1', usageUnit: 'minutes', price: '0.003', priceUnit: 'gbp' }, { category: 'sms', count: '0', price: '0' }]; } } },
    calls: { list: async () => { rec('list', 'calls'); return [{ sid: 'CA1', direction: 'inbound', from: '07700900123', to: '+443300884327', status: 'completed', duration: '31', price: '-0.00302', priceUnit: 'GBP' }, { sid: 'CA2', parentCallSid: 'CA1', direction: 'outbound-dial', from: '07700900123', to: 'client:hh', status: 'completed', duration: '30', price: null, priceUnit: 'GBP' }]; } },
  };
  return { client, calls, db, factoryCalls: [] };
}
function harness(stub) {
  const out = []; const errs = []; const creds = [];
  return {
    out, errs, creds,
    io: { log: (s) => out.push(String(s)), err: (s) => errs.push(String(s)), clientFactory: (s, t) => { creds.push([s, t]); return stub.client; } },
    text: () => out.concat(errs).join('\n'),
  };
}
const mutations = (calls) => calls.filter((c) => /^(create|update|remove):/.test(c));

// 1. Dry run is the default and touches nothing
{
  const stub = makeStub(); const h = harness(stub);
  const code = await setup([...COMMON], { env: ENV, ...h.io });
  check(code === 0 && h.creds.length === 0 && stub.calls.length === 0, 'setup: default is DRY RUN — no client created, no API call');
  const t = h.text();
  check(t.includes('POST https://voice.twilio.com/v1/ByocTrunks') && t.includes('/SIP/IpAccessControlLists.json') && t.includes('/Auth/Calls/IpAccessControlListMappings.json') && t.includes('/Usage/Triggers.json'), 'setup dry run prints the exact API endpoints');
  check(t.includes(`${APP}/voice`) && t.includes(BIN) && !t.includes('connectionPolicySid'), 'dry run: trunk voice URL = staging /voice, fallback = TwiML Bin, no connection policy');
  check(MAGRATHEA_SIGNALLING.every((e) => t.includes(e.ip)) && t.includes('NEEDS MAGRATHEA CONFIRMATION') && !t.includes('87.238.77.128'), 'dry run lists the 6 Magrathea SIP IPs, flags unconfirmed ones, excludes subnets by default');
  check(t.includes('S:+443300884327@hcg-byoc-staging.sip.dublin.twilio.com'), 'dry run prints the Magrathea target URI (Dublin edge)');
  check(!t.includes(SUB_TOKEN), 'dry run never prints the auth token');
}
{
  const h = harness(makeStub());
  await setup([...COMMON, '--include-subnets'], { env: ENV, ...h.io });
  check(h.text().includes('87.238.77.128') && h.text().includes('"cidrPrefixLength":26'), '--include-subnets adds the six /26 handbook subnets');
}

// 2. Refusals (no client is ever created)
async function refused(argv, env, label, needle) {
  const stub = makeStub(); const h = harness(stub);
  const code = await setup(argv, { env, ...h.io });
  check(code === 2 && h.creds.length === 0 && (!needle || h.errs.join('\n').includes(needle)), `refuses: ${label}`);
}
await refused([...COMMON, '--apply', '--confirm', confirmationToken('APPLY-BYOC', SUB)], ENV, 'apply without --expect-account', '--expect-account');
await refused([...COMMON, '--apply', '--expect-account', PROD, '--confirm', confirmationToken('APPLY-BYOC', PROD)], { ...ENV, TWILIO_BYOC_ACCOUNT_SID: PROD }, 'expect-account = PRODUCTION', 'PRODUCTION');
await refused([...COMMON, '--apply', '--expect-account', SUB, '--confirm', 'yes'], ENV, 'wrong confirmation token', 'APPLY-BYOC-');
await refused(APPLY, { ...ENV, TWILIO_BYOC_ACCOUNT_SID: OTHER }, 'credentials SID ≠ --expect-account', 'does not match');
await refused(APPLY, { TWILIO_BYOC_ACCOUNT_SID: SUB, TWILIO_BYOC_AUTH_TOKEN: SUB_TOKEN }, 'production SID unknown (cannot be refused)', 'production');
await refused(APPLY, { ...ENV, TWILIO_BYOC_AUTH_TOKEN: '' }, 'missing subaccount token', 'TWILIO_BYOC_AUTH_TOKEN');
await refused(['--apply', '--expect-account', SUB, '--confirm', confirmationToken('APPLY-BYOC', SUB), '--app-url', 'https://homecallguard.co.uk', '--fallback-url', BIN], ENV, 'voice URL on production host', 'PRODUCTION host');
await refused(['--apply', '--expect-account', SUB, '--confirm', confirmationToken('APPLY-BYOC', SUB), '--app-url', 'http://staging.example.dev', '--fallback-url', BIN], ENV, 'non-https voice URL', 'https');
await refused(['--apply', '--expect-account', SUB, '--confirm', confirmationToken('APPLY-BYOC', SUB), '--app-url', APP, '--fallback-url', `${APP}/voice-fallback`], ENV, 'fallback not a TwiML Bin', 'TwiML Bin');

// 3. Account identity as reported by Twilio
for (const [label, account] of [
  ['MAIN account (owner = self)', { sid: SUB, ownerAccountSid: SUB, friendlyName: NAMES.subaccount, status: 'active' }],
  ['wrong friendlyName', { sid: SUB, ownerAccountSid: PROD, friendlyName: 'hcg-runtime', status: 'active' }],
  ['suspended subaccount', { sid: SUB, ownerAccountSid: PROD, friendlyName: NAMES.subaccount, status: 'suspended' }],
]) {
  const stub = makeStub({ account }); const h = harness(stub);
  const code = await setup(APPLY, { env: ENV, ...h.io });
  check(code === 2 && mutations(stub.calls).length === 0, `refuses after fetch: ${label} — no mutation`);
}
{
  const stub = makeStub({ numbers: [{ sid: 'PN1' }] }); const h = harness(stub);
  const code = await setup(APPLY, { env: ENV, ...h.io });
  check(code === 3 && mutations(stub.calls).length === 0, 'aborts when the subaccount holds hosted numbers (isolation) — no mutation');
}

// 4. Apply (stub) creates everything once; re-run is idempotent
const stub = makeStub();
{
  const h = harness(stub);
  const code = await setup(APPLY, { env: ENV, ...h.io });
  check(code === 0, 'apply on a valid subaccount succeeds (stub)');
  check(h.creds.length === 1 && h.creds[0][0] === SUB, 'apply authenticates with the SUBACCOUNT credentials only');
  check(stub.db.trunks.length === 1 && stub.db.trunks[0].voiceUrl === `${APP}/voice` && stub.db.trunks[0].voiceFallbackUrl === BIN && !stub.db.trunks[0].connectionPolicySid, 'trunk created: voice URL, Reject fallback, no connection policy');
  check(stub.db.domains.length === 1 && stub.db.domains[0].byocTrunkSid === stub.db.trunks[0].sid && stub.db.domains[0].sipRegistration === false, 'SIP domain bound to the trunk, registration off');
  check(Object.values(stub.db.ips)[0].length === 6, 'six ACL entries created');
  check(stub.db.triggers.length === 3 && stub.db.apps.length === 1, 'three usage triggers and the SDK TwiML App created');
  check(!h.text().includes(SUB_TOKEN), 'apply output never contains the auth token');
  const before = stub.calls.length;
  const h2 = harness(stub);
  const code2 = await setup(APPLY, { env: ENV, ...h2.io });
  check(code2 === 0 && mutations(stub.calls.slice(before)).length === 0, 'second apply is idempotent: zero create/update/remove');
  stub.db.trunks[0].voiceUrl = 'https://old.example.dev/voice';
  const b2 = stub.calls.length;
  await setup(APPLY, { env: ENV, ...harness(stub).io });
  const m = mutations(stub.calls.slice(b2));
  check(m.length === 1 && m[0] === 'update:trunk' && stub.db.trunks[0].voiceUrl === `${APP}/voice`, 'drifted trunk voice URL is corrected with a single update');
}

// 5. Verify is read-only and detects drift
{
  const VER = [...COMMON, '--expect-account', SUB];
  const b = stub.calls.length; const h = harness(stub);
  const code = await verify(VER, { env: ENV, ...h.io });
  if (code !== 0) console.error(h.text());
  check(code === 0 && h.out.some((l) => /^\d+\/\d+ PASS\./.test(l.trim())), "verify: all PASS on the configured stub");
  check(mutations(stub.calls.slice(b)).length === 0, 'verify makes no create/update/remove call');
  stub.db.trunks[0].connectionPolicySid = 'NY' + '0'.repeat(32);
  Object.values(stub.db.ips)[0].push({ sid: 'IPx', ipAddress: '203.0.113.9', cidrPrefixLength: 32 });
  const h2 = harness(stub);
  const code2 = await verify(VER, { env: ENV, ...h2.io });
  const t = h2.text();
  check(code2 === 1 && /FAIL .*NO connection policy/.test(t) && /FAIL .*ACL entries.*203\.0\.113\.9/.test(t), 'verify FAILs on an outbound connection policy and an unplanned ACL entry');
  stub.db.trunks[0].connectionPolicySid = null; Object.values(stub.db.ips)[0].pop();
  const h3 = harness(stub);
  check(await verify([...COMMON, '--expect-account', PROD], { env: ENV, ...h3.io }) === 2 && h3.creds.length === 0, 'verify refuses the production SID');
  const h4 = harness(stub);
  await verify([...VER, '--calls', '--since', '2026-10-12'], { env: ENV, ...h4.io });
  const ev = h4.text();
  check(ev.includes('*******123') && !ev.includes('07700900123') && ev.includes('client:hh') && ev.includes('calls-inbound') && !ev.includes('"sms"'), 'evidence mode masks caller numbers and lists only non-zero usage');
}

// 6. Teardown: dry run default; apply needs Magrathea confirmation; deletes only our resources
{
  const h = harness(stub); const b = stub.calls.length;
  check(await teardown([...COMMON], { env: ENV, ...h.io }) === 0 && h.creds.length === 0 && stub.calls.length === b, 'teardown: default is DRY RUN — no API call');
  const TD = [...COMMON, '--apply', '--expect-account', SUB, '--confirm', confirmationToken('TEARDOWN-BYOC', SUB)];
  const h2 = harness(stub);
  check(await teardown(TD, { env: ENV, ...h2.io }) === 2 && h2.errs.join(' ').includes('--magrathea-repointed'), 'teardown apply refused without Magrathea re-point confirmation');
  stub.db.trunks.push({ sid: 'BY' + 'f'.repeat(32), friendlyName: 'someone-else-trunk' });
  stub.db.triggers.push({ sid: 'UT' + 'f'.repeat(32), friendlyName: 'HCG daily total spend' });
  const h3 = harness(stub);
  const code = await teardown([...TD, '--magrathea-repointed', '2026-10-13 LKV-51353-279'], { env: ENV, ...h3.io });
  check(code === 0 && stub.db.domains.length === 0 && stub.db.acls.length === 0 && stub.db.apps.length === 0, 'teardown removes our domain, ACL, TwiML App');
  check(stub.db.trunks.length === 1 && stub.db.trunks[0].friendlyName === 'someone-else-trunk' && stub.db.triggers.length === 1 && stub.db.triggers[0].friendlyName === 'HCG daily total spend', 'teardown leaves resources it did not create untouched');
}

// 7. Parent-credential steps
{
  const PENV = { BYOC_PARENT_ACCOUNT_SID: PROD, BYOC_PARENT_AUTH_TOKEN: PARENT_TOKEN };
  const parentStub = makeStub({ account: { sid: PROD, ownerAccountSid: PROD, friendlyName: 'HCG', status: 'active' } });
  const h0 = harness(parentStub);
  check(await setup(['--step', 'subaccount'], { env: PENV, ...h0.io }) === 0 && h0.creds.length === 0, 'subaccount step: dry run by default');
  const h1 = harness(parentStub);
  check(await setup(['--step', 'subaccount', '--apply', '--expect-parent', OTHER, '--confirm', confirmationToken('CREATE-SUBACCOUNT', OTHER)], { env: PENV, ...h1.io }) === 2, 'subaccount step refuses when parent credentials ≠ --expect-parent');
  const h2 = harness(parentStub);
  const ok = await setup(['--step', 'subaccount', '--apply', '--expect-parent', PROD, '--confirm', confirmationToken('CREATE-SUBACCOUNT', PROD)], { env: PENV, ...h2.io });
  check(ok === 0 && parentStub.db.accounts.length === 1 && parentStub.db.accounts[0].friendlyName === NAMES.subaccount, 'subaccount step creates exactly one hcg-byoc-staging subaccount');
  check(!h2.text().includes('NEWSUBTOKEN_SECRET') && !h2.text().includes(PARENT_TOKEN), 'subaccount step never prints the new or parent auth token');
  const h3 = harness(parentStub);
  await setup(['--step', 'subaccount', '--apply', '--expect-parent', PROD, '--confirm', confirmationToken('CREATE-SUBACCOUNT', PROD)], { env: PENV, ...h3.io });
  check(parentStub.db.accounts.length === 1 && h3.text().includes('exists'), 'subaccount step is idempotent');
  const NEWSUB = parentStub.db.accounts[0].sid;
  const h4 = harness(parentStub);
  check(await teardown(['--step', 'suspend', '--apply', '--expect-parent', PROD, '--expect-account', PROD, '--confirm', confirmationToken('SUSPEND-BYOC', PROD)], { env: PENV, ...h4.io }) === 2, 'suspend refuses to suspend the parent');
  const h5 = harness(parentStub);
  check(await teardown(['--step', 'suspend', '--apply', '--expect-parent', PROD, '--expect-account', NEWSUB, '--confirm', confirmationToken('SUSPEND-BYOC', NEWSUB)], { env: PENV, ...h5.io }) === 0 && parentStub.db.accounts[0].status === 'suspended', 'suspend suspends only the named hcg-byoc-staging subaccount');
}

// 8. Helpers
check(maskNumber('+443300884327') === '+*********327' && maskNumber('client:abc') === 'client:abc', 'maskNumber keeps only the last 3 digits');
check(parseArgs(['--apply', '--expect-account=AC1', '--edge', 'ie1']).expectAccount === 'AC1' && parseArgs(['--edge', 'ie1']).edge === 'ie1', 'parseArgs handles --k=v and --k v');

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall BYOC script checks passed');
