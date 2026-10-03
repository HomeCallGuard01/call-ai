# Customer identity and carrier abstraction

Status: **design + draft implementation, 2026-10-03.** Branch
`feature/customer-identity-carrier-abstraction`. Migration 062 is a
provisional-number DRAFT. It has not been applied anywhere, and nothing is
deployed or wired into the live call path.

## 1. Problem

Today a customer's identity in HCG is effectively their Twilio number:

| Coupling | Where | Consequence |
|---|---|---|
| One routing number per household, stored as a column | `households.twilio_number` (002, 016) | No overlap, no replacement and no history are possible |
| Inbound routing scans every household for `twilio_number` | `database/households.js` `getHouseholdByTwilioNumber` (used by `/voice` and `/process` in `server.js`) | A number can only ever map to one household row. The scan also loads every household per call (O(n)). |
| Release wipes the number from the household | `release_household_twilio_number*` (017) | History survives only in `twilio_number_quarantine`, which is Twilio-named and Twilio-shaped (`twilio_sid`) |
| "Has a number" == "provisioned" | `customerProtectionSteps.js:43`, `adminOnboardingStatus.js:97,237`, `businessMetrics/customerClassificationOverview.js:50` | Protection state is derived from a Twilio column |
| The provisioning orchestrator calls Twilio REST directly | `services/twilioProvisioning.js` | A provider swap means rewriting provisioning |
| The live-monitoring SMS sender is the household's Twilio number | `server.js attachLiveMonitoring` → stream param `protectedNumber` → `mediaStreamHandler.js:294` → `smsWarning.js` | A replacement number changes the sender the customer sees. A non-Twilio number cannot send SMS through the Twilio client. |
| Admin search matches `twilio_number` substrings | `database/adminMetrics.js searchCustomers` | Support identifies people by phone numbers, and HCG has no stable reference to quote |
| Nothing a customer can quote | — | Support uses emails or phone numbers, both of which change |

What is already correctly decoupled: subscriptions, entitlements, contacts,
calls, Stripe metadata (`household_id`) and RevenueCat are all keyed by
`household_id`, never by a phone number.

## 2. Model

```
Customer (auth user)
  └─ Household  ── the HCG account (billing, contacts, allowance, calls)
       ├─ account_number  HCG-00010017  (permanent, human-readable, not a credential)
       └─ Protection service  ('primary' today; routing_assignments.protection_service)
            └─ Routing assignment(s)                       routing_assignments
                 ├─ provider            → telephony_providers.code
                 ├─ provider_resource_id  (Twilio PN SID, …; opaque)
                 ├─ e164_number           (public number customers forward to)
                 ├─ state                 lifecycle (§4)
                 ├─ is_primary            the one that answers for this line
                 ├─ acquisition           purchased | ported_in | legacy_backfill | legacy_mirror
                 ├─ replaces_assignment_id  (port source or replaced number)
                 └─ history               routing_assignment_events (append-only)
```

"Customer" and "household" are the same HCG account. Every billing and
safety record already hangs off `household_id`, so the account number lives
on the household. A future multi-user household keeps one account number.

## 3. Account number

* Format: `HCG-` + a 7-digit zero-padded serial + 1 Luhn check digit, e.g.
  `HCG-00010017`. Serials beyond 9,999,999 grow longer and are never
  truncated. The brief's `HCG-00000127` has the right shape, but its check
  digit is not valid under Luhn (serial 12 → `HCG-00000125`).
* The check digit catches every single-digit typo and every adjacent
  transposition except 0↔9 (tested), so support catches a misheard number
  before looking anyone up.
* It comes from `hcg_account_serial_seq`, server-side only. A `BEFORE
  INSERT/UPDATE` trigger always overwrites any client-supplied value.
  `authenticated` holds table-wide INSERT on `households` (migration 006),
  so this trigger is what stops a customer choosing one. An issued number
  is immutable, even for a superuser UPDATE.
* It is never recycled. A Postgres sequence never re-issues a value, even
  from a rolled-back transaction. The `hcg_account_numbers` registry is
  append-only (deletes and updates refused) and keeps a tombstone
  (`household_id = null`) if a household is hard-deleted. Anonymised
  accounts (migration 029) keep their number.
* Concurrency: `nextval` is non-transactional and atomic. Uniqueness is
  enforced twice, by `households_account_number_key` and the registry PK.
  PGlite proved 60 interleaved sign-ups get distinct numbers and that a
  forced duplicate is rejected. A true multi-connection race still needs
  running on staging (§9).
* START is 1001, so a number doesn't reveal "customer #3". **This is a
  decision for Andrew before application.** It can't be lowered later.
