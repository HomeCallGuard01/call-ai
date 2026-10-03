# Handover: permanent customer identity and carrier abstraction (2026-10-03)

## Where it is

| | |
|---|---|
| Branch | `feature/customer-identity-carrier-abstraction` |
| Worktree | `/Users/ad/call-ai-customer-identity` (`node_modules` is a symlink to `/Users/ad/call-ai/node_modules`, git-excluded) |
| Base | `origin/main` @ `eb43368` (PR #44) |
| Implementation commit | `54815d2` |
| HEAD | this handover commit, directly on top of `54815d2` |
| State | clean, pushed to `origin/feature/customer-identity-carrier-abstraction`; no PR opened, not merged |

## Confirmation: nothing outside this branch changed

* No deploy. No migration applied to production, staging or any database.
  All SQL ran only inside in-memory PGlite during tests.
* No production or staging read or write of any kind. No Supabase, Twilio,
  Stripe or RevenueCat API was called. The only provider-shaped code ran
  against injected fakes.
* No number purchased, ported, re-routed or released. No provider console
  was touched.
* No other Claude's worktree was edited. Other branches were read only to
  inventory migration numbers and align vocabulary
  (`architecture/voice-provider-portability`).
* Secret scan of the staged diff: no keys, tokens or JWTs. All phone
  numbers are fake fixtures.

## What was built

Full design: `docs/architecture/CUSTOMER_IDENTITY_AND_CARRIER_ABSTRACTION.md`.

### Schema and model (migration `062_customer_identity_and_routing_assignments.sql`)

* `households.account_number`: `NOT NULL`, unique, format-checked.
* `hcg_account_serial_seq`: START 1001 (decision D1).
* `hcg_account_numbers`: append-only registry. Never deleted from, and it
  keeps a tombstone if a household is hard-deleted.
* `telephony_providers` (code, display_name, status): `twilio` seeded as
  active.
* `routing_assignments`: household → protection_service → provider →
  provider_resource_id → e164_number, plus state, is_primary, acquisition
  and replaces_assignment_id. Partial unique indexes enforce: one active
  assignment per number, one live `(provider, resource_id)`, and one
  primary per household line.
* `routing_assignment_events`: append-only audit trail. Every change has an
  actor.
* `customer_identity_sync_anomalies`: records legacy-mirror refusals.
* RLS is on for every new table, with nothing granted to anon or
  authenticated. `service_role` gets SELECT only; writes go through
  SECURITY DEFINER RPCs with `search_path=''`, revoked from PUBLIC, anon and
  authenticated. All 20 new functions pass the existing grants check in
  `migrations.pglite.test.mjs`.
* Rollback script: `_rollbacks/062_rollback_…sql` (tested: drops
  everything, legacy keeps working, 062 re-applies). **Never run it once
  any account number has been shown to a customer.**

### Account-number design

* Format: `HCG-` + 7-digit zero-padded serial + Luhn check digit, e.g.
  `HCG-00010017`. It catches every single-digit typo and every adjacent
  transposition except 0↔9.
* It comes from the server-side sequence only. The trigger overwrites any
  client value: the `authenticated` role has table-wide INSERT on
  `households`, and a forged insert was tested. It is immutable even for a
  superuser, and never recycled (sequence plus registry; rollback-burned
  serials are not reused).
* It is not a credential. No middleware or customer route reads it
  (tested). Admin lookup sits behind `requireAdmin`.

### Backfill plan

* Inside 062: `backfill_household_account_numbers()` numbers households in
  `(created_at, id)` order. It's idempotent (only fills null rows; a retry
  numbers 0) and then sets `NOT NULL`. It bumps `updated_at` once on every
  household.
* `backfill_routing_assignments_from_legacy()`: the current
  `twilio_number` becomes an active primary assignment
  (`legacy_backfill`). Quarantine rows become `released`/`quarantined`
  history, idempotent through `provider_metadata.legacy_quarantine_id`.
  Non-E.164 values are skipped and recorded as anomalies.
* Before production, export `households` and `twilio_number_quarantine`.
  After applying, check: count of households = count of numbered
  households = registry rows; anomalies = 0; one primary per household with
  a number.

### Carrier abstraction and lifecycle

* The state machine is enforced by trigger on every write. The JS mirror
  is parity-tested on all 81 state pairs. `active → released` only happens
  through `complete_port`; every other release goes through
  releasing/quarantined.
* Port: `create(ported_in, port_pending, same number, different provider)`
  → `complete_port` atomically releases the source and activates the
  target, carrying primary across. A failed port leaves the source active.
