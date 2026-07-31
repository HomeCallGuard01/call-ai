Document: Known Issues — Pre-Launch
Version: 3.3
Last Updated: 2026-07-31
Status: Active
Owner: Andrew Deane
Related Sprint(s): Launch Polish Sprint (post Sprint 9, unnumbered) — see FINAL_ACCEPTANCE_REPORT.md for full evidence. Severity 1 grant issue found and resolved-on-staging during migration-recovery/staging work — see docs/engineering/MIGRATION_RECOVERY_PLAN.md. Production fix still pending as a separate controlled change.

---

# Known Issues — Pre-Launch

Ordered by severity. Full evidence and reasoning for each is in
`FINAL_ACCEPTANCE_REPORT.md`; this file is the short, scannable list.

## Resolved this sprint

### ~~No Twilio number is ever assigned to a new customer~~ — fixed, one configuration step remains

Was Severity 1, blocking. Root cause and full design are in
`TWILIO_NUMBER_LIFECYCLE.md` and `FINAL_ACCEPTANCE_REPORT.md`. Summary of
the fix: a Twilio number is now purchased and assigned automatically the
moment a household's entitlement first becomes active, via
`services/twilioProvisioning.js` and the RPC functions in
`supabase/migrations/016_household_twilio_provisioning.sql` /
`017_household_twilio_number_lifecycle.sql`. Idempotency (never two
numbers for one household) is enforced at the database layer with a
row-locked RPC, not application-level timing. Failure is never silent:
every household tracks `twilio_provisioning_status`,
`twilio_provisioning_attempts`, and `twilio_provisioning_last_error`, and
a failed attempt is retried automatically (bounded, default 5 attempts)
on every subsequent webhook/reconciliation check before settling into
"flagged for administrative attention." Covered by two layers of
automated tests: RPC-level tests against a real Postgres-compatible
engine (`tests/migrations.pglite.test.mjs`) and orchestration-level unit
tests with injected fakes (`tests/twilio-provisioning.test.mjs`) —
successful provisioning, Twilio-failure retry, duplicate-webhook/race
prevention, and cancellation/deletion lifecycle are all exercised.

**Update, 2026-07-21 — verified end-to-end against the real Twilio API.**
`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` have since been added, and
migration 016's database objects (initially found to be missing despite
being reported as applied — see
`docs/engineering/016_017_migration_incident_notes.md`) were repaired and
confirmed working *at the time*. A full real test (test Stripe mode,
real Twilio credentials, a temporary ngrok tunnel standing in for a
public `APP_URL`) confirmed the provisioning code genuinely reaches
Twilio's real purchase endpoint. It stops there for one specific,
expected reason — see "UK number purchase requires a registered Twilio
Address" below. No number was purchased and no charge occurred; the
failure was correctly recorded on the test household exactly as
designed. **This "repaired and confirmed" status did not hold — see the
2026-07-22 update immediately below. Migration 016 must no longer be
described as repaired and confirmed until it is re-verified.**

**Update, 2026-07-22 — the migration 016 fix has silently reverted;
regression re-confirmed, do not redeploy yet.** Re-running the exact
same nonexistent-household edge-case test that originally caught this
bug (calling `assign_household_twilio_number` with a household ID that
does not exist) showed the defensive "household does not exist" check
no longer fires — the deployed function has reverted to its earlier,
pre-fix, buggy definition (the manually-selected `v_found` flag pattern,
not Postgres's built-in `FOUND`). This was confirmed by a read-only
check directly against the live database (an RPC call plus, separately,
inspecting the deployed function's actual source via
`pg_get_functiondef`) — no code, database, or Twilio changes were made
in the process.

This does **not** currently block normal customer provisioning: the
defect only affects the edge case of assigning a number to a household
ID that doesn't exist, which cannot happen in real usage (household IDs
always come from a real, already-looked-up row). The real-world
significance is different and more serious than the immediate
functional impact: **a database function that was previously deployed,
tested, and independently verified working has silently reverted to an
earlier version, with no infrastructure cause identified** (checked and
ruled out: schema-cache staleness, a full project restart, replica/HA
configuration, backup/restore history, DDL event triggers, pg_cron, and
GitHub migration-sync drift reconciliation — see
`docs/engineering/016_017_migration_incident_notes.md` for the full
investigation trail). Until this is understood, no previously-verified
database change in this project can be assumed to still be in place
without re-checking it.