* **It is not authentication.** No middleware or customer route reads it.
  Customer routes still resolve the household from the session only
  (tested). Admin lookup is behind `requireAdmin`. Support must still
  verify identity (email on file, etc.) before acting on a quoted number.

### Backfill

The backfill runs inside migration 062: `backfill_household_account_numbers()`
numbers households in `(created_at, id)` order, so the oldest gets the
lowest serial. It only touches rows where `account_number is null`, so
retries are no-ops and nobody is ever given a second number. It then sets
`NOT NULL`. Side effect: it bumps `households.updated_at` once for every
row, and nothing reads that column as an activity signal.

## 4. Number lifecycle

```
requested ─► provisioning ─► active ◄──────────────┐
    │             │            │  │                 │ (reactivate)
    │             │            │  └─► quarantined ──┤
    │             │            └────► releasing ────┤──► released
    │             └─► replacement_pending ─► active │
    └─► port_pending ─► active (complete_port)      │
  any pre-active ─► failed                          │
```

The exact table is `routing_assignment_transition_allowed` in SQL and
`TRANSITIONS` in `services/customerIdentity/routingLifecycle.js`. The two
are parity-tested across all 81 state pairs.

* `active → released` is allowed **only** in
  `routing_assignment_complete_port` (the number left for another
  provider). Every other release goes through releasing/quarantined, which
  keeps the existing deactivation-confirmation quarantine policy.
* Guards apply to every write, including a superuser's: transitions follow
  the table; household, provider, acquisition and `replaces` are immutable;
  number and resource id are set once; no number is held by two households
  (serialised by an advisory lock on the number); one active assignment per
  number; one live `(provider, resource_id)`; one primary per household line;
  primary only while active.
* Assignments are never deleted. Events are append-only. Every change
  carries an `actor` (RPCs require one; the mirror uses `legacy_mirror`).
* `service_role` has only SELECT on the new tables. All writes go through
  the RPCs.

### Scenarios (each is tested in `tests/customer-identity.pglite.test.mjs`)

| Scenario | Steps |
|---|---|
| Replacement number | `create(purchased, provisioning, replaces=old)` → `replacement_pending` (number + resource id) → `active` (overlap: both active, old still primary) → `make_primary(new)` after the customer's forwarding is verified → old `releasing → quarantined → released` |
| Rollback replacement | `rollback_replacement(new)`: old becomes primary again and new goes to `releasing`. Refused once the old number is released ("rollback window closed") |
| Port success | `create(ported_in, port_pending, replaces=old, same number, different provider)` → `complete_port`: old `released`, new `active` and inherits primary, all in one transaction |
| Port failure | `port_pending → failed`. The old number stays active and primary, so there is nothing to roll back. The planner falls back to replacement |
| Cancellation / reactivation | Account number unchanged. If the number is still held (`releasing`/`quarantined`) it returns to `active`; otherwise it gets a new assignment |

## 5. Legacy mirror (no change to the Twilio code paths)

Triggers keep `routing_assignments` in step with the code that runs today:

| Legacy event | Mirror |
|---|---|
| `households.twilio_number` null → X (assign RPC) | active assignment for X (`legacy_mirror`). Becomes primary if the household has none |
| X → null (any release RPC) | X `active → releasing` |
| `twilio_number_quarantine` insert | `→ quarantined`, fills in `twilio_sid` |
| quarantine `released_at` set | `→ released` |
| X re-assigned while X is still held by the same household | `releasing/quarantined → active` |

A mirror error is caught and written to `customer_identity_sync_anomalies`.
**It never blocks the legacy write.** Tested case: the legacy assign of a
number still quarantined for another household succeeds, the mirror refuses
it, and one anomaly row is written. That case is a real alert condition.

## 6. Provider adapter

`services/telephony/numberProviders/`:

* `contract.js`: the operations HCG actually performs: `provisionNumber`,
  `getNumberConfiguration`, `configureInboundRoute`, `findResourceId`,
  `fetchNumberStatus`, `releaseNumber`, plus `capabilities`
  (true/false/**null = unverified**).
* `twilio.js`: the only Twilio-aware file here. Twilio params (`addressSid`,
  `bundleSid`, `voiceUrl`) stay inside it. Port capabilities are `null`,
  because HCG has never ported through Twilio.
* `registry.js`: only `twilio` is implemented. Any other code (telnyx, aql,
  magrathea…) throws `UnsupportedNumberProviderError` and never falls back
  to Twilio. A provider can exist as a `telephony_providers` row before it
  has an adapter.
* Vocabulary matches the unmerged `architecture/voice-provider-portability`
  `numberProvider.js` seam (id / inboundCallUrl / addressId / bundleId) so
  the two can be merged. That branch's seam is still not on main, so this
  one sits in a separate directory to avoid file collisions.
* **Not wired into `twilioProvisioning.js`** in this branch (see §8).

## 7. Migration tooling (dry run)

* `services/customerIdentity/providerMigrationPlanner.js` is pure. For each
  customer it reports the HCG account number, current provider and number
  (masked), target, plan (`port_number`, `replace_number`,
  `replace_number_after_port_failure`, `port_completed`,
  `replacement_completed`, `already_on_target`, `no_active_routing`), port
  and replacement state, forwarding action (mobile/landline/unknown
  wording), verification status, rollback state, notes, and a summary
  (including numbers held by more than one household).
* It never plans a port unless the target's `portIn` capability is `true`
  **and** the number is known to be portable. Otherwise it plans a
  replacement and gives the reason.
* `scripts/provider-migration-dry-run.js` reads a JSON snapshot only. It
  has no DB or provider client (tested by a source check) and refuses
  `--execute/--apply/--commit/--live/--write`.

Read-only snapshot query (for **staging**; do not run against production
without approval):

```sql
select json_build_object(
  'households', (select json_agg(json_build_object(
      'id', id, 'account_number', account_number, 'status', status,
      'device_type', device_type, 'activation_verified_at', activation_verified_at))
    from public.households where email not like '%@deleted.homecallguard.internal'),
  'assignments', (select json_agg(r) from (
      select id, household_id, protection_service, provider_code, e164_number, state,
             is_primary, acquisition, replaces_assignment_id, state_changed_at, created_at
        from public.routing_assignments) r));
```

## 8. Integration plan (each step separately approved)

1. **Merge 062** with its final number (currently provisional). Apply on
   staging. Run `tests/customer-identity.pglite.test.mjs` scenarios against
   staging with two concurrent `psql` sessions (sign-up race; same-number
   race between two households). Check anomalies = 0. Then production, with
   an export of `households` first.
2. **Display only** (already in this branch, inert until 062 exists):
   `/dashboard-data` `account.accountNumber`, web dashboard "Account
   number" row, mobile `/api/v1/me/dashboard` `account.accountNumber`,
   admin search by account number, and the account number shown in admin
   search results. Mobile UI is deliberately untouched (separate release
   track).
3. **Admin Control Centre**: consume `database/customerIdentity.js`
   (`getHouseholdByAccountNumber`, `getRoutingAssignments`,
   `getRoutingEvents`) and `summariseRoutingHistory`, which exposes no
   resource ids. Add `account_number` to curated column lists
   (`ONBOARDING_HOUSEHOLD_COLUMNS`, `getHouseholdStatusDetail`) **only after
   062 is applied**, because naming a missing column breaks those queries.
4. **Shadow read path**: behind a flag, resolve inbound households with
   `getHouseholdIdByActiveNumber` alongside `getHouseholdByTwilioNumber`.
   Log mismatches and alert on any. This also removes the full-table scan.
5. **Cut over the read path.** After that, `households.twilio_number`
   becomes a compatibility column written only by the mirror's inverse.
6. **Provisioning through the adapter**: `twilioProvisioning.js` uses
   `getNumberProviderAdapter(provider)` and the lifecycle RPCs directly. The
   legacy mirror is then retired.
7. **Second provider**: add a `telephony_providers` row and adapter after
   the contract questions in `VOICE_PROVIDER_PORTABILITY.md` are answered
   in writing. Run the planner against a staging snapshot first.

## 9. Billing, financial and fraud contract

* Subscriptions, entitlements, Stripe customer/metadata, RevenueCat app
  user, contacts, calls and monitored minutes all key on `household_id`.
  Changing provider or number creates no household, subscription or
  entitlement (tested: account number, subscription ids, entitlement ids,
  contact count and monitored seconds are identical before and after a
  replacement plus provider change).
* **Contract for financial-safety, ledger and fraud work** (branches
  `feature/financial-safety-hard-limits`,
  `feature/provider-neutral-billing-ledger`):
  * Key allowances, spend ceilings, usage periods, kill switches,
    abuse/fraud scores and ledger attribution on `household_id`. Show
    `account_number` to humans.
  * Never key on an E.164 number. To attribute a call leg, resolve
    `To`/`Called` → household through `routing_assignments` **at the call's
    time**, using `state_changed_at`/events, because numbers move between
    states and, after release, could one day belong to someone else.
  * Store `provider_code` + `provider_resource_id` on per-leg cost rows, so
    a mixed-provider month reconciles per provider.
  * A household's allowance and limits carry across replacement and port
    unchanged. A new number is never a new allowance.
  * An account number in a request is never evidence of identity for a
    refund, credit or limit override.

## 10. Known gaps and decisions

See the handover (`docs/handovers/2026-10-03-customer-identity-carrier-abstraction-handover.md`).
