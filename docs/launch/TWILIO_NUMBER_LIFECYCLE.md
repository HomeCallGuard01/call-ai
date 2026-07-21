Document: Twilio Number Lifecycle
Version: 1.1
Last Updated: 2026-07-21
Status: Active
Owner: Andrew Deane
Related Sprint(s): Launch Polish Sprint (post Sprint 9, unnumbered) — closes the Severity 1 item in KNOWN_ISSUES.md

---

# Twilio Number Lifecycle

Covers the full life of a household's Twilio number: acquisition,
retention through cancellation, and release — either after a grace
period or immediately, depending on why it's being released.

## Acquisition

See `FINAL_ACCEPTANCE_REPORT.md` and the migration/service files
themselves (`supabase/migrations/016_household_twilio_provisioning.sql`,
`services/twilioProvisioning.js`) for the provisioning design. Summary:
a number is purchased automatically the moment a household's entitlement
first becomes active (Stripe payment confirmed) — not at registration or
email verification, so no cost is incurred for accounts that never
convert.

**Verified end-to-end against the real Twilio API, 2026-07-21.** The
full path — entitlement active → search → purchase attempt — was
confirmed to genuinely reach Twilio's real purchase endpoint (test
Stripe mode, real Twilio credentials, a temporary ngrok tunnel standing
in for a public `APP_URL`, since Twilio validates that a number's voice
webhook is a real reachable URL). It currently stops there for one
specific, expected reason: **UK local numbers require a registered
Twilio `Address` object**, referenced via `AddressSid` on the purchase
call — this app doesn't create or pass one yet. See
`docs/launch/KNOWN_ISSUES.md` ("UK number purchase requires a registered
Twilio Address") for current status; it's tied to the same registered
office-address decision the Terms & Conditions are waiting on, not a
separate piece of work. No number was purchased and no charge occurred
during this test — confirmed directly against the Twilio account — and
the failure was correctly recorded on the household exactly as this
system was designed to do.

## Cancellation: 30-day grace period, not immediate release

When a subscription genuinely terminates (Stripe reports the underlying
subscription status as no longer qualifying — not merely
`cancel_at_period_end = true` while the subscription is still active and
paid-through), the household's number is **not** released immediately.
Instead, `twilio_number_pending_release_at` is set to 30 days out, and
the number is only actually released once that deadline passes with no
reactivation.

**Why a grace period, and why 30 days specifically:**

1. **Misdirected-call risk, not just cost.** This product's model is
   "keep your existing home phone number" — a customer sets up call
   forwarding *from* their real landline *to* the Twilio number assigned
   to their household. If that number were released and Twilio handed it
   to a different customer right away, a churned customer who forgot to
   remove their forwarding rule would have their calls silently start
   ringing a stranger's household instead. That's a real misdirection/
   privacy problem, not a cost-optimisation question, and it has no
   natural cap if numbers are recycled instantly.
2. **Reactivation UX.** "Cancel anytime" plus Stripe Portal reactivation
   before the period ends should let a customer keep the *same* number if
   they come back — forcing a new number on same-day reactivation would
   be a worse experience than the alternative.
3. **Cost is real but small and bounded.** Twilio charges roughly £1/month
   per idle number — 30 days of that is a known, small, capped cost.
   Releasing instantly avoids that cost but reopens the risk in point 1,
   which has no equivalent cap.

30 days is a judgement call, not a figure from a stated business
requirement — it matches a common "final chance to come back on the same
number" window and is easy to change (`p_grace_period` on
`mark_household_twilio_number_pending_release`, or the `gracePeriodDays`
default in `database/households.js`) if you want it shorter or longer.

**Reactivation before the deadline:** handled automatically. Every time a
household's entitlement is re-confirmed active (a new Stripe event, or a
reconciliation poll), `cancel_household_twilio_number_pending_release` is
called first — if a release was pending, it's cancelled and the household
keeps its existing number, uninterrupted.

## Account deletion: immediate release, no grace period

Different in kind from cancellation: an account-deletion request is
explicit and deliberate, not something that might have been accidental or
reconsidered the way a lapsed subscription might be. There is no
ambiguity to protect against, so immediate release is correct —
consistent with not retaining a resource tied to a deleted account any
longer than necessary.

**No account-deletion feature exists in this codebase yet.** This sprint
adds the release primitive one will need
(`release_household_twilio_number_immediately`, wrapped by
`releaseTwilioNumberImmediately()` in `services/twilioProvisioning.js`),
fully implemented and tested, but nothing currently calls it — when
account deletion is built, that's the function it should call.

## How release actually happens

Two RPCs do the real work, both in
`supabase/migrations/017_household_twilio_number_lifecycle.sql`:

- `release_household_twilio_number(household_id, expected_number)` — the
  grace-period path. Atomically (row-locked) checks the number still
  matches, a deadline was set, and it has passed, before clearing
  anything. Returns false otherwise, refusing to release a number that's
  still legitimately in use or has already changed.
- `release_household_twilio_number_immediately(household_id)` — the
  deletion path. No deadline check at all; returns the number that was
  released (or null) so the caller can release it from Twilio's side too.

Both reset the household back to `twilio_provisioning_status = 'pending'`
with a clean slate, so a future resubscription provisions a fresh number
without any leftover state.

**Ordering, and the one honestly-named residual risk:** the database
write happens *before* the Twilio-side release call, not after. If the
Twilio call then fails, the result is a harmless (if wasteful) orphaned
Twilio resource nothing in our system references anymore. The reverse
order — releasing from Twilio first — risks the opposite and much worse
failure: a database error leaves our records still pointing at a number
Twilio has already given to someone else, which is a real misrouting
hazard, not just idle cost.

## Database status: migration 017 needs re-verification

Migration 016 was found to report success while actually applying
nothing to the real database, and required a staged, statement-by-
statement repair before it could be trusted (full account in
`docs/engineering/016_017_migration_incident_notes.md`). Migration 017
— which defines every function in this document (`mark_...`, `cancel_...`,
`release_household_twilio_number`, `release_household_twilio_number_immediately`)
— was written and tested against the same bundled-transaction shape in
the same session, and has **not** been independently re-verified the
same way 016 now has. One of its four objects was directly confirmed
missing via a live call on 2026-07-21. Treat everything described in
this document from "Cancellation" onward as **designed and tested, but
not yet confirmed live** until 017 goes through the same repair.
Deliberately not repaired yet — tracked in `docs/launch/KNOWN_ISSUES.md`.

## Operational dependency: nothing runs the release on a schedule yet

`scripts/release-expired-twilio-numbers.js` finds every household past
its grace-period deadline and releases them, safely and idempotently
(every actual release still goes through the same row-locked RPC, so
running it twice, concurrently, or after a partial failure never
double-releases anything). **Nothing in this codebase invokes it
automatically.** There is no cron/job runner configured in this project
today. Before this matters in practice (i.e. before the first
cancellation's 30-day window elapses), this needs either:

- a Railway Cron Job (or equivalent) running
  `node scripts/release-expired-twilio-numbers.js` daily, or
- a manual run on the same cadence, until that's set up.

See `POST_LAUNCH_ROADMAP.md` for scheduling this alongside the other
post-launch items.
