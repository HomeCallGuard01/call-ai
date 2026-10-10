// HCG BYOC staging: operations against a Twilio client (WS8, 2026-10-11).
// The client is the official `twilio` npm package (v6) authenticated as the
// hcg-byoc-staging SUBACCOUNT, or a test stub with the same surface. These
// functions are only reached through the CLIs' safety gates.
import { createRequire } from 'node:module';
import { NAMES, plannedAclEntries, plannedTrunk, plannedDomain, plannedTriggers, maskNumber } from './byoc-config.mjs';

export function realClientFactory(sid, token) {
  const require = createRequire(import.meta.url);
  const twilio = require('twilio');
  return twilio(sid, token);
}

export class AbortError extends Error {}

const TRUNK_FIELDS = ['voiceUrl', 'voiceMethod', 'voiceFallbackUrl', 'voiceFallbackMethod', 'statusCallbackUrl', 'statusCallbackMethod', 'cnamLookupEnabled'];
const DOMAIN_FIELDS = ['byocTrunkSid', 'sipRegistration', 'secure', 'emergencyCallingEnabled'];

function drift(actual, planned, fields) {
  const d = {};
  for (const f of fields) if ((actual[f] ?? null) !== (planned[f] ?? null)) d[f] = planned[f];
  return d;
}

/** Preflight shared by setup/verify: the subaccount must not hold hosted numbers. */
async function hostedNumbers(client) {
  return client.incomingPhoneNumbers.list({ limit: 5 });
}

export async function applySetup(client, opts, log) {
  const nums = await hostedNumbers(client);
  if (nums.length) throw new AbortError(`ABORT: the subaccount holds ${nums.length} hosted phone number(s); the BYOC staging subaccount must be empty`);

  // S1/S2 IP ACL
  const acls = (await client.sip.ipAccessControlLists.list()).filter((a) => a.friendlyName === NAMES.acl);
  if (acls.length > 1) throw new AbortError(`ABORT: ${acls.length} IP ACLs named ${NAMES.acl}`);
  const acl = acls[0] || await client.sip.ipAccessControlLists.create({ friendlyName: NAMES.acl });
  log(`${acls[0] ? 'exists ' : 'created'} IP ACL ${acl.sid}`);
  const existingIps = await client.sip.ipAccessControlLists(acl.sid).ipAddresses.list();
  const planned = plannedAclEntries(opts);
  for (const e of planned) {
    const have = existingIps.find((x) => x.ipAddress === e.ip && Number(x.cidrPrefixLength ?? 32) === e.prefix);
    if (have) { log(`exists  ACL entry ${e.ip}/${e.prefix}`); continue; }
    await client.sip.ipAccessControlLists(acl.sid).ipAddresses.create({ friendlyName: e.friendlyName, ipAddress: e.ip, cidrPrefixLength: e.prefix });
    log(`created ACL entry ${e.ip}/${e.prefix}${e.needsConfirmation ? ' (UNCONFIRMED)' : ''}`);
  }
  for (const x of existingIps) {
    if (!planned.some((e) => e.ip === x.ipAddress && e.prefix === Number(x.cidrPrefixLength ?? 32))) log(`WARN    ACL has an unplanned entry ${x.ipAddress}/${x.cidrPrefixLength} — not deleted; verify will FAIL`);
  }

  // S3 trunk
  const want = plannedTrunk(opts);
  const trunks = (await client.voice.v1.byocTrunks.list()).filter((t) => t.friendlyName === NAMES.trunk);
  if (trunks.length > 1) throw new AbortError(`ABORT: ${trunks.length} BYOC trunks named ${NAMES.trunk}`);
  let trunk = trunks[0];
  if (trunk && trunk.connectionPolicySid) throw new AbortError('ABORT: the existing trunk has a connection policy (outbound route) — investigate before continuing');
  if (!trunk) { trunk = await client.voice.v1.byocTrunks.create(want); log(`created BYOC trunk ${trunk.sid}`); }
  else {
    const d = drift(trunk, want, TRUNK_FIELDS);
    if (Object.keys(d).length) { trunk = await client.voice.v1.byocTrunks(trunk.sid).update(d); log(`updated BYOC trunk ${trunk.sid}: ${Object.keys(d).join(', ')}`); }
    else log(`exists  BYOC trunk ${trunk.sid}`);
  }

  // S4 domain
  const wantDomain = plannedDomain(opts, trunk.sid);
  const domains = (await client.sip.domains.list()).filter((x) => x.domainName === opts.domainName);
  let domain = domains[0];
  if (!domain) { domain = await client.sip.domains.create(wantDomain); log(`created SIP domain ${domain.sid} ${opts.domainName}`); }
  else {
    const d = drift(domain, wantDomain, DOMAIN_FIELDS);
    if (Object.keys(d).length) { domain = await client.sip.domains(domain.sid).update(d); log(`updated SIP domain ${domain.sid}: ${Object.keys(d).join(', ')}`); }
    else log(`exists  SIP domain ${domain.sid}`);
  }

  // S5 mapping
  const maps = await client.sip.domains(domain.sid).auth.calls.ipAccessControlListMappings.list();
  if (maps.some((m) => m.sid === acl.sid)) log('exists  domain → ACL mapping');
  else { await client.sip.domains(domain.sid).auth.calls.ipAccessControlListMappings.create({ ipAccessControlListSid: acl.sid }); log('created domain → ACL mapping (calls auth)'); }

  // S6 TwiML app
  if (opts.withSdkApp) {
    const apps = await client.applications.list({ friendlyName: NAMES.twimlApp });
    if (apps.length) log(`exists  TwiML App ${apps[0].sid}`);
    else { const app = await client.applications.create({ friendlyName: NAMES.twimlApp, voiceUrl: opts.sdkAppVoiceUrl, voiceMethod: 'POST' }); log(`created TwiML App ${app.sid} (set TWILIO_VOICE_TWIML_APP_SID on staging)`); }
  }

  // S7 triggers
  const triggers = await client.usage.triggers.list();
  for (const t of plannedTriggers(opts)) {
    const have = triggers.find((x) => x.friendlyName === t.friendlyName);
    if (have) { log(`exists  usage trigger ${have.sid} ${t.friendlyName}`); continue; }
    const c = await client.usage.triggers.create(t);
    log(`created usage trigger ${c.sid} ${t.friendlyName}`);
  }
  log(`S8      BYOC number ${opts.ddi}: no API call (T19). Ask Magrathea to target S:${opts.ddi}@${opts.terminationUri}`);
  return { aclSid: acl.sid, trunkSid: trunk.sid, domainSid: domain.sid };
}

