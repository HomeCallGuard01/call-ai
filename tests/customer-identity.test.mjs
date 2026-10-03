// Unit tests for the customer-identity / carrier-abstraction layer that
// don't need a database: account numbers, the routing lifecycle helpers,
// the provider adapter contract, the dry-run migration planner and its
// CLI, the account-number admin lookup, and the "account number is not a
// credential" guarantees. The database half is
// tests/customer-identity.pglite.test.mjs.
//
// Run with: node tests/customer-identity.test.mjs

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Replace the Supabase client module before anything loads it, so no
// environment or network is needed and every query is captured.
const queries = [];
function fakeBuilder(table, result) {
  const calls = { table, filters: [] };
  queries.push(calls);
  const b = {
    select(cols) { calls.select = cols; return b; },
    eq(col, val) { calls.filters.push(['eq', col, val]); return b; },
    or(expr) { calls.filters.push(['or', expr]); return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() { return Promise.resolve(result()); },
    then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
  };
  return b;
}
let nextResult = () => ({ data: null, error: null });
const fakeSupabase = { from: table => fakeBuilder(table, () => nextResult()), rpc: async () => ({ data: null, error: null }) };
const supabaseClientsPath = require.resolve('../services/supabaseClients.js');
require.cache[supabaseClientsPath] = {
  id: supabaseClientsPath, filename: supabaseClientsPath, loaded: true,
  exports: { supabase: fakeSupabase, supabaseAdmin: fakeSupabase, createUserScopedClient: () => fakeSupabase },
};

const { formatAccountNumber, parseAccountNumber, isValidAccountNumber, luhnCheckDigit } = require('../services/customerIdentity/accountNumber.js');
const lifecycle = require('../services/customerIdentity/routingLifecycle.js');
const { planProviderMigration, maskE164 } = require('../services/customerIdentity/providerMigrationPlanner.js');
const { assertNumberProviderAdapter } = require('../services/telephony/numberProviders/contract.js');
const { createTwilioNumberProviderAdapter } = require('../services/telephony/numberProviders/twilio.js');
const { getNumberProviderAdapter, listImplementedProviders, UnsupportedNumberProviderError } = require('../services/telephony/numberProviders/registry.js');
const identityDb = require('../database/customerIdentity.js');
const dryRun = require('../scripts/provider-migration-dry-run.js');

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}
function throws(fn, pattern, message) {
  try { fn(); check(false, `${message} (no error)`); }
  catch (err) { check(!pattern || pattern.test(err.message), `${message}${pattern && !pattern.test(err.message) ? ` (got: ${err.message})` : ''}`); }
}

// ------------------------------------------------------------------
// Account numbers
// ------------------------------------------------------------------
check(formatAccountNumber(1001) === 'HCG-00010017', 'serial 1001 formats as HCG-00010017');
check(formatAccountNumber(12) === 'HCG-00000125', 'serial 12 formats as HCG-00000125 (same shape as the brief\'s HCG-00000127 example)');
check(!isValidAccountNumber('HCG-00000127'), 'the brief\'s illustrative HCG-00000127 is not a valid number (wrong check digit)');
check(formatAccountNumber(123456789) === 'HCG-1234567897', 'serials beyond 7 digits are never truncated');
check(luhnCheckDigit(7992739871) === 3, 'Luhn check digit matches the standard reference value');
throws(() => formatAccountNumber(0), /positive/, 'serial 0 is refused');
throws(() => formatAccountNumber(-5), /positive/, 'negative serials are refused');

for (const input of ['HCG-00010017', 'hcg-00010017', ' HCG 0001 0017 ', 'hcg.0001.0017', '00010017']) {
  const p = parseAccountNumber(input);
  check(p.valid && p.canonical === 'HCG-00010017' && p.serial === 1001, `"${input}" parses to HCG-00010017`);
}
for (const [input, reason] of [['HCG-00010018', 'check_digit_mismatch'], ['HCG-1', 'bad_format'], ['HCG-000010017', 'bad_format'],
  ['07700900123', 'check_digit_mismatch'], ['', 'bad_format'], [null, 'not_a_string'], ['HCG-0001001X', 'bad_format'],
  ['b3c1a7a2-0000-4000-8000-000000000000', 'bad_format'], ['HCG-00000000', 'bad_serial']]) {
  const p = parseAccountNumber(input);
  check(!p.valid && p.reason === reason, `${JSON.stringify(input)} is rejected (${reason}), got ${p.reason}`);
}

