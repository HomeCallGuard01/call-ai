Document: Sprint 8 Verification
Version: 2.0
Last Updated: 2026-07-14
Status: Active
Owner: Andrew Deane
Related Sprint(s): Sprint 8

---

# Sprint 8 — Verification

Each item below is graded by its actual evidence source. Nothing here is
marked confirmed without a specific, citable reason.

## Migration 006 — CONFIRMED applied and verified

Verified with a live `information_schema.role_table_grants` +
`pg_policies` query, pasted into the conversation. Result: 5 rows, all
matching the migration exactly.

| Table | Policy | Cmd | qual | with_check |
|---|---|---|---|---|
| households | `households_select_own` | SELECT | `auth_user_id = auth.uid()` | — |
| households | `households_insert_own` | INSERT | — | `auth_user_id = auth.uid() AND lower(email) = lower(auth.jwt() ->> 'email')` |
| households | `households_claim_default` | UPDATE | `auth_user_id IS NULL AND email = 'default-household@homecallguard.internal'` | `auth_user_id = auth.uid() AND lower(email) = lower(auth.jwt() ->> 'email')` |
| user_roles | `user_roles_select_own` | SELECT | `auth_user_id = auth.uid()` | — |
| user_roles | `user_roles_insert_own_household_role` | INSERT | — | `auth_user_id = auth.uid() AND role = 'household'` |

No extra or unexpected policies. GRANTs for `authenticated` confirmed
present (INSERT/UPDATE on `households`, INSERT on `user_roles`).

## Migration 007 (missing SELECT grant) — applied; inferred from behavior, not independently re-queried

Diagnosis: first login attempt failed at the household-lookup step with
`permission denied for table households` — a grant-layer error, not an
RLS error (confirmed by matching error text against the earlier `anon`
role precedent, and by the user independently confirming via a fresh
`information_schema.role_table_grants` query that `SELECT` was genuinely
missing for `authenticated` on both `households` and `user_roles`).
Migration `007_grant_authenticated_household_reads.sql` was written and
reviewed to add exactly `grant select on public.households/user_roles to
authenticated`.

Evidence it was applied: the **same server log file** contains a second
login attempt, later, that gets past the exact point the first one failed
at and completes successfully end to end (see "Server log verification"
below). This is strong behavioral evidence the grant was applied. **Not
independently re-confirmed** the way Migration 006 was — no fresh
`pg_policies`/grants query was run and pasted back after Migration 007
specifically.

## Registration — CONFIRMED

Server log:
```
DEBUG /register signUp result: {
  error: null,
  userId: '071be71c-3d37-4396-9ee5-16ba5b3870df',
  hasSession: false,
  userConfirmedAt: null,
  userEmailConfirmedAt: null
}
```
Account created successfully; `hasSession: false` confirms email
confirmation was required (not bypassed) at signup time.

## Email confirmation — PARTIALLY CONFIRMED / one part UNRESOLVED

The account *was* confirmed by the time of the later successful login —
this is inferable, not directly queried: Supabase's `signInWithPassword`
rejects unconfirmed accounts with an explicit `Email not confirmed` error
(directly proven earlier in this project against a different test
account), and the later login attempt for this account did not hit that
error.

However, the user separately reported **not receiving the confirmation
email**, and asked the assistant to help check four things: (1) whether
`auth.users.email_confirmed_at` was set for this user, (2) whether
"Confirm email" is actually enabled in Supabase Auth settings, (3)
whether the redirect URL is configured correctly, (4) whether Supabase
logged an email delivery failure. Exact diagnostic queries/steps were
given back to the user. **None of the four answers were reported back in
this conversation.** Whether the account became confirmed through a
normal (but undelivered/delayed) email, a dashboard setting difference
from what was assumed, or something else, is **unknown** — this should
not be recorded as resolved.

## Login — CONFIRMED

Server log, second attempt (after the grant fix):
```
[LOGIN] User authenticated
[LOGIN] Checking household
[LOGIN] Household exists? false
[LOGIN] Creating household...
[LOGIN] Household created
[LOGIN] Creating role...
[LOGIN] Role created
[LOGIN] Redirect dashboard
```

## Household creation — CONFIRMED

Same log excerpt above: `Household exists? false` → `Creating
household...` → `Household created`, with no error thrown in between (an
error would have produced `LOGIN HOUSEHOLD SETUP ERROR` and a redirect to
`/login.html?error=setup_failed` instead of reaching `Redirect dashboard`).

## Household role creation — CONFIRMED

Same log excerpt: `Creating role...` → `Role created`, same reasoning as
above.

## Dashboard access — CONFIRMED (server-side redirect + user statement)

`[LOGIN] Redirect dashboard` was logged, and the user's own follow-up
message referenced "the successful dashboard redirect" directly,
indicating they observed it in the browser. The assistant has no browser
access and did not independently observe this.

## SQL verification / Database verification — NOT independently confirmed in this conversation

The assistant proposed exact `select` queries against `households` and
`user_roles` for this test user's `auth_user_id`
(`071be71c-3d37-4396-9ee5-16ba5b3870df`) to formally confirm both rows'
contents. **The query output was never pasted back into this
conversation.** A separate, untracked personal note file
(`docs/sprints/READMEmd`, not authored by the assistant) records
"Database verified: ✅ households ✅ user_roles," but that claim has not
been corroborated with visible query output here, so it is not being
treated as confirmed fact in this document. If that verification has
since been done, running the queries below and recording the actual
output here would close this out properly:

```sql
select id, auth_user_id, email, phone_number, twilio_number, status, created_at, updated_at
from public.households
where auth_user_id = '071be71c-3d37-4396-9ee5-16ba5b3870df';

select auth_user_id, role, created_at
from public.user_roles
where auth_user_id = '071be71c-3d37-4396-9ee5-16ba5b3870df';
```

## Server log verification — CONFIRMED

This is the primary evidence source for this document — the full log
excerpts quoted above were read directly from the running server's
output.

## End-to-end browser verification — CONFIRMED (by user report)

The user performed the registration → login walkthrough in their own
browser and reported the outcome (including the "successful dashboard
redirect" reference above). The assistant did not observe this directly.

## Outstanding

- Independent confirmation of Migration 007 via a fresh grants/policy
  query (matching the rigor applied to Migration 006).
- The four email-confirmation diagnostic questions raised earlier,
  unanswered.
- The `households`/`user_roles` row-content SQL verification queries
  above, with actual output recorded.
- Temporary `[LOGIN]`/`[REGISTER]` debug logging is still in place and
  should be removed once all of the above is closed out.