**Decision: migration 016 and migration 017 must not be redeployed again
until Supabase support responds with an explanation, or we agree a
reliable mitigation and a post-deployment verification process that
would actually catch a silent revert** (e.g. a scheduled read-only check
re-running this same edge-case test on a recurring basis, not just a
one-time verification after deployment). No Supabase support case
number has been recorded in this repository yet — if one exists, it
should be added here.

## Severity 1 — resolved on staging, production fix still pending (found 2026-07-30)

### Every SECURITY DEFINER RPC granted EXECUTE to anon/authenticated, not just service_role

Discovered while applying the full migration set to the new staging
project (`docs/engineering/STAGING_ENVIRONMENT_PLAN.md`) — the first time
any migration in this project has been verified against a real Supabase
database from a clean state, rather than hand-applied incrementally to
production over time. Confirmed directly via
`information_schema.role_routine_grants` on staging: `anon` and
`authenticated` both have `EXECUTE` on **every** `SECURITY DEFINER`
function in `public` — `set_household_stripe_customer_id`,
`process_stripe_webhook_event`, `claim_stripe_webhook_event`,
`assign_household_twilio_number`, `release_household_twilio_number`,
`release_household_twilio_number_immediately`,
`mark_household_twilio_number_pending_release`,
`record_household_twilio_provisioning_failure`,
`anonymize_inactive_household`, `mark_household_activation_verified` —
10 functions checked, all affected, including the ones intended to be
the *only* sanctioned write path for Stripe/Twilio state.

**Root cause:** every one of these migrations ends with `revoke all on
function ... from public; grant execute on function ... to
service_role;`. That revoke only removes what was granted to the
`PUBLIC` pseudo-role. Supabase's platform default privileges grant
`EXECUTE` on new `public`-schema functions **directly** to
`anon`/`authenticated`/`service_role` as named roles, not via `PUBLIC` —
so the revoke never reaches them. This is a real Supabase platform
behavior, confirmed empirically, not a staging misconfiguration —
strongly implying production has the same exposure, though that has not
been directly checked yet (would need a separate, explicitly-approved
read-only pass).

**Why this matters, concretely:** several of these functions take a raw
`household_id` argument with no internal check that the caller owns that
household (they were only ever intended to be reachable via the backend's
service-role client, which enforces that ownership check at the
application layer instead). If `authenticated` genuinely has direct
`EXECUTE` in production too, any signed-in customer could in principle
call `set_household_stripe_customer_id` with someone else's household ID,
or invoke `process_stripe_webhook_event` directly — bypassing Stripe
signature verification entirely — to attempt to forge a subscription or
entitlement state. This has not been exploited or tested against
production; flagging the exposure, not a confirmed incident.

**Why the existing PGlite test suite didn't catch this:**
`tests/migrations.pglite.test.mjs` asserts "authenticated role cannot
execute X directly" for several of these functions, and those assertions
currently pass — for the wrong reason. PGlite's role stub never
replicates Supabase's default-privilege grants in the first place, so
there's nothing for the migration's `revoke`/`grant` pair to fail to
override; the test was never exercising the real platform behavior. This
is a fidelity gap in the harness itself, not just a missed case.

**Update, 2026-07-31 — fixed and verified on staging via migration 022
(`022_lock_down_security_definer_execute_grants.sql`). Production is
unaffected by this update — still pending as a separate, explicitly
controlled deployment.**

