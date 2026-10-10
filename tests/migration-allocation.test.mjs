// Frozen migration allocation 046–075 — integration 2026-10-03 (+071 accounting automation, +072 operational events, 2026-10-04; +073 Apple store lifecycle state, launch sprint 2026-10-05; +075 support-verified forwarding proof, 2026-10-09)
// (docs/integration/2026-10-03-MIGRATION_RECONCILIATION.md §4).
// A migration already APPLIED somewhere keeps its identity; this test fails if
// any of them is renamed, renumbered or removed, or if a number collides.
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');

let failures = 0;
const check = (c, m) => { if (c) console.log(`✓ ${m}`); else { console.error(`✗ ${m}`); failures++; } };

const EXPECTED = {
  '046': ['046_voice_client_registration_history.sql', 'applied: production + staging'],
  '047': ['047_number_release_entitlement_guard.sql', 'applied: staging'],
  '051': ['051_financial_ledger_and_telephony_usage.sql', 'applied: staging'],
  '052': ['052_number_lifecycle_sweep_evidence.sql', 'objects on staging (history row pending repair)'],
  '053': ['053_entitlements_revenuecat_environment.sql', 'draft'],
  '054': ['054_number_lifecycle_sweep_run_evidence.sql', 'draft'],
  '055': ['055_call_delivery_evidence.sql', 'draft'],
  '056': ['056_financial_safety_allowance_and_admission.sql', 'draft'],
  '057': ['057_terms_acceptances_enable_rls.sql', 'applied: staging'],
  '058': ['058_revoke_default_table_privileges_anon_authenticated.sql', 'applied: staging'],
  '059': ['059_least_privilege_anon_authenticated_table_grants.sql', 'applied: staging'],
  '060': ['060_revoke_unused_authenticated_grants_and_pin_trigger_search_path.sql', 'applied: staging'],
  '061': ['061_global_default_revoke_function_execute_from_public.sql', 'applied: staging'],
  '062': ['062_customer_identity_and_routing_assignments.sql', 'draft'],
  '063': ['063_customer_allowance_credits_and_notices.sql', 'draft'],
  '064': ['064_call_delivery_events.sql', 'draft (drafted as 060)'],
  '065': ['065_household_iphone_carrier.sql', 'draft (drafted as 061)'],
  '066': ['066_telephony_abuse_shared_state.sql', 'draft (was provisional)'],
  '067': ['067_financial_containment_authorization_ledger.sql', 'draft (was provisional)'],
  '068': ['068_allowance_economic_credit_bridge.sql', 'draft (new)'],
  '069': ['069_account_classification_history.sql', 'draft (drafted as admin 055)'],
  '070': ['070_stripe_entitlement_canonical_decision.sql', 'draft (new; replaces 027\'s function)'],
  '071': ['071_accounting_transactions.sql', 'draft (accounting automation, 2026-10-04)'],
  '072': ['072_operational_events.sql', 'draft (operational events / notifications, soft-launch integration 2026-10-04)'],
  '074': ['074_households_forwarding_proof.sql', 'draft (LF-2 forwarding proof, 2026-10-06; 074 verified free on all branches/worktrees)'],
  '075': ['075_support_verified_forwarding_proof.sql', 'draft (B3 support-verified forwarding proof, 2026-10-09; 075 verified free on all branches/worktrees)'],
  '076': ['076_fortress_allowance_state_and_continuity_reserves.sql', 'draft (WS2 allowance state + unscreened reserve, 2026-10-10; 076/077 allocated to WS2 by the launch lead)'],
  '073': ['073_entitlements_store_subscription_state.sql', 'draft (Apple/RevenueCat cancellation + billing-issue state, launch sprint 2026-10-05; 073 verified free on all branches/worktrees)'],
};
const BURNED = ['048', '049', '050'];

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));
const byNumber = new Map();
for (const f of files) { const n = f.slice(0, 3); byNumber.set(n, [...(byNumber.get(n) || []), f]); }
for (const [n, list] of byNumber) check(list.length === 1, `number ${n} has exactly one migration (${list.join(', ')})`);
for (const [n, [file, state]] of Object.entries(EXPECTED)) {
  check(files.includes(file), `${n} is ${file} [${state}]`);
}
for (const n of BURNED) check(!byNumber.has(n), `burned number ${n} is never reused`);
const highest = Math.max(...files.map((f) => Number(f.slice(0, 3))));
check(highest === 76, `highest migration is 076 (found ${String(highest).padStart(3, '0')}); a new one needs this allocation updated deliberately`);
for (const n of ['062', '063', '064', '065', '066', '067', '068', '069', '070', '071', '072', '073', '074', '075', '076']) {
  const f = EXPECTED[n][0].replace(/^(\d{3})_/, '$1_rollback_');
  check(existsSync(path.join(DIR, '_rollbacks', f)), `${n} has a rollback file (${f})`);
}
console.log(failures === 0 ? '\nMigration allocation is as reconciled.' : `\n${failures} allocation check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
