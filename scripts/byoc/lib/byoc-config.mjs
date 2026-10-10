// HCG Magrathea → Twilio BYOC STAGING: shared plan, constants and safety
// checks (WS8, 2026-10-11). PREPARATION ONLY — nothing here talks to Twilio;
// the CLIs in scripts/byoc/ use it. See docs/launch/2026-10-11-BYOC-STAGING-PREP.md.
//
// Twilio sources (read 2026-10-10/11):
//   BYOC guide            https://www.twilio.com/docs/voice/bring-your-own-carrier-byoc (modified 2026-08-24)
//   ByocTrunk API         https://www.twilio.com/docs/voice/bring-your-own-carrier-byoc/api/byoctrunk-resource (2026-06-22)
//   SIP Domain API        https://www.twilio.com/docs/voice/sip/api/sip-domain-resource (2026-06-22)
//   SIP IpAddress API     https://www.twilio.com/docs/voice/sip/api/sip-ipaddress-resource (2026-06-22)
//   Localized SIP URIs    https://www.twilio.com/docs/voice/api/sending-sip (2026-10-08)
//   Signalling/media IPs  https://www.twilio.com/docs/sip-trunking/ip-addresses (2026-03-09)
//   Subaccounts           https://www.twilio.com/docs/iam/api/subaccounts (2026-09-15)
//   Usage Triggers        https://www.twilio.com/docs/usage/api/usage-trigger (2026-07-31)

export const NAMES = Object.freeze({
  subaccount: 'hcg-byoc-staging',
  trunk: 'hcg-byoc-staging-trunk',
  acl: 'hcg-byoc-staging-magrathea-signalling',
  domainPrefix: 'hcg-byoc-staging',
  twimlApp: 'hcg-byoc-staging-sdk',
  triggerPrefix: 'hcg-byoc-staging',
});

// Magrathea trial DDI 0330 088 4327 (trial account, 2 channels per number).
export const TRIAL_DDI_E164 = '+443300884327';

// Magrathea SIGNALLING sources. Evidence: /Users/ad/call-ai-magrathea-trial
// scripts/carriers/sip-lab/sip_identity.py + docs/carriers/MAGRATHEA-LIVE-CALL-EVIDENCE.md
// (Magrathea Client Handbook 2025.1 "Firewalls and whitelisting"; 4 live calls
// 2026-10-08/09). Every INVITE seen live came from one of the six handbook SIP
// proxies. needsConfirmation = not yet observed live; the whole list is also
// pending Magrathea question M8 (are these IPs shared with other customers?).
export const MAGRATHEA_SIGNALLING = Object.freeze([
  { ip: '87.238.72.129', prefix: 32, evidence: 'handbook + observed live (calls 2 and 4)', needsConfirmation: false },
  { ip: '87.238.73.129', prefix: 32, evidence: 'handbook + observed live (call 1)', needsConfirmation: false },
  { ip: '87.238.73.130', prefix: 32, evidence: 'handbook + observed live (withheld call)', needsConfirmation: false },
  { ip: '87.238.72.130', prefix: 32, evidence: 'handbook only', needsConfirmation: true },
  { ip: '213.166.3.129', prefix: 32, evidence: 'handbook only', needsConfirmation: true },
  { ip: '213.166.3.130', prefix: 32, evidence: 'handbook only', needsConfirmation: true },
]);
// Handbook: traffic "may originate from any of the IP addresses contained in
// the following subnets". Opt-in only (--include-subnets): it widens who can
// reach the trunk (investigation R3). 213.166.4.128/26 carried MEDIA live.
export const MAGRATHEA_SUBNETS = Object.freeze([
  '87.238.72.128/26', '87.238.73.128/26', '87.238.77.128/26',
  '213.166.2.128/26', '213.166.3.128/26', '213.166.4.128/26',
].map((c) => ({ ip: c.split('/')[0], prefix: Number(c.split('/')[1]), evidence: 'handbook subnet (opt-in)', needsConfirmation: true })));

// Twilio Dublin (ie1) edge — from the Elastic SIP Trunking IP page; the BYOC
// guide points there for regional IPs. Twilio: "Avoid sending traffic directly
// to these IP addresses" and static IPs are not offered in IE1 → FQDN preferred.
export const TWILIO_DUBLIN_SIGNALLING = Object.freeze(['54.171.127.192', '54.171.127.193', '54.171.127.194', '54.171.127.195']);
export const TWILIO_MEDIA_RANGE = '168.86.128.0/18 (UDP 10000-60000)';

