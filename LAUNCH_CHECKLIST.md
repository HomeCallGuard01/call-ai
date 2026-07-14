Document: Launch Checklist
Version: 1.0
Last Updated: 2026-07-14
Status: Active
Owner: Andrew Deane
Related Sprint(s): Sprint 8 onward

---

# Home Call Guard — Launch Checklist

Primary reference for MVP launch progress. Status reflects only what has
been directly verified (server logs, live testing, or code inspection) —
not assumed. Updated as each item is completed, with evidence.

Target: working MVP within 4–5 working days.

## MVP Requirements

| # | Requirement | Status | Classification | Notes |
|---|---|---|---|---|
| 1 | Register | ✅ Done, verified | Critical | Confirmed via server log (`DEBUG /register signUp result`, real user created). |
| 2 | Confirm email | ⚠️ Implemented, not fully verified | Critical | Account was confirmed by time of a later successful login, but a real test reported the email itself never arrived. Root cause (delivery vs. settings vs. rate limit) was never diagnosed. |
| 3 | Log in | ✅ Done, verified | Critical | Full `[LOGIN]` sequence confirmed via server log, including household/role creation. |
| 4 | Reset password | ⚠️ Implemented, not verified | Critical | `/forgot-password` and `/reset-password-complete` routes and pages exist. Never tested end-to-end in this engagement. |
| 5 | Upload contacts | ✅ Done, verified | Critical | Fixed in Sprint 9: `/upload-contacts` now requires login and writes via the household-scoped `insertContacts()`. Verified end-to-end — two test households each uploaded distinct CSVs and each saw only its own contacts, confirmed both via the app and via a direct Supabase REST call bypassing the app entirely. See `docs/sprints/Sprint_009/VERIFICATION.md`. |
| 6 | Subscribe via Stripe | ❌ Not started | Critical | Only a Stripe sandbox and a product exist (configuration, not integration). No checkout/webhook code exists. |
| 7 | Calls screened correctly | ✅ Done, verified | Critical | Fixed in Sprint 9: `/voice`/`/process` now resolve the household from the dialled Twilio number, scope the "known contact" check to it, and fail safely (no query, no write, clear error logged) when no household matches. Verified with both a matched and an unmatched number. See `docs/sprints/Sprint_009/VERIFICATION.md`. |
| 8 | Working dashboard | ✅ Done, verified | Critical | Fixed in Sprint 9: rotated the invalid service-role key, granted it least-privilege table access (Migration 009), added the missing `contacts` household-scoped RLS (Migration 008), and gated `/dashboard-data`/`/logs` behind login with an explicit `household_id` filter. Verified two households see only their own contacts and calls. See `docs/sprints/Sprint_009/VERIFICATION.md`. |
| 9 | Basic weekly reporting | ❌ Not started | Critical | No code exists for this yet. |

## Classification key

- **Critical** — required before launch (all 9 MVP items above, per the stated launch objective)
- **Important** — should be done before launch if time allows
- **Future** — post-launch improvement

## Known issues not yet on this list as separate line items

- Migration `005_household_rls.sql` (Sprint 7's broader, still-frozen
  contacts/calls RLS draft) remains superseded in part by Sprint 9's
  narrower `008`/`009` — still not applied, no action taken.
- Disposable test data from Sprint 9's verification (two test households,
  test contacts, test calls) remains in the database, clearly named.
  `service_role` correctly has no `DELETE` grant to clean it up itself.

## Honest read on the 4–5 day timeline

Two of the nine requirements are still entirely unbuilt (Stripe
subscription, weekly reporting), and one more is implemented but
unverified (password reset). Sprint 9 closed out the dashboard/contacts/
calls isolation work that was the biggest hidden risk. Remaining scope is
smaller than at the start, but Stripe integration in particular is still
a full build, not a fix — flagging this now rather than after the fact.

## Sprint log

**Sprint 9 — Complete Household Isolation (2026-07-14).** What changed:
contacts RLS (Migration 008), least-privilege service_role grants
(Migration 009), household-scoped dashboard/contacts/calls throughout
`server.js`. Why: a dashboard bug traced back to a real cross-household
data leak (unfiltered service-role calls queries, contacts still on
permissive development policies). How verified: full 7-step test via real
`/register`→`/login`→`/dashboard-data`/`/upload-contacts`/`/logs` routes
with two disposable test households, plus a direct Supabase REST check
bypassing the app to confirm RLS itself enforces isolation — see
`docs/sprints/Sprint_009/VERIFICATION.md` for the complete evidence.
Still needed: none for this sprint's scope; broader `005_household_rls.sql`
remains a separate, deliberately deferred item.