// Every single-digit substitution and every adjacent transposition (except
// the 0<->9 pair Luhn is known to miss) is detected.
{
  let subs = 0; let subsCaught = 0; let swaps = 0; let swapsCaught = 0;
  for (const serial of [1001, 1002, 4242, 98765, 1234567]) {
    const digits = formatAccountNumber(serial).slice(4);
    for (let i = 0; i < digits.length; i++) {
      for (let d = 0; d <= 9; d++) {
        if (String(d) === digits[i]) continue;
        subs++;
        if (!isValidAccountNumber(`HCG-${digits.slice(0, i)}${d}${digits.slice(i + 1)}`)) subsCaught++;
      }
      if (i < digits.length - 1 && digits[i] !== digits[i + 1] && !['09', '90'].includes(digits[i] + digits[i + 1])) {
        swaps++;
        if (!isValidAccountNumber(`HCG-${digits.slice(0, i)}${digits[i + 1]}${digits[i]}${digits.slice(i + 2)}`)) swapsCaught++;
      }
    }
  }
  check(subs > 0 && subsCaught === subs, `all ${subs} single-digit typos are detected`);
  check(swaps > 0 && swapsCaught === swaps, `all ${swaps} adjacent transpositions (excluding 0/9) are detected`);
}

check(!/^\+?\d{10,15}$/.test(formatAccountNumber(1001)) && !/^[0-9a-f-]{36}$/.test(formatAccountNumber(1001)),
  'an account number is neither a phone number nor a UUID');

// ------------------------------------------------------------------
// Routing lifecycle helpers
// ------------------------------------------------------------------
const A = (o) => ({ protection_service: 'primary', is_primary: false, created_at: '2026-01-01T00:00:00Z', ...o });
const rows = [
  A({ id: 'r1', household_id: 'h1', e164_number: '+441', state: 'released', created_at: '2026-01-01T00:00:00Z' }),
  A({ id: 'r2', household_id: 'h1', e164_number: '+442', state: 'active', is_primary: true, created_at: '2026-02-01T00:00:00Z' }),
  A({ id: 'r3', household_id: 'h1', e164_number: '+443', state: 'active', created_at: '2026-03-01T00:00:00Z' }),
  A({ id: 'r4', household_id: 'h2', e164_number: '+441', state: 'quarantined' }),
];
check(lifecycle.selectPrimaryAssignment(rows.filter(r => r.household_id === 'h1')).id === 'r2', 'the active primary wins over a newer non-primary active');
check(lifecycle.selectPrimaryAssignment([rows[2]]).id === 'r3', 'with no primary flag, the newest active assignment is used');
check(lifecycle.selectPrimaryAssignment([rows[0], rows[3]]) === null, 'no active assignment means no routing');
check(lifecycle.resolveInboundHouseholdId(rows, '+442') === 'h1', 'an active number routes to its household');
check(lifecycle.resolveInboundHouseholdId(rows, '+441') === null, 'a released/quarantined number routes to nobody');
check(lifecycle.HELD_STATES.includes('quarantined') && !lifecycle.HELD_STATES.includes('released'), 'quarantined numbers are held; released are not');
check(!lifecycle.canTransition('active', 'released') && lifecycle.canTransition('active', 'released', { viaPortCompletion: true }),
  'active -> released only via port completion');
check(lifecycle.STATES.every(s => s in lifecycle.TRANSITIONS), 'every state has a transition entry');