export const ACCOUNT_SID_RE = /^AC[0-9a-f]{32}$/i;
const TWIML_BIN_RE = /^https:\/\/handler\.twilio\.com\/twiml\/EH[0-9a-f]{32}$/i;
// Production hosts (website + backend on Railway). Staging must never point here.
const PRODUCTION_HOST_RE = /(^|\.)homecallguard\.co\.uk$|\.railway\.app$/i;
const EDGES = new Set(['dublin', 'ashburn', 'ie1', 'us1']);

const BOOLEAN_FLAGS = new Set(['apply', 'dry-run', 'include-subnets', 'json', 'calls', 'help', 'no-sdk-app', 'suspend']);

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = (eq === -1 ? a.slice(2) : a.slice(2, eq));
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq !== -1) out[camel] = a.slice(eq + 1);
    else if (BOOLEAN_FLAGS.has(key)) out[camel] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[camel] = argv[++i];
    else out[camel] = '';
  }
  return out;
}

export function confirmationToken(kind, sid) {
  return `${kind}-${String(sid || '').slice(-6).toUpperCase()}`;
}

/** Never print a secret: drop/mask any key that looks like one, recursively. */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = /token|secret|password|authtoken|apikey/i.test(k) ? '[REDACTED]' : redact(v);
    return o;
  }
  return value;
}

/** Mask a phone number for evidence output: keep the last 3 digits. */
export function maskNumber(n) {
  if (typeof n !== 'string' || !n) return n;
  if (n.startsWith('client:')) return n;
  const digits = n.replace(/\D/g, '');
  if (digits.length < 6) return n;
  return `${n.startsWith('+') ? '+' : ''}${'*'.repeat(digits.length - 3)}${digits.slice(-3)}`;
}

function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }

export function resolveOptions(args, env = process.env) {
  const appUrl = trimSlash(args.appUrl || env.BYOC_STAGING_APP_URL || env.APP_URL || '');
  const base = appUrl || '<STAGING_APP_URL>';
  const edge = String(args.edge || 'dublin').toLowerCase();
  const domainPrefix = String(args.domainPrefix || NAMES.domainPrefix).toLowerCase();
  return {
    appUrl,
    voiceUrl: args.voiceUrl || env.BYOC_STAGING_VOICE_URL || `${base}/voice`,
    statusCallbackUrl: args.statusCallbackUrl || `${base}/call-status`,
    sdkAppVoiceUrl: `${base}/voice-sdk-outbound-not-supported`,
    fallbackUrl: args.fallbackUrl || env.BYOC_REJECT_TWIML_BIN_URL || '<REJECT_TWIML_BIN_URL (TwiML Bin in the subaccount: <Response><Reject/></Response>)>',
    triggerCallbackUrl: args.triggerCallbackUrl || env.BYOC_TRIGGER_CALLBACK_URL || `${base}/webhooks/provider-usage-alert`,
    domainPrefix,
    domainName: `${domainPrefix}.sip.twilio.com`,
    edge,
    terminationUri: `${domainPrefix}.sip.${edge}.twilio.com`,
    includeSubnets: Boolean(args.includeSubnets),
    withSdkApp: !args.noSdkApp,
    ddi: TRIAL_DDI_E164,
  };
}

export function plannedAclEntries(opts) {
  const list = [...MAGRATHEA_SIGNALLING, ...(opts.includeSubnets ? MAGRATHEA_SUBNETS : [])];
  return list.map((e) => ({ ...e, friendlyName: `magrathea-${e.ip}-${e.prefix}${e.needsConfirmation ? '-UNCONFIRMED' : ''}` }));
}

// Breaker triggers for the staging test (£2 approval cap). Values are in the
// account's billing currency (HCG invoices are GBP). Triggers only NOTIFY
// (~1/min evaluation); suspension needs the parent-account breaker.
export function plannedTriggers(opts) {
  const cb = opts.triggerCallbackUrl;
  const p = NAMES.triggerPrefix;
  return [
    { friendlyName: `${p} daily totalprice >= 1.00`, usageCategory: 'totalprice', triggerBy: 'price', triggerValue: '1.00', recurring: 'daily', callbackUrl: cb, callbackMethod: 'POST' },
    { friendlyName: `${p} monthly totalprice >= 2.00`, usageCategory: 'totalprice', triggerBy: 'price', triggerValue: '2.00', recurring: 'monthly', callbackUrl: cb, callbackMethod: 'POST' },
    { friendlyName: `${p} daily calls count >= 12`, usageCategory: 'calls', triggerBy: 'count', triggerValue: '12', recurring: 'daily', callbackUrl: cb, callbackMethod: 'POST' },
  ];
}

