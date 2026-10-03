// Read-only check of what an unauthenticated client (the public anon key)
// can reach through Supabase's Data API. Every table/view in `public` is
// requested with GET ?limit=0 (no rows can be returned even if a grant
// existed), plus a GET on the Storage bucket list. Expected result after
// migrations 057–061: every object answers 401/42501.
//
// Safe against production: GET only, limit=0, no RPC calls, no writes.
// Reads SUPABASE_URL / SUPABASE_ANON_KEY from the environment and never
// prints the key. The object list comes from the linked project's catalog
// (supabase db query --linked, read-only transaction), so new tables are
// covered automatically.
//
// Run with (example, staging):
//   set -a; source ../call-ai/.env.staging.local; set +a
//   node scripts/probe-anon-data-api.js
// It refuses to run if SUPABASE_URL's project ref differs from the linked
// project ref, so the catalog and the probed API are the same project.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

async function main() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set");
  const ref = new URL(url).hostname.split(".")[0];
  const linked = fs.readFileSync("supabase/.temp/project-ref", "utf8").trim();
  if (ref !== linked) throw new Error(`SUPABASE_URL is ${ref} but the linked project is ${linked} — refusing`);
  console.log(`Probing Data API as anon: ${ref}\n`);

  const raw = execFileSync("supabase", ["db", "query", "--linked", "--output-format", "json",
    "begin transaction read only; select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f') order by 1; rollback;"],
    { encoding: "utf8" });
  const objects = JSON.parse(raw.slice(raw.indexOf("{"))).rows.map((r) => r.relname);

  const headers = { apikey: anon, Authorization: `Bearer ${anon}` };
  let failures = 0;
  for (const name of objects) {
    const res = await fetch(`${url}/rest/v1/${encodeURIComponent(name)}?select=*&limit=0`, { headers });
    const body = await res.json().catch(() => ({}));
    const denied = res.status === 401 && body.code === "42501";
    if (!denied) failures += 1;
    console.log(`${denied ? "✓" : "✗"} ${name}: ${res.status} ${body.code ?? ""}`);
  }

  const buckets = await fetch(`${url}/storage/v1/bucket`, { headers });
  const list = await buckets.json().catch(() => null);
  const noBuckets = Array.isArray(list) && list.length === 0;
  if (!noBuckets) failures += 1;
  console.log(`${noBuckets ? "✓" : "✗"} storage: anon sees ${Array.isArray(list) ? list.length : "?"} bucket(s)`);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