// ------------------------------------------------------------------
// Provider adapter contract
// ------------------------------------------------------------------
const twilioCalls = [];
const fakeTwilio = {
  availablePhoneNumbers: country => ({ local: { list: async opts => { twilioCalls.push(['search', country, opts]); return [{ phoneNumber: '+441111111111' }]; } } }),
  incomingPhoneNumbers: Object.assign(
    sid => ({
      fetch: async () => { if (sid === 'PN_GONE') { const e = new Error('not found'); e.status = 404; throw e; } return { sid, phoneNumber: '+441111111111', voiceUrl: 'https://x/voice', voiceMethod: 'POST' }; },
      update: async p => { twilioCalls.push(['update', sid, p]); return { sid, phoneNumber: '+441111111111', voiceUrl: p.voiceUrl, voiceMethod: p.voiceMethod }; },
      remove: async () => { twilioCalls.push(['remove', sid]); return true; },
    }),
    {
      create: async p => { twilioCalls.push(['create', p]); return { sid: 'PN_NEW', phoneNumber: p.phoneNumber }; },
      list: async p => (p.phoneNumber === '+441111111111' ? [{ sid: 'PN_NEW' }] : []),
    }
  ),
};
const twilio = createTwilioNumberProviderAdapter(fakeTwilio);
check(twilio.code === 'twilio', 'Twilio adapter declares code "twilio" (matches telephony_providers)');
check(twilio.capabilities.portIn === null && twilio.capabilities.portOut === null, 'porting capability is unknown (null), not assumed');

const provisioned = await twilio.provisionNumber({ inboundCallUrl: 'https://app/voice', addressId: 'AD1', bundleId: 'BU1' });
const createCall = twilioCalls.find(c => c[0] === 'create')[1];
check(provisioned.resourceId === 'PN_NEW' && provisioned.e164 === '+441111111111', 'provisionNumber returns provider-neutral { resourceId, e164 }');
check(createCall.voiceUrl === 'https://app/voice' && createCall.addressSid === 'AD1' && createCall.bundleSid === 'BU1', 'Twilio-specific params stay inside the adapter');
const bare = await (async () => { twilioCalls.length = 0; await twilio.provisionNumber({ inboundCallUrl: 'https://app/voice' }); return twilioCalls.find(c => c[0] === 'create')[1]; })();
check(!('addressSid' in bare) && !('bundleSid' in bare), 'unset regulatory ids are omitted, never sent as null');
check((await twilio.configureInboundRoute('PN_NEW', { inboundCallUrl: 'https://new/voice' })).inboundCallUrl === 'https://new/voice', 'configureInboundRoute returns the neutral configuration');
check((await twilio.getNumberConfiguration('PN_NEW')).resourceId === 'PN_NEW', 'getNumberConfiguration returns the neutral configuration');
check((await twilio.findResourceId('+441111111111')) === 'PN_NEW' && (await twilio.findResourceId('+449')) === null, 'findResourceId maps a number to the provider handle or null');
check((await twilio.fetchNumberStatus('PN_GONE')).exists === false, 'fetchNumberStatus reports a missing resource as exists:false');
check((await twilio.releaseNumber('PN_NEW')).released === true, 'releaseNumber returns { released: true }');
let rejected = false;
try { await twilio.provisionNumber({}); } catch { rejected = true; }
check(rejected, 'provisionNumber refuses to buy a number without an inbound route');

throws(() => assertNumberProviderAdapter({ code: 'x1', capabilities: {} }), /missing/, 'an adapter missing methods is rejected');
throws(() => assertNumberProviderAdapter({ ...twilio, capabilities: { ...twilio.capabilities, portIn: 'maybe' } }), /capability portIn/, 'capabilities must be true/false/null');
check(JSON.stringify(listImplementedProviders()) === '["twilio"]', 'only Twilio has an implemented adapter today');
for (const code of ['telnyx', 'aql', 'magrathea', '__proto__', 'constructor']) {
  throws(() => getNumberProviderAdapter(code, {}), /No number-provider adapter/, `"${code}" fails loudly instead of falling back to Twilio`);
}
check((() => { try { getNumberProviderAdapter('aql'); } catch (e) { return e instanceof UnsupportedNumberProviderError; } return false; })(), 'unsupported provider raises UnsupportedNumberProviderError');
check(getNumberProviderAdapter('twilio', { twilioClient: fakeTwilio }).code === 'twilio', 'registry builds the Twilio adapter from an injected client');