export function plannedTrunk(opts) {
  return {
    friendlyName: NAMES.trunk,
    voiceUrl: opts.voiceUrl,
    voiceMethod: 'POST',
    voiceFallbackUrl: opts.fallbackUrl,
    voiceFallbackMethod: 'POST',
    statusCallbackUrl: opts.statusCallbackUrl,
    statusCallbackMethod: 'POST',
    cnamLookupEnabled: false,
    // deliberately NO connectionPolicySid: no BYOC outbound route
  };
}

export function plannedDomain(opts, trunkSid = '<BY… from step 3>') {
  return {
    domainName: opts.domainName,
    friendlyName: NAMES.trunk,
    byocTrunkSid: trunkSid,
    sipRegistration: false,
    secure: false, // TLS/SRTP only after Magrathea confirms an E: (TLS) target (M7)
    emergencyCallingEnabled: false,
  };
}

/** The ordered setup plan, for printing. `sub` = target subaccount SID or placeholder. */
export function buildSetupPlan(opts, sub = '<BYOC_SUBACCOUNT_SID>') {
  const v2010 = `https://api.twilio.com/2010-04-01/Accounts/${sub}`;
  const steps = [
    { id: 'S0', title: 'Preflight (read-only): target is the hcg-byoc-staging SUBACCOUNT, active, holds no hosted numbers', calls: [
      { sdk: `client.api.v2010.accounts('${sub}').fetch()`, http: `GET ${v2010}.json` },
      { sdk: 'client.incomingPhoneNumbers.list({ limit: 5 })  // must be 0', http: `GET ${v2010}/IncomingPhoneNumbers.json` },
    ] },
    { id: 'S1', title: `IP ACL "${NAMES.acl}" (find by friendlyName, else create)`, calls: [
      { sdk: 'client.sip.ipAccessControlLists.create', http: `POST ${v2010}/SIP/IpAccessControlLists.json`, params: { friendlyName: NAMES.acl } },
    ] },
    { id: 'S2', title: 'ACL entries: Magrathea signalling sources (add missing; extras are reported, never deleted)', calls: plannedAclEntries(opts).map((e) => ({
      sdk: "client.sip.ipAccessControlLists('<AL…>').ipAddresses.create",
      http: `POST ${v2010}/SIP/IpAccessControlLists/<AL…>/IpAddresses.json`,
      params: { friendlyName: e.friendlyName, ipAddress: e.ip, cidrPrefixLength: e.prefix },
      note: `${e.evidence}${e.needsConfirmation ? ' — NEEDS MAGRATHEA CONFIRMATION' : ''}`,
    })) },
    { id: 'S3', title: `BYOC trunk "${NAMES.trunk}" (find by friendlyName; create, or update drifted fields). NO connection policy`, calls: [
      { sdk: 'client.voice.v1.byocTrunks.create / (sid).update', http: 'POST https://voice.twilio.com/v1/ByocTrunks', params: plannedTrunk(opts) },
    ] },
    { id: 'S4', title: `Termination SIP domain ${opts.domainName} bound to the trunk (carrier target: ${opts.terminationUri})`, calls: [
      { sdk: 'client.sip.domains.create / (sid).update', http: `POST ${v2010}/SIP/Domains.json`, params: plannedDomain(opts) },
    ] },
    { id: 'S5', title: 'Attach the IP ACL to the domain for CALLS authentication', calls: [
      { sdk: "client.sip.domains('<SD…>').auth.calls.ipAccessControlListMappings.create", http: `POST ${v2010}/SIP/Domains/<SD…>/Auth/Calls/IpAccessControlListMappings.json`, params: { ipAccessControlListSid: '<AL…>' } },
    ] },
  ];
  if (opts.withSdkApp) {
    steps.push({ id: 'S6', title: `TwiML App "${NAMES.twimlApp}" for Voice SDK tokens minted in the subaccount (outbound SDK calls rejected)`, calls: [
      { sdk: 'client.applications.create', http: `POST ${v2010}/Applications.json`, params: { friendlyName: NAMES.twimlApp, voiceUrl: opts.sdkAppVoiceUrl, voiceMethod: 'POST' } },
    ] });
  }
  steps.push({ id: 'S7', title: 'Usage triggers (notify ~1/min; breaker input) — find by friendlyName, else create', calls: plannedTriggers(opts).map((t) => ({
    sdk: 'client.usage.triggers.create', http: `POST ${v2010}/Usage/Triggers.json`, params: t,
  })) });
  steps.push({ id: 'S8', title: `BYOC phone number ${opts.ddi}: NO API CALL — Twilio documents no BYOC number registration (question T19); the trunk's VoiceUrl handles every called number`, calls: [] });
  return steps;
}

