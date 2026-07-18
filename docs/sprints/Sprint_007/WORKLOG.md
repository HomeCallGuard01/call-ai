Document: Sprint 7 – Household Identity — Work Log
Version: 1.0
Last Updated: 2026-07-14
Status: Complete
Owner: Andrew Deane
Related Sprint(s): Sprint 7

---

# Sprint 7 – Household Identity — Work Log

## Work completed

Four migrations, all with detailed inline rationale in their own file
headers/comments:

- `002_create_households_and_roles.sql` — creates `public.households`
  (`id`, `auth_user_id` unique nullable FK to `auth.users`, `email`,
  `phone_number`, `twilio_number`, `status` with check constraint,
  timestamps) and `public.user_roles` (`auth_user_id` PK FK to
  `auth.users` with `on delete cascade`, `role` text with check constraint
  `in ('admin', 'support', 'household')`, default `'household'`,
  timestamps). Adds a shared `hcg_set_updated_at()` trigger function.
  Enables RLS on both tables and adds one select-only policy each
  (`households_select_own`, `user_roles_select_own`), both scoped to
  `auth_user_id = auth.uid()`. Deliberately creates no authenticated
  insert/update policy on either table at this point — "household
  creation and modification remain server-side only" per the file's own
  comment.
- `003_add_household_id_ownership.sql` — adds `household_id` to
  `public.contacts` (nullable), adds FK constraints from both
  `contacts.household_id` and the pre-existing `calls.household_id`
  (created in Sprint 6 but never FK-constrained) to `households(id)`,
  `on delete set null`. Adds lookup indexes on both.
- `004_backfill_default_household.sql` — creates one default household
  (`email = 'default-household@homecallguard.internal'`, holding the
  founder's real `phone_number`/`twilio_number`) for pre-authentication
  development data, and backfills all existing `contacts`/`calls` rows
  with `household_id is null` to point at it.
- `005_household_rls.sql` — drafted real per-household RLS policies for
  `contacts` (replacing its permissive anon-key policies) and a
  household-scoped select policy for `calls`. **Frozen, not applied** —
  see `DECISIONS.md`.

## Files changed

`supabase/migrations/002_create_households_and_roles.sql`,
`003_add_household_id_ownership.sql`, `004_backfill_default_household.sql`
(all applied), `005_household_rls.sql` (drafted, not applied).

## Database changes

- New tables: `households`, `user_roles`
- New columns: `contacts.household_id`
- New FK constraints: `contacts.household_id → households(id)`,
  `calls.household_id → households(id)`
- New indexes: `contacts_household_id_idx`, `calls_household_id_idx`
- One default household row backfilled, with existing `contacts`/`calls`
  rows pointed at it
- Migration 005 (unapplied): would replace `contacts`' permissive
  anon/authenticated policies and add a `calls` select policy — remains a
  draft only