// ------------------------------------------------------------------
// Dry-run provider migration planner
// ------------------------------------------------------------------
const H = (id, extra = {}) => ({ id, account_number: `HCG-${id}`, status: 'active', device_type: 'mobile', ...extra });
const R = (o) => ({ protection_service: 'primary', is_primary: false, provider_code: 'twilio', acquisition: 'legacy_backfill', created_at: '2026-01-01T00:00:00Z', ...o });
const snapshot = {
  households: [
    H('a'), H('b'), H('c', { device_type: 'landline' }), H('d'), H('e', { activation_verified_at: '2026-05-02T00:00:00Z' }),
    H('f'), H('g'), H('h', { status: 'cancelled' }), H('i'), H('j', { device_type: null }),
  ],
  assignments: [
    R({ id: 'a1', household_id: 'a', e164_number: '+447000000001', state: 'active', is_primary: true }),
    R({ id: 'b1', household_id: 'b', e164_number: '+447000000002', state: 'active', is_primary: true }),
    R({ id: 'c1', household_id: 'c', e164_number: '+447000000003', state: 'active', is_primary: true }),
    // d: port in flight
    R({ id: 'd1', household_id: 'd', e164_number: '+447000000004', state: 'active', is_primary: true }),
    R({ id: 'd2', household_id: 'd', e164_number: '+447000000004', state: 'port_pending', provider_code: 'telnyx', acquisition: 'ported_in', replaces_assignment_id: 'd1', created_at: '2026-05-01T00:00:00Z' }),
    // e: replacement in overlap, new number primary, customer verified after
    R({ id: 'e1', household_id: 'e', e164_number: '+447000000005', state: 'active' }),
    R({ id: 'e2', household_id: 'e', e164_number: '+447000000055', state: 'active', is_primary: true, provider_code: 'telnyx', acquisition: 'purchased', replaces_assignment_id: 'e1', state_changed_at: '2026-05-01T00:00:00Z' }),
    // f: completed port on telnyx
    R({ id: 'f1', household_id: 'f', e164_number: '+447000000006', state: 'released' }),
    R({ id: 'f2', household_id: 'f', e164_number: '+447000000006', state: 'active', is_primary: true, provider_code: 'telnyx', acquisition: 'ported_in', replaces_assignment_id: 'f1' }),
    // g: already on target natively
    R({ id: 'g1', household_id: 'g', e164_number: '+447000000007', state: 'active', is_primary: true, provider_code: 'telnyx', acquisition: 'purchased' }),
    // h: cancelled customer, number quarantined
    R({ id: 'h1', household_id: 'h', e164_number: '+447000000008', state: 'quarantined' }),
    // i: replacement pending
    R({ id: 'i1', household_id: 'i', e164_number: '+447000000009', state: 'active', is_primary: true }),
    R({ id: 'i2', household_id: 'i', e164_number: '+447000000099', state: 'replacement_pending', provider_code: 'telnyx', acquisition: 'purchased', replaces_assignment_id: 'i1' }),
    R({ id: 'j1', household_id: 'j', e164_number: '+447000000010', state: 'active', is_primary: true }),
  ],
};
const report = planProviderMigration(snapshot, {
  targetProvider: 'telnyx',
  targetCapabilities: { portIn: true },
  portability: { '+447000000001': 'portable', '+447000000002': 'not_portable' },
});
const row = id => report.rows.find(r => r.householdId === id);
check(report.dryRun === true, 'planner output is explicitly marked dry-run');
check(row('a').plan === 'port_number' && row('a').forwardingAction === 'none_number_unchanged', 'portable number -> port, customer forwarding untouched');
check(row('b').plan === 'replace_number' && row('b').notes.includes('number_not_portable')
  && row('b').forwardingAction === 'customer_reenters_mobile_forwarding_codes_for_new_number', 'non-portable mobile number -> replacement + re-enter forwarding codes');
