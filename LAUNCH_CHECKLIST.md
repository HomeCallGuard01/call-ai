Document: Launch Checklist
Version: 1.0
Last Updated: 2026-07-16
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
| 2 | Confirm email | ✅ Done, verified for local development | Critical | Verified end-to-end on a real account (Yahoo address): confirmation email delivered via configured SMTP, link clicked, Supabase populated `confirmed_at`/`email_confirmed_at`, subsequent login succeeded, household/user_roles records created correctly and consistently (single linked triple, confirmed by direct DB inspection). The earlier Safari "cannot connect" report was root-caused to the `localhost` redirect link being opened on an iPhone, where `localhost` resolves to the phone itself, not the Mac running the dev server — not a code or configuration defect. See requirement below: this flow has only been verified against `localhost`, not the production domain or a real mobile device on that domain. |
| 3 | Log in | ✅ Done, verified | Critical | Full `[LOGIN]` sequence confirmed via server log, including household/role creation. |
| 4 | Reset password | ✅ Done, verified | Critical | `/reset-password-complete` returns a direct JSON API response (`200 { ok: true }`, `400 { error: "same_password" \| "invalid" }`, `500 { error: "failed" }`); `reset-password.html` submits via `fetch()` (native POST would lose the fragment-only recovery token on a page navigation, stranding the user on a `same_password` rejection with no way to retry short of a new email). UX: helper text under the new-password field, a `same_password` message that keeps the form usable for an inline retry, and a "Password updated successfully" panel with a "Continue to Dashboard" button on success. Tested end-to-end against a disposable, auto-deleted test account: a same-password attempt correctly returned `400 { error: "same_password" }`; a genuinely new password returned `200 { ok: true }` with session cookies set; logging in with the new password succeeded. |
| 5 | Upload contacts | ✅ Done, verified | Critical | Fixed in Sprint 9: `/upload-contacts` now requires login and writes via the household-scoped `insertContacts()`. Verified end-to-end — two test households each uploaded distinct CSVs and each saw only its own contacts, confirmed both via the app and via a direct Supabase REST call bypassing the app entirely. See `docs/sprints/Sprint_009/VERIFICATION.md`. |
| 6 | Subscribe via Stripe | ❌ Not started | Critical | Only a Stripe sandbox and a product exist (configuration, not integration). No checkout/webhook code exists. |
| 7 | Calls screened correctly | ✅ Done, verified | Critical | Fixed in Sprint 9: `/voice`/`/process` now resolve the household from the dialled Twilio number, scope the "known contact" check to it, and fail safely (no query, no write, clear error logged) when no household matches. Verified with both a matched and an unmatched number. See `docs/sprints/Sprint_009/VERIFICATION.md`. |
| 8 | Working dashboard | ✅ Done, verified | Critical | Fixed in Sprint 9: rotated the invalid service-role key, granted it least-privilege table access (Migration 009), added the missing `contacts` household-scoped RLS (Migration 008), and gated `/dashboard-data`/`/logs` behind login with an explicit `household_id` filter. Verified two households see only their own contacts and calls. See `docs/sprints/Sprint_009/VERIFICATION.md`. |
| 9 | Basic weekly reporting | ❌ Not started | Critical | No code exists for this yet. |
| 10 | Re-verify confirmation and password-reset redirects on production domain + mobile | ❌ Not started | Critical | Both flows are verified against `localhost` only. Confirmation redirect, password-reset redirect, and the Supabase redirect allow-list all need re-testing against the real production domain, including from an actual mobile device (the earlier Safari failure was `localhost` resolving to the phone itself, not the Mac — this exact class of issue could resurface differently once real domains and devices are involved). |

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

Two of the ten requirements are still entirely unbuilt (Stripe
subscription, weekly reporting). Register, log in, reset password, and
confirm email are now all verified end-to-end — but only against
`localhost`. Requirement 10 exists precisely because none of that
redirect-dependent testing has been repeated against the production
domain or a real mobile device yet, and the one failure already seen
(Safari on an iPhone treating `localhost` as the phone itself) shows this
class of issue behaves differently outside local development. Sprint 9
closed out the dashboard/contacts/calls isolation work that was the
biggest hidden risk. Remaining scope is smaller than at the start, but
Stripe integration in particular is still a full build, not a fix —
flagging this now rather than after the fact.

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