* Replacement: provisioning → replacement_pending → active (overlap) →
  make_primary → old releasing → quarantined → released.
  `rollback_replacement` works while the old number is still active.
* Legacy mirror: triggers on `households.twilio_number` and
  `twilio_number_quarantine` follow today's Twilio code paths, with **no
  Node change**. A mirror error is written to anomalies and never blocks
  the legacy write.

### Provider adapter

`services/telephony/numberProviders/`: `contract.js` (provisionNumber,
getNumberConfiguration, configureInboundRoute, findResourceId,
fetchNumberStatus, releaseNumber, and capabilities as true/false/null),
`twilio.js`, and `registry.js` (only `twilio`; other codes throw and never
fall back). It is **not wired** into `twilioProvisioning.js`.

### Migration tooling

`services/customerIdentity/providerMigrationPlanner.js` (pure) and
`scripts/provider-migration-dry-run.js`. Input is a JSON snapshot only.
There is no DB or provider client, `--execute/--apply/…` are refused, and
numbers are masked by default. For each customer it reports the account
number, current provider and number, target, plan, port and replacement
state, forwarding action, verification status and rollback state. The doc
§7 has the read-only snapshot query.

### Consumers (inert until 062 is applied, because each reads `account_number || null`)

* `/dashboard-data` → `account.accountNumber`. The web dashboard
  (`upload.html`) shows an "Account number" row and "quote your account
  number" only when it is present.
* `/api/v1/me/dashboard` → new `account.accountNumber` field. Mobile UI is
  not touched (separate release track).
* Admin: search by account number (needs the `HCG` prefix and a valid
  check digit, so bare-digit phone searches are unaffected). The account
  number is shown in search results. `database/customerIdentity.js` is
  ready for the Admin Control Centre.

## Legacy assumptions found (not changed here)

1. `getHouseholdByTwilioNumber` loads **every household** per inbound call
   and matches `twilio_number` in JS. It is O(n) and couples routing to one
   Twilio column (`database/households.js:24`, `server.js:644,851`).
2. A single `households.twilio_number` column means no overlap, no
   replacement and no history. Release wipes it (017).
3. "Provisioned" is derived from `twilio_provisioning_status` plus
   `twilio_number` in `customerProtectionSteps.js:43`,
   `adminOnboardingStatus.js:97,237` and
   `businessMetrics/customerClassificationOverview.js:50`.
4. `twilioProvisioning.js` calls Twilio REST directly for search, purchase,
   SID lookup and release.
5. The live-monitoring warning SMS is sent **from** the household's Twilio
   number (`server.js attachLiveMonitoring` stream param `protectedNumber`
   → `mediaStreamHandler.js:294` → `smsWarning.js`). A replacement changes
   the sender, and a non-Twilio number cannot send through the Twilio
   client.
6. `twilio_number_quarantine` is Twilio-named and Twilio-shaped
   (`twilio_sid`). Households never stored the number's SID.
7. Admin search substring-matches `twilio_number`. Also found:
   `searchCustomers` interpolates raw input into a PostgREST `.or()`
   filter. It's admin-only and was already present, but it's a filter
   injection worth fixing separately.
8. Already correct: subscriptions, entitlements, contacts, calls, Stripe
   metadata (`household_id`) and RevenueCat key on the household, not on a
   number.

## Tests and results

| Run | Files | Pass | Fail |
|---|---|---|---|
| Baseline `origin/main` eb43368 (per file, dummy env) | 105 | 3793 | 9 |
| This branch | 107 | 4079 | 9 |

The 9 failures are identical on both sides: the known env-only Android
manifest tests (`android-full-screen-intent-permission`,
`android-incoming-call-notification-visibility`), which need
`mobile/node_modules`. The extra passes come from the two new files plus
the grants checks on 062's functions in `migrations.pglite.test.mjs`.

* `tests/customer-identity.pglite.test.mjs` (91 checks) covers: backfill
  of pre-existing customers; determinism; retry; uniqueness; forged
  sign-up value ignored; self-change refused; superuser change refused; 60
  interleaved sign-ups distinct; forced duplicate rejected;
  rollback-burned serial not reused; cancellation and reactivation; deleted
  account tombstoned and not reassigned; registry append-only; admin lookup
  by typed number; legacy routing backfill and history; legacy mirror
  through assign/release/quarantine/release-confirmed; mirror conflict
  doesn't block the legacy write; lifecycle parity; invalid transitions;
  CAS; actor required; immutability; no deletion; unknown and inactive
  providers; number held by another household; replacement plus cut-over
  plus rollback plus window closed; **subscription, entitlement, contacts
  and monitored minutes unchanged and no new household** after a
  replacement plus provider change; port guards; port failure; port
  success; resource-id collision (same provider rejected, cross-provider
  allowed, released reusable, no silent overwrite); hard-delete refused
  while a number is held; history kept after delete; audit completeness;
  rollback script.