export async function applyTeardown(client, opts, log) {
  for (const t of await client.usage.triggers.list()) {
    if (String(t.friendlyName || '').startsWith(NAMES.triggerPrefix)) { await client.usage.triggers(t.sid).remove(); log(`deleted usage trigger ${t.sid}`); }
  }
  const acl = (await client.sip.ipAccessControlLists.list()).find((a) => a.friendlyName === NAMES.acl);
  const domain = (await client.sip.domains.list()).find((d) => d.domainName === opts.domainName);
  if (domain) {
    if (acl) {
      const maps = await client.sip.domains(domain.sid).auth.calls.ipAccessControlListMappings.list();
      if (maps.some((m) => m.sid === acl.sid)) { await client.sip.domains(domain.sid).auth.calls.ipAccessControlListMappings(acl.sid).remove(); log('removed domain → ACL mapping'); }
    }
    await client.sip.domains(domain.sid).remove(); log(`deleted SIP domain ${domain.sid}`);
  } else log(`absent  SIP domain ${opts.domainName}`);
  const trunk = (await client.voice.v1.byocTrunks.list()).find((t) => t.friendlyName === NAMES.trunk);
  if (trunk) { await client.voice.v1.byocTrunks(trunk.sid).remove(); log(`deleted BYOC trunk ${trunk.sid}`); } else log('absent  BYOC trunk');
  if (acl) { await client.sip.ipAccessControlLists(acl.sid).remove(); log(`deleted IP ACL ${acl.sid}`); } else log('absent  IP ACL');
  const apps = await client.applications.list({ friendlyName: NAMES.twimlApp });
  for (const a of apps) { await client.applications(a.sid).remove(); log(`deleted TwiML App ${a.sid}`); }
}