check(row('c').plan === 'replace_number' && row('c').notes.includes('number_portability_unknown')
  && row('c').forwardingAction === 'landline_forwarding_must_be_changed_to_new_number', 'unknown portability falls back to replacement (landline wording)');
check(row('d').portState === 'port_pending' && row('d').verificationStatus === 'awaiting_port_completion'
  && row('d').rollbackState === 'available_cancel_port_source_still_active', 'in-flight port reported with rollback available');
check(row('e').replacementState === 'active' && row('e').verificationStatus === 'verified_on_new_number'
  && row('e').notes.includes('next_release_previous_number_via_quarantine'), 'verified overlap -> next step is releasing the previous number via quarantine');
check(row('f').plan === 'port_completed' && row('f').rollbackState === 'window_closed_previous_number_released', 'completed port reported, rollback window closed');
check(row('g').plan === 'already_on_target', 'customer already on target needs nothing');
check(row('h').plan === 'no_active_routing' && row('h').notes.includes('customer_status_cancelled'), 'cancelled customer with only a quarantined number is not migrated');
check(row('i').replacementState === 'replacement_pending' && row('i').verificationStatus === 'awaiting_forwarding_verification', 'pending replacement awaits forwarding verification');
check(row('j').forwardingAction === 'customer_forwarding_must_be_updated_device_type_unknown', 'unknown device type gets generic forwarding wording');
check(report.rows.every(r => r.accountNumber && r.accountNumber.startsWith('HCG-')), 'every row carries the HCG account number');
check(report.rows.every(r => !r.currentNumber || r.currentNumber.includes('*')), 'numbers are masked by default');
check(report.summary.customers === 10 && report.summary.numbersHeldByMultipleHouseholds === 0, 'summary counts customers and finds no number conflicts');
check(report.rows.every(r => !('provider_resource_id' in r) && !JSON.stringify(r).includes('PN_')), 'no provider resource ids leak into the report');

const noPortCap = planProviderMigration(snapshot, { targetProvider: 'telnyx', portability: { '+447000000001': 'portable' } });
check(noPortCap.rows.find(r => r.householdId === 'a').plan === 'replace_number'
  && noPortCap.rows.find(r => r.householdId === 'a').notes.includes('target_port_in_capability_unverified'),
'an unverified target port-in capability never plans a port');
const replaceOnly = planProviderMigration(snapshot, { targetProvider: 'telnyx', strategy: 'replace_only', targetCapabilities: { portIn: true }, portability: { '+447000000001': 'portable' } });
check(replaceOnly.rows.find(r => r.householdId === 'a').plan === 'replace_number', 'replace_only strategy never ports');
const conflict = planProviderMigration({ households: [H('x'), H('y')], assignments: [
  R({ id: 'x1', household_id: 'x', e164_number: '+447000000020', state: 'active', is_primary: true }),
  R({ id: 'y1', household_id: 'y', e164_number: '+447000000020', state: 'quarantined' }),
] }, { targetProvider: 'telnyx' });
check(conflict.summary.numbersHeldByMultipleHouseholds === 1, 'a number held by two households is surfaced as a conflict');
check(maskE164('+447700900123') === '+44*******123', 'maskE164 keeps only country prefix and last three digits');
throws(() => planProviderMigration(snapshot, {}), /targetProvider/, 'planner requires a target provider');
throws(() => planProviderMigration(snapshot, { targetProvider: 'telnyx', strategy: 'yolo' }), /strategy/, 'planner rejects unknown strategies');

