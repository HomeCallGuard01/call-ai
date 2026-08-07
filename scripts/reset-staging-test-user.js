// Safe, single-target staging test-user reset.
//
// Removes exactly one synthetic test user's data from staging, across
// every system that owns something scoped to them: Supabase Auth,
// households/user_roles, contacts, calls, entitlements/subscriptions,
// and (if present) their Stripe test-mode customer/subscription.
//
// Safety design, deliberately layered rather than relying on any single
// check:
//   1. Only ever loads .env.staging.local, never falls back to the
//      default .env (which points at production in this repo) — see
//      docs/RC1_CHECKLIST.md's "Staging environment" section.
//   2. Hard-asserts the resolved SUPABASE_URL actually contains the
//      staging project ref before running any query. Refuses to run
//      against anything else, including production, with no override.
//   3. Refuses to target the migration 004 placeholder household
//      (default-household@homecallguard.internal) or any household with
//      auth_user_id = null — that placeholder is never a valid target.
//   4. Operates on exactly one household per invocation, resolved from
//      an explicit --email argument — never a bulk "clean everything"
//      mode. Every delete is scoped to that one household's id / that
//      one auth user's id, nothing broader.
//   5. Dry-run by default. Prints every record (masked) that would be
//      deleted and exits 0 without touching anything unless --confirm
//      is also passed.
//
// Usage:
//   node scripts/reset-staging-test-user.js --email <address>              (dry run — shows targeted records only)
//   node scripts/reset-staging-test-user.js --email <address> --confirm    (actually deletes)

require("dotenv").config({ path: ".env.staging.local" });
const { createClient } = require("@supabase/supabase-js");

const STAGING_REF = "tigwgmayeuisrxjjykqd";
const PLACEHOLDER_EMAIL = "default-household@homecallguard.internal";

function mask(s) {
  if (!s) return s;
  const str = String(s);
  return str.length > 4 ? str.slice(0, 2) + "***" + str.slice(-2) : "***";
}

function assertStaging() {
  const url = process.env.SUPABASE_URL || "";
  if (!url.includes(STAGING_REF)) {
    console.error(
      `REFUSING TO RUN: SUPABASE_URL ("${url}") does not resolve to the staging project (${STAGING_REF}). ` +
        `This script only ever loads .env.staging.local and never falls back to .env, but the resolved URL still ` +
        `doesn't match — stopping rather than guessing. Confirm .env.staging.local exists and is correct.`
    );
    process.exit(1);
  }
  console.log(`Confirmed target: staging (${STAGING_REF}). Safe to proceed.\n`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const emailIdx = args.indexOf("--email");
  const email = emailIdx !== -1 ? args[emailIdx + 1] : null;
  const confirm = args.includes("--confirm");
  if (!email) {
    console.error("Usage: node scripts/reset-staging-test-user.js --email <address> [--confirm]");
    process.exit(1);
  }
  return { email, confirm };
}

async function main() {
  assertStaging();
  const { email, confirm } = parseArgs();

  if (email.toLowerCase() === PLACEHOLDER_EMAIL) {
    console.error(`REFUSING TO RUN: "${mask(email)}" is the migration 004 placeholder household — never a valid target.`);
    process.exit(1);
  }

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const stripe = process.env.STRIPE_SECRET_KEY ? require("stripe")(process.env.STRIPE_SECRET_KEY) : null;

  const { data: household, error: hErr } = await admin
    .from("households")
    .select("*")
    .ilike("email", email)
    .maybeSingle();

  if (hErr) {
    console.error("Household lookup failed:", hErr.message);
    process.exit(1);
  }
  if (!household) {
    console.log(`No household found for ${mask(email)} — nothing to do.`);
    return;
  }
  if (!household.auth_user_id) {
    console.error(
      `REFUSING TO RUN: household for ${mask(email)} has auth_user_id = null — this is the placeholder pattern, not a real test user, even though the email didn't match exactly. Stopping.`
    );
    process.exit(1);
  }

  const householdId = household.id;
  const authUserId = household.auth_user_id;

  const [{ data: contacts }, { data: calls }, { data: entitlements }, { data: subscriptions }, { data: roles }] = await Promise.all([
    admin.from("contacts").select("id, name, number").eq("household_id", householdId),
    admin.from("calls").select("id, number, status, result, created_at").eq("household_id", householdId),
    admin.from("entitlements").select("id, entitlement_type, ends_at").eq("household_id", householdId),
    admin.from("subscriptions").select("id, status, stripe_subscription_id").eq("household_id", householdId),
    admin.from("user_roles").select("auth_user_id, role").eq("auth_user_id", authUserId),
  ]);

  let stripeSubs = [];
  if (stripe && household.stripe_customer_id) {
    const res = await stripe.subscriptions.list({ customer: household.stripe_customer_id, limit: 20 });
    stripeSubs = res.data;
  }

  console.log("=== TARGETED FOR DELETION ===");
  console.log(JSON.stringify({
    household_id_prefix: householdId.slice(0, 8),
    auth_user_id_prefix: authUserId.slice(0, 8),
    email_masked: mask(household.email),
    phone_number_masked: mask(household.phone_number),
    twilio_number_masked: mask(household.twilio_number),
    stripe_customer_id_masked: mask(household.stripe_customer_id),
  }, null, 2));
  console.log(`contacts: ${contacts?.length ?? 0} row(s)`);
  console.log(`calls: ${calls?.length ?? 0} row(s)`);
  console.log(`entitlements: ${entitlements?.length ?? 0} row(s)`);
  console.log(`subscriptions (app table): ${subscriptions?.length ?? 0} row(s)`);
  console.log(`user_roles: ${roles?.length ?? 0} row(s)`);
  console.log(`Stripe test-mode subscriptions: ${stripeSubs.length} (${stripeSubs.map(s => mask(s.id) + ":" + s.status).join(", ")})`);
  console.log(`Stripe test-mode customer: ${household.stripe_customer_id ? mask(household.stripe_customer_id) : "(none)"}`);
  console.log(`Supabase Auth user: ${mask(authUserId)}`);

  if (!confirm) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --confirm to actually delete the records above.");
    return;
  }

  console.log("\n--confirm passed — deleting now, in dependency order...");

  if (stripe) {
    for (const sub of stripeSubs) {
      await stripe.subscriptions.cancel(sub.id);
      console.log(`✓ cancelled Stripe subscription ${mask(sub.id)}`);
    }
    if (household.stripe_customer_id) {
      await stripe.customers.del(household.stripe_customer_id);
      console.log(`✓ deleted Stripe customer ${mask(household.stripe_customer_id)}`);
    }
  }

  await admin.from("calls").delete().eq("household_id", householdId);
  console.log("✓ deleted calls");
  await admin.from("contacts").delete().eq("household_id", householdId);
  console.log("✓ deleted contacts");
  await admin.from("entitlements").delete().eq("household_id", householdId);
  console.log("✓ deleted entitlements");
  await admin.from("subscriptions").delete().eq("household_id", householdId);
  console.log("✓ deleted subscriptions (app table)");
  await admin.from("user_roles").delete().eq("auth_user_id", authUserId);
  console.log("✓ deleted user_roles");
  await admin.from("households").delete().eq("id", householdId);
  console.log("✓ deleted household");
  const { error: authDelErr } = await admin.auth.admin.deleteUser(authUserId);
  if (authDelErr) console.error("✗ auth user delete failed:", authDelErr.message);
  else console.log("✓ deleted Supabase Auth user");

  console.log(`\nDone. ${mask(email)} fully removed from staging.`);
}

main();
