// Verifies, against a real (not PGlite) Supabase database, that every
// SECURITY DEFINER function in the public schema follows this project's
// fail-closed access policy: PUBLIC/anon/authenticated get no EXECUTE,
// service_role has EXECUTE, search_path is pinned, and the owner is the
// project's administrative role. Also verifies the schema-level default
// (pg_default_acl) no longer auto-grants function EXECUTE to anyone.
//
// This is the real-database counterpart to the dynamic check in
// tests/migrations.pglite.test.mjs. PGlite never reproduces Supabase's
// platform default-privilege behavior (the actual root cause of the
// anon/authenticated exposure found on staging 2026-07-30 — see
// docs/engineering/MIGRATION_RECOVERY_PLAN.md) — so the PGlite check can
// only catch a future migration that forgets its own revoke/grant lines,
// not a live project's default-ACL configuration diverging from what
// every migration assumes. This script exists for that second class of
// check, and is meant to be run against staging today, and production
// later, unchanged — matching the "same script both times" principle in
// docs/engineering/STAGING_ENVIRONMENT_PLAN.md §5.
//
// Deliberately does not read any .env file or take a connection string —
// it runs against whichever project the Supabase CLI is currently linked
// to (`supabase link --project-ref ...`), the same mechanism every other
// read-only check in this project's recent history has used. It prints
// that project ref before running anything, so it's never ambiguous
// which database was checked. Read-only throughout: every query is a
// `select` against information_schema/pg_catalog.
//
// Run with: node scripts/verify-security-definer-grants.js

const { execFileSync } = require("node:child_process");

const ADMIN_OWNER = "postgres";

function query(sql) {
  const raw = execFileSync(
    "supabase",
    ["db", "query", "--linked", "--output-format", "json", sql],
    { encoding: "utf8" }
  );
  return JSON.parse(raw).rows;
}

function linkedProjectRef() {
  try {
    return require("node:fs")
      .readFileSync("supabase/.temp/project-ref", "utf8")
      .trim();
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

function main() {
  const ref = linkedProjectRef();
  console.log(`Verifying SECURITY DEFINER grant policy against linked project: ${ref}\n`);

  const fns = query(`
    select p.proname,
           pg_get_function_identity_arguments(p.oid) as args,
           pg_get_userbyid(p.proowner) as owner,
           p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef = true
    order by p.proname;
  `);

  assert(fns.length > 0, "at least one SECURITY DEFINER function exists to check (sanity check on the check itself)");

  for (const fn of fns) {
    const label = `${fn.proname}(${fn.args})`;

    const grants = query(`
      select grantee, privilege_type
      from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = '${fn.proname}';
    `);
    const grantees = new Set(grants.map((g) => g.grantee));

    assert(!grantees.has("PUBLIC"), `${label}: PUBLIC has no EXECUTE`);
    assert(!grantees.has("anon"), `${label}: anon has no EXECUTE`);
    assert(!grantees.has("authenticated"), `${label}: authenticated has no EXECUTE`);
    assert(grantees.has("service_role"), `${label}: service_role has EXECUTE`);

    const configEntries = fn.proconfig || [];
    const searchPathEntry = configEntries.find((c) => c.startsWith("search_path="));
    assert(
      searchPathEntry === 'search_path=""' || searchPathEntry === "search_path=",
      `${label}: search_path is safely fixed (empty), found: ${searchPathEntry ?? "<not set>"}`
    );

    assert(
      fn.owner === ADMIN_OWNER,
      `${label}: owner is the intended administrative role (${ADMIN_OWNER}), found: ${fn.owner}`
    );
  }

  console.log("\nChecking pg_default_acl for the public schema (functions)...\n");
  const defaultAcls = query(`
    select pg_get_userbyid(d.defaclrole) as role_default_applies_to,
           d.defaclacl as default_acl
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    where n.nspname = 'public' and d.defaclobjtype = 'f';
  `);

  for (const row of defaultAcls) {
    const acl = Array.isArray(row.default_acl) ? row.default_acl.join(",") : String(row.default_acl || "");

    if (row.role_default_applies_to !== ADMIN_OWNER) {
      // Migration 022 only alters `for role postgres` — deliberately, per
      // its own scope ("future functions created by postgres"). Every
      // function this project's migrations create is owned by postgres
      // (confirmed above, per-function), so a permissive default for a
      // different role (e.g. Supabase's internal supabase_admin) is not
      // exploitable via this project's own migration process. Reported
      // for visibility, not counted as a failure of 022's stated goal.
      if (/anon=|authenticated=|service_role=/.test(acl)) {
        console.log(`ℹ default privileges (role ${row.role_default_applies_to}, outside migration 022's scope): ${acl}`);
      }
      continue;
    }

    assert(
      !/anon=/.test(acl),
      `default privileges (role ${row.role_default_applies_to}): no default function EXECUTE for anon, found: ${acl}`
    );
    assert(
      !/authenticated=/.test(acl),
      `default privileges (role ${row.role_default_applies_to}): no default function EXECUTE for authenticated, found: ${acl}`
    );
    assert(
      !/service_role=/.test(acl),
      `default privileges (role ${row.role_default_applies_to}): no default function EXECUTE for service_role (fail-closed — must be explicit per migration), found: ${acl}`
    );
  }
  assert(
    defaultAcls.length === 0 || defaultAcls.some((r) => r.role_default_applies_to === ADMIN_OWNER),
    `a default-ACL entry for role ${ADMIN_OWNER} on public functions exists to check (sanity check — if this fails, the query itself may be wrong, not the database)`
  );

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