/** READ-ONLY. Returns [{ name, ok, detail }]. */
export async function verifyConfig(client, opts, { account, productionSid } = {}) {
  const r = [];
  const add = (name, ok, detail = '') => r.push({ name, ok: Boolean(ok), detail });
  if (account) {
    add('Account is a subaccount (owner ≠ self)', account.ownerAccountSid && account.ownerAccountSid !== account.sid, `owner ${account.ownerAccountSid}`);
    add(`Account friendlyName = ${NAMES.subaccount}`, account.friendlyName === NAMES.subaccount, account.friendlyName);
    add('Account is not production', !productionSid || account.sid !== productionSid);
    add('Account status active', account.status === 'active', account.status);
  }
  const nums = await hostedNumbers(client);
  add('No Twilio-hosted numbers in the subaccount', nums.length === 0, `${nums.length}`);

  const acl = (await client.sip.ipAccessControlLists.list()).find((a) => a.friendlyName === NAMES.acl);
  add(`IP ACL ${NAMES.acl} exists`, acl, acl && acl.sid);
  if (acl) {
    const ips = await client.sip.ipAccessControlLists(acl.sid).ipAddresses.list();
    const planned = plannedAclEntries(opts);
    const key = (ip, p) => `${ip}/${Number(p ?? 32)}`;
    const have = new Set(ips.map((x) => key(x.ipAddress, x.cidrPrefixLength)));
    const want = new Set(planned.map((e) => key(e.ip, e.prefix)));
    const missing = [...want].filter((k) => !have.has(k));
    const extra = [...have].filter((k) => !want.has(k));
    add('ACL entries = planned Magrathea signalling set', !missing.length && !extra.length, `missing [${missing.join(' ')}] extra [${extra.join(' ')}]`);
  }

  const trunks = (await client.voice.v1.byocTrunks.list()).filter((t) => t.friendlyName === NAMES.trunk);
  add(`Exactly one BYOC trunk ${NAMES.trunk}`, trunks.length === 1, `${trunks.length}`);
  const trunk = trunks[0];
  if (trunk) {
    const d = drift(trunk, plannedTrunk(opts), TRUNK_FIELDS);
    add('Trunk voice/fallback/status URLs and methods match the plan', !Object.keys(d).length, Object.keys(d).join(', '));
    add('Trunk has NO connection policy (no BYOC outbound)', !trunk.connectionPolicySid, trunk.connectionPolicySid || '');
  }
  const domain = (await client.sip.domains.list()).find((x) => x.domainName === opts.domainName);
  add(`SIP domain ${opts.domainName} exists`, domain, domain && domain.sid);
  if (domain) {
    const d = drift(domain, plannedDomain(opts, trunk ? trunk.sid : null), DOMAIN_FIELDS);
    add('Domain bound to the trunk; registration/emergency off; secure as planned', !Object.keys(d).length, Object.keys(d).join(', '));
    const maps = await client.sip.domains(domain.sid).auth.calls.ipAccessControlListMappings.list();
    add('Domain calls-auth uses exactly our IP ACL', acl && maps.length === 1 && maps[0].sid === acl.sid, maps.map((m) => m.sid).join(' '));
  }
  if (opts.withSdkApp) {
    const apps = await client.applications.list({ friendlyName: NAMES.twimlApp });
    add(`TwiML App ${NAMES.twimlApp} exists with outbound-reject voice URL`, apps.length === 1 && apps[0].voiceUrl === opts.sdkAppVoiceUrl, apps[0] ? apps[0].sid : '');
  }
  const triggers = await client.usage.triggers.list();
  for (const t of plannedTriggers(opts)) {
    const have = triggers.find((x) => x.friendlyName === t.friendlyName);
    const ok = have && have.usageCategory === t.usageCategory && String(have.triggerBy) === t.triggerBy
      && Number(have.triggerValue) === Number(t.triggerValue) && String(have.recurring) === t.recurring && have.callbackUrl === t.callbackUrl;
    add(`Usage trigger "${t.friendlyName}"`, ok, have ? have.sid : 'missing');
  }
  return r;
}

/** READ-ONLY evidence for the 6-call validation: calls (numbers masked) and non-zero usage. */
export async function collectEvidence(client, { since, until }) {
  const calls = await client.calls.list({ startTimeAfter: new Date(`${since}T00:00:00Z`), limit: 200 });
  const rows = calls.map((c) => ({
    sid: c.sid, parentCallSid: c.parentCallSid || null, direction: c.direction, from: maskNumber(c.from), to: maskNumber(c.to), forwardedFrom: maskNumber(c.forwardedFrom || null),
    status: c.status, startTime: c.startTime, duration: c.duration, price: c.price, priceUnit: c.priceUnit,
  }));
  const usage = (await client.usage.records.list({ startDate: since, endDate: until || since, limit: 1000 }))
    .filter((u) => Number(u.price) !== 0 || Number(u.count) !== 0)
    .map((u) => ({ category: u.category, count: u.count, usage: u.usage, usageUnit: u.usageUnit, price: u.price, priceUnit: u.priceUnit }));
  return { calls: rows, usage };
}