export function buildTeardownPlan(opts, sub = '<BYOC_SUBACCOUNT_SID>') {
  const v2010 = `https://api.twilio.com/2010-04-01/Accounts/${sub}`;
  return [
    { id: 'T0', title: 'Precondition: Magrathea has confirmed IN WRITING that 0330 088 4327 no longer targets Twilio (--magrathea-repointed "<date/ref>")', calls: [] },
    { id: 'T1', title: `Delete usage triggers whose friendlyName starts "${NAMES.triggerPrefix}"`, calls: [{ sdk: "client.usage.triggers('<UT…>').remove()", http: `DELETE ${v2010}/Usage/Triggers/<UT…>.json` }] },
    { id: 'T2', title: 'Remove ACL mapping from the domain, then delete the domain', calls: [
      { sdk: "client.sip.domains('<SD…>').auth.calls.ipAccessControlListMappings('<AL…>').remove()", http: `DELETE ${v2010}/SIP/Domains/<SD…>/Auth/Calls/IpAccessControlListMappings/<AL…>.json` },
      { sdk: "client.sip.domains('<SD…>').remove()", http: `DELETE ${v2010}/SIP/Domains/<SD…>.json  (domainName ${opts.domainName} only)` },
    ] },
    { id: 'T3', title: `Delete BYOC trunk "${NAMES.trunk}"`, calls: [{ sdk: "client.voice.v1.byocTrunks('<BY…>').remove()", http: 'DELETE https://voice.twilio.com/v1/ByocTrunks/<BY…>' }] },
    { id: 'T4', title: `Delete IP ACL "${NAMES.acl}" (its entries go with it)`, calls: [{ sdk: "client.sip.ipAccessControlLists('<AL…>').remove()", http: `DELETE ${v2010}/SIP/IpAccessControlLists/<AL…>.json` }] },
    { id: 'T5', title: `Delete TwiML App "${NAMES.twimlApp}"`, calls: [{ sdk: "client.applications('<AP…>').remove()", http: `DELETE ${v2010}/Applications/<AP…>.json` }] },
    { id: 'T6', title: 'OPTIONAL --step suspend (PARENT credentials): suspend the subaccount. In-progress calls do NOT end (Twilio doc). Close only in Console after evidence is exported (closed = irreversible)', calls: [
      { sdk: `client.api.v2010.accounts('${sub}').update({ status: 'suspended' })`, http: `POST https://api.twilio.com/2010-04-01/Accounts/${sub}.json Status=suspended` },
    ] },
  ];
}

export function formatPlan(steps) {
  const lines = [];
  for (const s of steps) {
    lines.push(`[${s.id}] ${s.title}`);
    for (const c of s.calls) {
      lines.push(`    ${c.http}`);
      lines.push(`      sdk: ${c.sdk}`);
      if (c.params) lines.push(`      params: ${JSON.stringify(redact(c.params))}`);
      if (c.note) lines.push(`      note: ${c.note}`);
    }
  }
  return lines.join('\n');
}

function checkHttpsUrl(name, u, errors, { allowPlaceholder = false } = {}) {
  let url;
  try { url = new URL(u); } catch { if (!allowPlaceholder) errors.push(`${name} is not a valid URL`); return; }
  if (url.protocol !== 'https:') errors.push(`${name} must be https`);
  if (PRODUCTION_HOST_RE.test(url.hostname)) errors.push(`${name} points at a PRODUCTION host (${url.hostname})`);
}

