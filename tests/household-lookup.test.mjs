// Inbound routing lookup (database/households.js getHouseholdByTwilioNumber)
// — integration 2026-10-03, launch-gate PR-09 / G1 / E1.
//
// Proves, against a fake PostgREST that honours .in/.not/.order/.range/.limit
// AND enforces a 1000-row response cap (the Supabase default the old
// unfiltered select("*") silently hit):
//   - the household is found by an indexed .in() filter, not a table scan;
//   - a household beyond row 1000 is still found (the old code missed it);
//   - a legacy non-E.164 stored number is still found (safety-net scan, logged);
//   - two households holding one number → null (never guess);
//   - an unassigned number → null, and repeated misses don't re-scan (negative cache);
//   - a foreign number sharing the last 10 digits never matches a UK HCG number.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { getHouseholdByTwilioNumber, twilioNumberLookupVariants } = require('../database/households.js');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };
const ROW_CAP = 1000;

function fakeAdmin(rows) {
  const stats = { queries: 0, fullScans: 0, inQueries: 0 };
  return {
    stats,
    from(table) {
      if (table !== 'households') throw new Error('unexpected table');
      let filtered = rows.slice();
      let range = null; let limit = null; let isScan = true;
      const q = {
        select() { return q; },
        in(col, vals) { isScan = false; stats.inQueries++; filtered = filtered.filter((r) => vals.includes(r[col])); return q; },
        not(col, op, val) { if (op === 'is' && val === null) filtered = filtered.filter((r) => r[col] !== null && r[col] !== undefined); return q; },
        order(col) { filtered.sort((a, b) => String(a[col]).localeCompare(String(b[col]))); return q; },
        range(from, to) { range = [from, to]; return q; },
        limit(n) { limit = n; return q; },
        then(resolve) {
          stats.queries++;
          if (isScan) stats.fullScans++;
          let out = filtered;
          if (range) out = out.slice(range[0], range[1] + 1);
          if (limit) out = out.slice(0, limit);
          out = out.slice(0, ROW_CAP); // Data API row cap
          resolve({ data: out, error: null });
        },
      };
      return q;
    },
  };
}

const pad = (i) => String(i).padStart(4, '0');
const many = Array.from({ length: 2500 }, (_, i) => ({ id: `hh-${pad(i)}`, twilio_number: `+44161555${pad(i)}` }));

{
  const admin = fakeAdmin(many);
  const target = many[2400];
  const hh = await getHouseholdByTwilioNumber('+441615552400', { admin });
  check(hh && hh.id === target.id, 'household beyond row 1000 (row 2401 of 2500) is found — the unfiltered scan capped at 1000 would have missed it');
  check(admin.stats.inQueries === 1 && admin.stats.fullScans === 0, 'found by one indexed .in() lookup, no table scan');
}
{
  const vars = twilioNumberLookupVariants('+441615552400');
  check(['+441615552400', '01615552400', '441615552400', '1615552400'].every((v) => vars.includes(v)), 'lookup variants cover E.164, 0-national, 44-prefixed and bare 10-digit storage forms');
}
{
  const rows = [...many.slice(0, 1500), { id: 'legacy', twilio_number: '0161 555 9999' }];
  const admin = fakeAdmin(rows);
  const hh = await getHouseholdByTwilioNumber('+441615559999', { admin });
  check(hh && hh.id === 'legacy', 'a legacy non-standard stored number (spaces) is still found by the paginated safety-net scan');
}
{
  const rows = [{ id: 'a', twilio_number: '+441615550001' }, { id: 'b', twilio_number: '01615550001' }];
  const admin = fakeAdmin(rows);
  check(await getHouseholdByTwilioNumber('+441615550001', { admin }) === null, 'two households holding the same number → null (never guess a household)');
}
{
  const admin = fakeAdmin(many.slice(0, 50));
  let t = 1_000_000;
  const now = () => t;
  check(await getHouseholdByTwilioNumber('+441619999999', { admin, now }) === null, 'unassigned number → null');
  const scansAfterFirst = admin.stats.fullScans;
  await getHouseholdByTwilioNumber('+441619999999', { admin, now });
  check(admin.stats.fullScans === scansAfterFirst, 'a repeated miss inside the negative-cache window does not re-scan');
  t += 61 * 1000;
  await getHouseholdByTwilioNumber('+441619999999', { admin, now });
  check(admin.stats.fullScans > scansAfterFirst, 'after the window, a miss is re-checked (a newly assigned number is found)');
}
{
  const admin = fakeAdmin([{ id: 'uk', twilio_number: '+441615550201' }]);
  check(await getHouseholdByTwilioNumber('+11615550201', { admin }) === null, 'a +1 number sharing the last 10 digits never resolves to the UK HCG number');
}

console.log(failures === 0 ? '\nAll household lookup checks passed.' : `\n${failures} household lookup check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