* `tests/customer-identity.test.mjs` (93 checks) covers: format, parse and
  Luhn; typo and transposition detection; lifecycle helpers; Twilio
  adapter against a fake client; contract validation; registry refusing
  telnyx/aql/magrathea/`__proto__`; every planner scenario (port,
  non-portable, unknown portability, port in flight, failed port fallback,
  overlap verified, completed port, already on target, cancelled, pending
  replacement, unknown device, masking, conflicts, unverified port
  capability, replace_only); CLI refusals and masking; the planner and CLI
  load no clients; admin lookup and search; account number never used for
  authorisation.
* **Not proven:** true multi-connection concurrency. PGlite is a single
  connection, and no local Postgres exists (none was installed). On
  staging, after applying: run two `psql` sessions doing simultaneous
  sign-ups, and two sessions doing `routing_assignment_create` of the same
  number for different households. Expect distinct numbers, and exactly one
  success with "already held by another household" for the other.

## Migration conflicts (inventory 2026-10-03, all remote and local branches)

* Main ends at 046. 047 is on number-lifecycle branches. 051 is the ledger
  (applied to staging). 052 and 054 are the sweep. 053 is RevenueCat env.
  056 is financial safety.
* **Duplicates:**
  * 055: `account_classification_history` (control-centre-v2) vs
    `call_delivery_evidence` (delivery-resilience and iOS branches).
  * 060: `call_delivery_events` vs `revoke_unused_authenticated_grants…`
    (security, **applied to staging**).
  * 061: `household_iphone_carrier` vs
    `global_default_revoke_function_execute…` (security, **applied to
    staging**).
* 046 had a production history drift, which has since been repaired
  according to the ledger notes.
* This branch uses **062 as a provisional number** (the first unclaimed
  one). It depends on nothing after 046. Renumber 062 and its rollback at
  merge time, following the "numbers follow merge/application order" rule.
* Cross-migration interaction to re-check at merge:
  `security/supabase-staging-remediation` 058–061 change default grants.
  062 sets explicit revokes and grants on every object, so it should be
  unaffected, but re-run the grants check after both are in.

## Dependencies

* Main-only (nothing from unmerged branches).
* Number-lifecycle work (047/052/054 sweep) writes the same legacy columns
  and quarantine table. The mirror follows them automatically. When the
  sweep is merged, run both pglite suites together.
* The financial-safety (056) and ledger (051) branches should adopt the
  keying contract in doc §9.
* Admin Control Centre branches can consume `database/customerIdentity.js`.

## Integration plan

Doc §8, summarised:
1. Finalise the number, then apply on staging and run the concurrency
   checks.
2. Export, then apply in production.
3. Turn on the display (already wired).
4. Admin Control Centre consumes the routing history.
5. Shadow inbound read path behind a flag, alerting on mismatches.
6. Cut over the read path.
7. Provisioning goes through the adapter and lifecycle RPCs, then the
   mirror is retired.
8. Second provider adapter, only once its contract answers are in writing.

## Unresolved decisions (for Andrew)

* **D1** Serial START (1001 proposed). It is irreversible once issued.
* **D2** Format. `HCG-` + 8 digits with a check digit (proposed), or
  without a check digit. Changing it later means re-issuing.
* **D3** Retention. The account number is kept as a pseudonymous tombstone
  after account deletion (migration 029 path), which is what makes
  non-reuse possible. Privacy-policy wording may need a line.
* **D4** Whether support may accept an account number plus an email match
  as identification, or needs stronger verification.
* **D5** Stripe: add `account_number` to Checkout/Customer metadata
  (helpful in the Stripe dashboard). Not done; it touches billing code.
* **D6** Whether a separate `protection_services` table is wanted (multi-line
  households), or the `protection_service` text key is enough for now.
* **D7** The SMS warning sender after a replacement or non-Twilio number:
  fixed HCG sender ID versus the routing number.
* **D8** Whether 062 should ship before or after the number-lifecycle sweep
  (both touch quarantine semantics; they are compatible as tested here).

STOP. No merge, deploy, PR or further task was started.