Migration 022 does two things: (1) an existence-checked `DO` block that
explicitly `revoke`s `PUBLIC`/`anon`/`authenticated` and re-`grant`s
`service_role` on all 11 current functions (the 10 above plus
`mark_household_activation_verified` from migration 021, itself also
staging-only so far); (2) `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN
SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM public, anon,
authenticated, service_role` — matching Supabase's own documented
recovery snippet
(https://supabase.com/docs/guides/api/securing-your-api) — so every
function created after this migration, by any future migration, starts
with **no** automatic grant to anyone, `service_role` included. This is a
deliberate fail-closed convention going forward: **every future migration
that adds a SECURITY DEFINER RPC must include its own explicit `grant
execute on function ... to service_role` line, exactly as all 13 existing
RPC migrations already do — there is no longer a platform default to fall
back on.** A migration that forgets this will fail loudly in testing
(`permission denied for function X`) rather than silently working by
accident.

Verified directly on staging, not just by the migration exiting 0:
- `scripts/verify-security-definer-grants.js` (new, dynamic — discovers
  every `SECURITY DEFINER` function in `public` from `pg_proc` itself,
  not a hardcoded list) reports all 11 functions PUBLIC/anon/authenticated-free,
  service_role-granted, safe `search_path`, correct owner — and
  `pg_default_acl` for the `postgres`-scoped default on public functions
  now reads `{postgres=X/postgres}` only.
- Live, non-destructive proof `service_role` still works for real: called
  `mark_household_activation_verified` with a nonexistent household UUID
  as `service_role` — got the function's own `P0001` "household does not
  exist" business-logic exception (proves the call reached the function
  body), not a permission error. The same call as `authenticated` gets
  `42501 permission denied for function` before the function body ever
  runs. No real household, subscription, Stripe, or Twilio data was
  touched by either check.
- `tests/migrations.pglite.test.mjs` gained a matching dynamic check
  (same discovery approach, run automatically on every `npm test`) — this
  catches a *future* migration that forgets the explicit grant; it cannot
  catch a live project's default-ACL configuration on its own, which is
  what the live script above is for. Both are needed; neither is
  redundant with the other.

**Production still has the original, safe state described above (never
exposed anon/authenticated in the first place — see the root-cause note)
and has not been touched.** Applying migrations 021 and 022 to production
is intentionally deferred as a separate, controlled change, not bundled
into this staging fix.

See `docs/engineering/MIGRATION_RECOVERY_PLAN.md`'s Execution Outcome
section for the full migration text and reasoning.

## Severity 2 — should fix before or very shortly after launch

### UK number purchase requires a registered Twilio Address

**This is the Severity 1 blocker preventing live UK number purchases —
distinct from the migration 016/017 database issues below, which are
about database reliability/lifecycle management, not this.** Even with
a perfectly-deployed database, no number can be purchased for any
customer until this is resolved.

Twilio's real purchase API rejected the test attempt with: *"Phone
Number Requires an Address but the 'AddressSid' parameter was empty."*
UK local numbers require a registered `Address` object on file with
Twilio (a real business address), referenced by its ID when purchasing.
This is the same open decision as "Registered office address is a
placeholder" below — not a second, separate blocker, the same missing
piece of information surfacing in a second place. Once a registered
office address is confirmed, create the corresponding Twilio `Address`
object and pass its SID through `buildIncomingPhoneNumberParams()` in
`services/twilioProvisioning.js`. Explicitly not done yet — no Address
object has been created, no placeholder or personal address has been
used. **Blocks real call screening from working for any customer until
resolved**, though the subscription/entitlement flow around it is
unaffected either way (fails open, exactly as designed).

### Migration 017's database objects are unconfirmed — separate outstanding repair