// ------------------------------------------------------------------
// Dry-run CLI
// ------------------------------------------------------------------
const tmp = mkdtempSync(path.join(tmpdir(), 'hcg-dry-run-'));
const snapPath = path.join(tmp, 'snapshot.json');
writeFileSync(snapPath, JSON.stringify(snapshot));
for (const flag of ['--execute', '--apply', '--commit', '--live', '--write=1']) {
  throws(() => dryRun.parseArgs([`--snapshot=${snapPath}`, '--target=telnyx', flag]), /dry-run only/, `CLI refuses ${flag}`);
}
let out = '';
const cliReport = dryRun.run([`--snapshot=${snapPath}`, '--target=telnyx', '--target-port-in=true'], { stdout: { write: s => { out += s; } } });
check(out.startsWith('DRY RUN') && out.includes('Nothing was changed') && cliReport.rows.length === 10, 'CLI prints a dry-run table for every customer');
check(!out.includes('+447000000001'), 'CLI masks numbers unless --show-numbers is passed');
const cliSource = readFileSync(path.join(root, 'scripts/provider-migration-dry-run.js'), 'utf8');
const plannerSource = readFileSync(path.join(root, 'services/customerIdentity/providerMigrationPlanner.js'), 'utf8');
check(!/require\([^)]*(supabase|twilio|stripe|database\/)/i.test(cliSource + plannerSource), 'dry-run CLI and planner load no database, Twilio or Stripe client');

// ------------------------------------------------------------------
// Admin lookup by account number
// ------------------------------------------------------------------
queries.length = 0;
check((await identityDb.getHouseholdByAccountNumber('HCG-00010018')) === null && queries.length === 0, 'an invalid account number is rejected without querying');
nextResult = () => ({ data: { id: 'h-1', account_number: 'HCG-00010017' }, error: null });
const hh = await identityDb.getHouseholdByAccountNumber('hcg 0001 0017');
check(hh && hh.id === 'h-1' && queries[0].table === 'households'
  && JSON.stringify(queries[0].filters) === JSON.stringify([['eq', 'account_number', 'HCG-00010017']]), 'lookup canonicalises the typed number and does an exact match');

const { searchCustomers } = require('../database/adminMetrics.js');
queries.length = 0;
nextResult = () => ({ data: [], error: null });
await searchCustomers('HCG-0001-0017');
check(JSON.stringify(queries[0].filters) === JSON.stringify([['eq', 'account_number', 'HCG-00010017']]), 'admin customer search finds by account number (exact match)');
queries.length = 0;
await searchCustomers('00010017');
check(queries[0].filters[0][0] === 'or', 'bare digits (a partial phone search) keep the substring path even if Luhn-valid');
queries.length = 0;
await searchCustomers('alice@example.com');
check(queries[0].filters[0][0] === 'or' && !queries[0].filters[0][1].includes('account_number'), 'ordinary email searches do not touch account_number');

// ------------------------------------------------------------------
// Not a credential; consumers
// ------------------------------------------------------------------
const serverSrc = readFileSync(path.join(root, 'server.js'), 'utf8');
const mobileSrc = readFileSync(path.join(root, 'routes/mobileApi.js'), 'utf8');
const billingSrc = readFileSync(path.join(root, 'routes/billing.js'), 'utf8');
const middlewareSrc = ['requireAuth.js', 'requireAuthApi.js', 'requireEntitlement.js', 'requireAdmin.js']
  .map(f => readFileSync(path.join(root, 'middleware', f), 'utf8')).join('\n');
check(!/account_?number/i.test(middlewareSrc), 'no auth/entitlement middleware reads an account number');
check(!/getHouseholdByAccountNumber|eq\(\s*["']account_number/.test(serverSrc + mobileSrc + billingSrc),
  'no customer-facing route resolves a household from an account number');
check(/accountNumber: req\.household\.account_number \|\| null/.test(serverSrc), 'web dashboard data returns the signed-in household\'s own account number');
check(/accountNumber: req\.household\.account_number \|\| null/.test(mobileSrc), 'mobile dashboard returns the signed-in household\'s own account number');
const uploadSrc = readFileSync(path.join(root, 'upload.html'), 'utf8');
check(/account\.accountNumber\s*\?/.test(uploadSrc) && /escapeHtml\(account\.accountNumber\)/.test(uploadSrc), 'dashboard shows the account number only when present, escaped');
const adminSrc = readFileSync(path.join(root, 'admin-business.html'), 'utf8');
check(/escapeHtml\(h\.account_number\)/.test(adminSrc), 'admin search results show the account number, escaped');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
