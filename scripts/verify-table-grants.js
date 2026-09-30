// Verifies, against a real (not PGlite) Supabase database, that public-schema
// tables follow this project's least-privilege Data API policy (migrations
// 057/058/059):
//   - every public table has RLS enabled;
//   - anon and PUBLIC hold no privilege on any public table, view or sequence;
//   - authenticated holds exactly the allowlisted table and column grants
//     that ensureHouseholdAndRole() and migrations 008/011 need;
//   - the postgres-owned default ACL for public tables/sequences grants
//     nothing to anon/authenticated, so a future table starts closed.
//
// Real-database counterpart to the 058/059 section of
// tests/migrations.pglite.test.mjs, and sibling of
// scripts/verify-security-definer-grants.js (functions). PGlite replays the
// migrations under a modelled default ACL; only this script sees the live
// project's actual default ACL and any dashboard-made grant drift.
//
// Runs against whichever project the Supabase CLI is linked to (it prints the
// ref first). Read-only: every query runs inside `begin transaction read
// only ... rollback`, so it is safe against production.
//
// Run with: node scripts/verify-table-grants.js

const { execFileSync } = require("node:child_process");

const AUTHENTICATED_TABLE_GRANTS = [
  "contacts:DELETE", "contacts:INSERT", "contacts:SELECT", "contacts:UPDATE",
  "entitlements:SELECT", "households:SELECT", "subscriptions:SELECT", "user_roles:SELECT",
];
const AUTHENTICATED_COLUMN_GRANTS = [
  "households.auth_user_id:INSERT", "households.auth_user_id:UPDATE",
  "households.email:INSERT", "households.email:UPDATE", "households.status:INSERT",
  "user_roles.auth_user_id:INSERT", "user_roles.role:INSERT",
];

function query(sql) {
  const raw = execFileSync(
    "supabase",
    ["db", "query", "--linked", "--output-format", "json", `begin transaction read only; ${sql}; rollback;`],
    { encoding: "utf8" }
  );
  return JSON.parse(raw.slice(raw.indexOf("{"))).rows;
}

function linkedProjectRef() {
  try {
    return require("node:fs").readFileSync("supabase/.temp/project-ref", "utf8").trim();
  } catch {
    return "<unknown — is the repo linked? run `supabase link --project-ref ...`>";
  }
}

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`✗ ${message}`);
  } else {
    console.log(`✓ ${message}`);
  }
}

const RELKINDS = `c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')`;

function main() {
  const ref = linkedProjectRef();
  console.log(`Verifying public-schema table grant policy against linked project: ${ref}\n`);

  const tables = query(`
    select c.relname, c.relrowsecurity as rls
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
    order by 1
  `);
  assert(tables.length > 0, "at least one public table exists to check (sanity check on the check itself)");
  const noRls = tables.filter((t) => !t.rls).map((t) => t.relname);
  assert(noRls.length === 0, `every public table has RLS enabled (missing: ${noRls.join(", ") || "none"})`);

  const anonGrants = query(`
    select c.relname || ':' || a.privilege_type as g
    from pg_class c, aclexplode(c.relacl) a
    where c.relnamespace = 'public'::regnamespace and ${RELKINDS}
      and (a.grantee = 0 or a.grantee = 'anon'::regrole)
    order by 1
  `).map((r) => r.g);
  assert(anonGrants.length === 0, `anon/PUBLIC hold no privilege on any public relation (found: ${anonGrants.join(", ") || "none"})`);

  const authGrants = query(`
    select c.relname || ':' || a.privilege_type as g
    from pg_class c, aclexplode(c.relacl) a
    where c.relnamespace = 'public'::regnamespace and ${RELKINDS}
      and a.grantee = 'authenticated'::regrole
    order by 1
  `).map((r) => r.g).sort();
  assert(
    JSON.stringify(authGrants) === JSON.stringify(AUTHENTICATED_TABLE_GRANTS),
    `authenticated table-level grants are exactly the allowlist (found: ${authGrants.join(", ") || "none"})`
  );

  const authColumnGrants = query(`
    select c.relname || '.' || att.attname || ':' || a.privilege_type as g
    from pg_attribute att
    join pg_class c on c.oid = att.attrelid, aclexplode(att.attacl) a
    where c.relnamespace = 'public'::regnamespace
      and (a.grantee = 0 or a.grantee in ('anon'::regrole, 'authenticated'::regrole))
    order by 1
  `).map((r) => r.g).sort();
  assert(
    JSON.stringify(authColumnGrants) === JSON.stringify(AUTHENTICATED_COLUMN_GRANTS),
    `anon/authenticated column-level grants are exactly the allowlist (found: ${authColumnGrants.join(", ") || "none"})`
  );

  console.log("\nChecking pg_default_acl for the public schema (tables, sequences)...\n");
  const defaults = query(`
    select pg_get_userbyid(d.defaclrole) as owner, d.defaclobjtype as objtype, d.defaclacl::text as acl
    from pg_default_acl d
    where d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype in ('r', 'S')
    order by 1, 2
  `);
  for (const row of defaults) {
    const label = `default privileges (role ${row.owner}, ${row.objtype === "r" ? "tables" : "sequences"})`;
    if (row.owner !== "postgres") {
      // Only `for role postgres` is alterable from a migration and is the role
      // every migration runs as; supabase_admin's defaults cover
      // platform-created objects. Reported, not failed (same stance as
      // verify-security-definer-grants.js).
      if (/(^|[{,])(anon|authenticated)=/.test(row.acl)) console.log(`ℹ ${label}, outside migration scope: ${row.acl}`);
      continue;
    }
    assert(!/(^|[{,])(anon|authenticated)=/.test(row.acl), `${label}: nothing granted to anon/authenticated, found: ${row.acl}`);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