Migration 016 was found to be reported-applied but actually missing from
the real database, requiring a staged, statement-by-statement repair to
actually land (full account in
`docs/engineering/016_017_migration_incident_notes.md`). Migration 017
was written and tested against the same pattern in the same session and
has **not** been independently re-verified the same way. One of its four
objects, `cancel_household_twilio_number_pending_release`, was directly
confirmed missing via a live application call on 2026-07-21, and its
`twilio_number_pending_release_at` column was re-confirmed still absent
on 2026-07-22. Treat the whole file as unconfirmed until it goes through
the same staged repair — deliberately not done yet, and **per the
2026-07-22 update above, must not be attempted until Supabase support
responds or a reliable mitigation/post-deployment verification process
is agreed**, since migration 016 (already independently repaired and
verified once) has since silently reverted. Low practical urgency before
launch on its own merits (nothing exercises the cancellation/release
path until a customer actually cancels) — the reason to hold off now is
the unresolved revert risk, not this migration's own priority.

### No scheduled runner for expired-number release

`scripts/release-expired-twilio-numbers.js` correctly releases numbers
whose 30-day cancellation grace period has passed (see
`TWILIO_NUMBER_LIFECYCLE.md`), but nothing invokes it on a schedule —
there is no cron/job runner configured in this project today. Needs a
daily Railway Cron Job (or equivalent) before the first cancellation's
window elapses; a manual run is a fine stopgap until then.

### Stripe Customer Portal not yet built

Manage-subscription, cancel, and reactivate all currently require manual
support intervention. Plan exists — see
`FINAL_ACCEPTANCE_REPORT.md` §3 and `POST_LAUNCH_ROADMAP.md`. Estimated
~2–3 days.

### No automated test coverage for today's dashboard/call-logging changes

The new `/voice` trusted-call logging branch and the reshaped
`/dashboard-data` response were verified live, end-to-end, against a real
account — not by the automated suite (`npm test`). The existing suite
still passes unchanged, but nothing in it exercises the new code paths.

### Terms & Conditions need solicitor sign-off

The strengthened Terms (`public/terms.html`) are a considered draft, not
a solicitor-reviewed contract. Recommend UK consumer-law review before
go-live, particularly §5 (Cancellation), §9 (Fair use and abuse), and §10
(Refunds and statutory rights).

### service_role has no INSERT/UPDATE grant on public.user_roles

Discovered while assigning the admin role for the new Operations
Dashboard (Sprint 11): migration 002 grants `authenticated` a
`select`-own policy on `user_roles`, but never grants `service_role`
any write privilege on the table at all. This means the existing
`setUserRole()` helper (`database/households.js`) has likely never
actually worked from the app itself — any role assignment so far has
been done directly via the SQL Editor (as `postgres`, which bypasses
the missing grant). No in-app "make this user an admin/support" feature
could work today without this being fixed first. Deliberately not
fixed yet — needs its own reviewed migration (`grant insert, update on
public.user_roles to service_role`, plus deciding whether an RLS write
policy is also needed or whether service_role's usual bypass is
sufficient), not a quick patch bundled into an unrelated sprint.

### Registered office address is a placeholder

`public/terms.html` §1 still reads
`[REGISTERED OFFICE ADDRESS TO BE CONFIRMED]` pending a decision on
whether to use a virtual business address. Must be filled in before
launch — a UK consumer contract needs a real registered office stated.
**This same address is also now needed for the Twilio Address object**
above — resolving this one decision unblocks both.

## Severity 3 — cosmetic / optional

### Hero paragraph doesn't hold to two lines on every phone

The prescribed hero copy (`public/index.html`) renders as three to four
lines at a legible size on a 390px-wide screen, not the two originally
asked for. The exact wording was kept as supplied rather than rewritten
without asking — see `FINAL_ACCEPTANCE_REPORT.md` §1. Optional: tighten
the sentence if the literal line count matters more than the exact copy.

## Non-issues confirmed during testing

For completeness — investigated and found not to be problems:

- **Local server serving stale code mid-UAT.** Found and fixed during
  testing (process restarted). Confirmed to be a local-development
  artefact only: Railway redeploys the process fresh on every push, so
  this cannot recur in production.
- **`stripe_webhook_events.household_id`** — confirmed present on the
  live schema (not just the migration file) before being relied on in
  the cleanup SQL, given this project has had schema drift before (the
  `contacts` table itself predates its migration).