/** Static checks before any network call for `--apply` on the subaccount (setup or teardown). */
export function checkSubaccountApply({ args, env, opts, kind }) {
  const errors = [];
  const expect = String(args.expectAccount || '');
  const prod = String(args.productionAccount || (env.PRODUCTION_TWILIO_ACCOUNT_SID || env.HCG_PRODUCTION_TWILIO_ACCOUNT_SID) || '');
  const sid = String(env.TWILIO_BYOC_ACCOUNT_SID || '');
  if (!ACCOUNT_SID_RE.test(expect)) errors.push('--expect-account <AC… of the hcg-byoc-staging subaccount> is required');
  if (!ACCOUNT_SID_RE.test(prod)) errors.push('the production (parent) Account SID must be known so it can be refused: --production-account or PRODUCTION_TWILIO_ACCOUNT_SID');
  if (expect && prod && expect.toLowerCase() === prod.toLowerCase()) errors.push('REFUSED: --expect-account is the PRODUCTION account');
  if (env.BYOC_PARENT_ACCOUNT_SID && expect.toLowerCase() === String(env.BYOC_PARENT_ACCOUNT_SID).toLowerCase()) errors.push('REFUSED: --expect-account is the parent account');
  if (!sid || !env.TWILIO_BYOC_AUTH_TOKEN) errors.push('TWILIO_BYOC_ACCOUNT_SID and TWILIO_BYOC_AUTH_TOKEN (subaccount credentials) are required');
  else if (sid.toLowerCase() !== expect.toLowerCase()) errors.push('TWILIO_BYOC_ACCOUNT_SID does not match --expect-account');
  if (sid && prod && sid.toLowerCase() === prod.toLowerCase()) errors.push('REFUSED: TWILIO_BYOC_ACCOUNT_SID is the PRODUCTION account');
  const token = confirmationToken(kind, expect);
  if (args.confirm !== token) errors.push(`--confirm ${token} is required (typed by Andrew at the moment of GO)`);
  if (kind === 'APPLY-BYOC') {
    checkHttpsUrl('voice URL', opts.voiceUrl, errors);
    checkHttpsUrl('status callback URL', opts.statusCallbackUrl, errors);
    checkHttpsUrl('trigger callback URL', opts.triggerCallbackUrl, errors);
    if (!TWIML_BIN_RE.test(opts.fallbackUrl)) errors.push('fallback URL must be a TwiML Bin URL https://handler.twilio.com/twiml/EH… (a <Reject/> bin created in the subaccount)');
    if (!EDGES.has(opts.edge)) errors.push(`unknown --edge ${opts.edge}`);
    if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(opts.domainPrefix)) errors.push('invalid --domain-prefix');
  }
  if (kind === 'TEARDOWN-BYOC' && !String(args.magratheaRepointed || '').trim()) {
    errors.push('--magrathea-repointed "<date/ticket ref>" is required: Magrathea must first confirm in writing the DDI no longer targets Twilio');
  }
  return errors;
}

/** Checks on the account Twilio actually returned for the subaccount credentials. */
export function checkAccountIdentity(account, { expectAccount, productionSid }) {
  const errors = [];
  if (!account) return ['could not fetch the account'];
  if (String(account.sid).toLowerCase() !== String(expectAccount).toLowerCase()) errors.push('credentials resolve to a different account than --expect-account');
  if (productionSid && String(account.sid).toLowerCase() === String(productionSid).toLowerCase()) errors.push('REFUSED: credentials resolve to the PRODUCTION account');
  if (!account.ownerAccountSid || account.ownerAccountSid === account.sid) errors.push('REFUSED: this is a MAIN account, not a subaccount');
  if (account.friendlyName !== NAMES.subaccount) errors.push(`REFUSED: subaccount friendlyName is "${account.friendlyName}", expected "${NAMES.subaccount}"`);
  if (account.status !== 'active') errors.push(`subaccount status is ${account.status}, expected active`);
  return errors;
}

/** Static checks for the PARENT-credential steps (create subaccount / suspend). */
export function checkParentStep({ args, env, kind }) {
  const errors = [];
  const expectParent = String(args.expectParent || '');
  const sid = String(env.BYOC_PARENT_ACCOUNT_SID || '');
  if (!ACCOUNT_SID_RE.test(expectParent)) errors.push('--expect-parent <AC… of the parent account> is required');
  if (!sid || !env.BYOC_PARENT_AUTH_TOKEN) errors.push('BYOC_PARENT_ACCOUNT_SID and BYOC_PARENT_AUTH_TOKEN are required for this step (prefer the Console)');
  else if (sid.toLowerCase() !== expectParent.toLowerCase()) errors.push('BYOC_PARENT_ACCOUNT_SID does not match --expect-parent');
  const tokenSid = kind === 'SUSPEND-BYOC' ? String(args.expectAccount || '') : expectParent;
  if (kind === 'SUSPEND-BYOC' && !ACCOUNT_SID_RE.test(tokenSid)) errors.push('--expect-account <AC… subaccount to suspend> is required');
  if (kind === 'SUSPEND-BYOC' && tokenSid && tokenSid.toLowerCase() === expectParent.toLowerCase()) errors.push('REFUSED: cannot suspend the parent account');
  const token = confirmationToken(kind, tokenSid);
  if (args.confirm !== token) errors.push(`--confirm ${token} is required`);
  return errors;
}
