Document: Post-Launch Roadmap
Version: 1.1
Last Updated: 2026-07-21
Status: Active
Owner: Andrew Deane
Related Sprint(s): Launch Polish Sprint (post Sprint 9, unnumbered) — see FINAL_ACCEPTANCE_REPORT.md and KNOWN_ISSUES.md

---

# Post-Launch Roadmap

Scheduling for the items raised in `KNOWN_ISSUES.md`, plus a pointer to
the pre-existing security roadmap. This is sequencing, not a commercial
plan — see `docs/business/` (once written) for marketing, KPIs, and
acquisition planning.

## Before launch — blocking

**Twilio credentials.** The auto-provisioning system itself is now built
and tested (`TWILIO_NUMBER_LIFECYCLE.md`) — what's left is adding
`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` to the production environment.
Without them, every provisioning attempt fails open (logged, retried,
never breaks a subscription) but no customer ever gets a working number.

**Registered office address.** A real UK consumer contract needs a real
registered office in Section 1 of the Terms. Decide on a virtual
business address or use the real one, then fill in the placeholder.

## Before the first cancellation's grace period elapses (~30 days after launch)

**A scheduled runner for `scripts/release-expired-twilio-numbers.js`.**
Not urgent on day one, but there is currently no cron/job runner
configured in this project at all, so this needs setting up (a daily
Railway Cron Job, or equivalent) well before it would actually matter.

## First week after launch (or immediately before, if time allows)

1. **Stripe Customer Portal** — ~2–3 days. Plan is written
   (`FINAL_ACCEPTANCE_REPORT.md` §3). Manage-subscription, cancel, and
   reactivate are reasonable expectations at this price point and
   currently require manual support intervention instead.
2. **Automated test coverage for this sprint's changes** — ~0.5 day. The
   new `/voice` trusted-call logging and the reshaped `/dashboard-data`
   response are currently proven only by a live UAT, not the regression
   suite. Cheap to close, and it's the kind of gap that goes unnoticed
   until a future refactor silently breaks it.
3. **Solicitor sign-off on the strengthened Terms** — no engineering
   estimate; scheduling depends on your solicitor's availability. Flagged
   as should-happen-before-launch if the timeline allows, first-week
   after if it doesn't.

## Later / opportunistic

- **Hero paragraph mobile line count** (Severity 3, cosmetic). Tighten
  only if the literal two-line result matters more than the exact
  prescribed wording.
- **Existing security & authentication roadmap** — password policy
  review, password generator, password-manager compatibility, future
  auth methods (passkeys, SSO), and a pre-launch security testing pass
  (SQL injection, XSS, brute-force, rate limiting, session timeout,
  account enumeration). Already fully documented in
  `docs/ENGINEERING_ROADMAP.md` — not duplicated here. That document
  predates this sprint and remains the source of truth for
  auth-hardening work.
- **`node_modules/` tracked in git** — pre-existing repository hygiene
  item, also already documented in `docs/ENGINEERING_ROADMAP.md`
  ("Repository Hygiene"). Unrelated to this sprint, not re-litigated
  here.
