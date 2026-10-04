// Support search (customer lifecycle automation, 2026-10-04):
// services/lifecycle/supportSearch.js and its use in
// database/adminMetrics.js searchCustomers. Proves support can find a
// customer by HCG account number, email, protected phone and HCG routing
// number (including a routing number the household no longer holds), typed
// the way a customer reads it, and that query text can no longer inject
// clauses into the PostgREST .or() filter.
//
// Run with: node tests/lifecycle-support-search.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`✓ ${message}`);
  else { console.error(`✗ ${message}`); failures++; }
}

const queries = [];
const results = { households: () => ({ data: [], error: null }), routing_assignments: () => ({ data: [], error: null }), entitlements: () => ({ data: null, error: null }) };
function fakeBuilder(table) {
  const calls = { table, filters: [] };
  queries.push(calls);
  const result = () => (results[table] || (() => ({ data: null, error: null })))();
  const b = {
    select(cols) { calls.select = cols; return b; },
    eq(col, val) { calls.filters.push(['eq', col, val]); return b; },
    or(expr) { calls.filters.push(['or', expr]); return b; },
    lte() { return b; }, gt() { return b; }, is() { return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() { return Promise.resolve(result()); },
    then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
  };
  return b;
}
const fakeSupabase = { from: (t) => fakeBuilder(t), rpc: async () => ({ data: null, error: null }) };
const supabaseClientsPath = require.resolve('../services/supabaseClients.js');
require.cache[supabaseClientsPath] = {
  id: supabaseClientsPath, filename: supabaseClientsPath, loaded: true,
  exports: { supabase: fakeSupabase, supabaseAdmin: fakeSupabase, createUserScopedClient: () => fakeSupabase },
};

const { classifySupportQuery, filterSafe, phoneToE164 } = require('../services/lifecycle/supportSearch');
const { searchCustomers } = require('../database/adminMetrics.js');

// --- classifier ---
check(classifySupportQuery('').kind === 'empty', 'empty query');
check(classifySupportQuery('11111111-2222-4333-8444-555555555555').kind === 'uuid', 'household UUID');
const acct = classifySupportQuery('hcg 0001 0017');
check(acct.kind === 'account_number' && acct.value === 'HCG-00010017', 'HCG account number in any spacing/case → canonical');
check(classifySupportQuery('HCG-00010018').kind !== 'account_number', 'a bad check digit is not treated as an account number');
for (const typed of ['07700 900123', '07700900123', '+44 7700 900123', '447700900123', '0044 7700 900 123', '(07700) 900-123']) {
  const q = classifySupportQuery(typed);
  check(q.kind === 'phone' && q.e164 === '+447700900123', `"${typed}" → phone +447700900123`);
}
check(classifySupportQuery('01632 960001').e164 === '+441632960001', 'UK geographic (HCG routing) number → E.164');
check(classifySupportQuery('00010017').kind === 'text', 'bare partial digits keep the substring path');
check(phoneToE164('+1 415 555 0100') === '+14155550100', 'non-UK international keeps its digits');
check(classifySupportQuery('alice@example.com').kind === 'email', 'email');
const name = classifySupportQuery('Margaret Smith');
check(name.kind === 'text' && /no stored name/.test(name.note || ''), 'a name search says households have no stored name (not silently mis-searched)');
check(filterSafe('a,b(c)"d\'e\\f%g*h:i') === 'abcdefghi', 'filterSafe strips every PostgREST logic-tree / wildcard character');

// --- searchCustomers wiring ---
queries.length = 0;
await searchCustomers('07700 900123');
const hq = queries.find((q) => q.table === 'households');
const rq = queries.find((q) => q.table === 'routing_assignments');
check(rq && JSON.stringify(rq.filters) === JSON.stringify([['eq', 'e164_number', '+447700900123']]), 'phone search also looks up routing_assignments (any household that ever held the number)');
check(hq && hq.filters[0][0] === 'or' && hq.filters[0][1] === 'phone_number.eq.+447700900123,twilio_number.eq.+447700900123',
  'phone search matches protected phone OR routing number exactly in E.164');

queries.length = 0;
results.routing_assignments = () => ({ data: [{ household_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, { household_id: null }, { household_id: 'not-a-uuid,id.neq.x' }], error: null });
await searchCustomers('01632960001');
const hq2 = queries.find((q) => q.table === 'households');
check(hq2.filters[0][1] === 'phone_number.eq.+441632960001,twilio_number.eq.+441632960001,id.eq.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  'a former holder of the routing number is included; only valid UUIDs reach the filter');

queries.length = 0;
results.routing_assignments = () => ({ data: null, error: { code: 'PGRST205', message: 'Could not find the table' } });
await searchCustomers('01632960001');
check(queries.find((q) => q.table === 'households').filters[0][1] === 'phone_number.eq.+441632960001,twilio_number.eq.+441632960001',
  'routing_assignments not deployed ⇒ the households search still runs');

queries.length = 0;
await searchCustomers('x%,id.neq.00000000-0000-0000-0000-000000000000');
const inj = queries.find((q) => q.table === 'households');
check(inj.filters[0][0] === 'or' && inj.filters[0][1].split(',').length === 3 && !/id\.neq/.test(inj.filters[0][1].replace(/ilike\.%[^%]*%/g, '')),
  'an injection attempt cannot add a clause to the .or() filter (still exactly three ilike clauses)');

queries.length = 0;
await searchCustomers(',,,()');
check(queries.length === 0, 'a query that is nothing but filter syntax runs no query at all');

queries.length = 0;
await searchCustomers('HCG-0001-0017');
check(JSON.stringify(queries[0].filters) === JSON.stringify([['eq', 'account_number', 'HCG-00010017']]), 'account-number search unchanged (exact match)');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll support search checks passed');
