Document: Known Issues — Pre-Launch
Version: 3.8
Last Updated: 2026-08-22
Status: Active
Owner: Andrew Deane
Related Sprint(s): Launch Polish Sprint (post Sprint 9, unnumbered) — see FINAL_ACCEPTANCE_REPORT.md for full evidence. Severity 1 grant issue found and resolved-on-staging during migration-recovery/staging work — see docs/engineering/MIGRATION_RECOVERY_PLAN.md. Production fix still pending as a separate controlled change.

---

# Known Issues — Pre-Launch

Ordered by severity. Full evidence and reasoning for each is in
`FINAL_ACCEPTANCE_REPORT.md`; this file is the short, scannable list.

## Resolved this sprint

### ~~ICO registration~~ — confirmed complete (2026-08-17)

AFMD Ltd's registration with the Information Commissioner's Office is
now confirmed complete. Checked the public-facing site (`public/privacy.html`,
`public/terms.html`) and all other public-facing pages for wording
describing ICO registration as pending or not yet completed — found
none; the only ICO reference on the site is the standard "you may
complain to the ICO" regulator-contact boilerplate in `privacy.html`
§11, which is correct as written and needed no change regardless of our
own registration status. No documentation update was required beyond
this entry.

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

### ~~Forgot Password / reset-password deep link opens an invalid URL~~ — code fix resolved and pushed (2026-08-18), physical-device re-test still pending

Was Severity 2, found during Android same-phone Voice SDK testing
(2026-08-16 — full original detail in
`docs/operations/HANDOVER_2026-08-15.md` §20.7).

**Previous symptom:** on the physical mobile device, tapping the
password-reset email could produce "Safari cannot open the page because
the address is invalid."

**Root cause:** the mobile app used `homecallguard://reset-password`
directly as Supabase's `redirectTo` for password-reset emails — the
app's own custom URI scheme. That depends on the installed app/custom
scheme being available and recognised on whichever device the email
link is opened on; opening it anywhere else (e.g. Mail/Safari on a Mac,
a different device, the app not installed) produces the invalid-address
error. The web flow was never affected — it already used an HTTPS
redirect (`public/reset-password.html`) and never depended on the
custom scheme.

**Fix:** the mobile app's `redirectTo` now points at that same
`public/reset-password.html` HTTPS page instead of the raw custom
scheme. That page attempts an app handoff first (a safe no-op
everywhere the app isn't installed) and provides a working browser
fallback for completing the password reset if the handoff doesn't
happen.

- Main commit: `58c1d54`
- Mobile branch (`sandbox/mobile-app-v1`) commit: `3f8ba90`

Automated/local verification passed: `tsc --noEmit` clean; local
backend `POST /forgot-password` against the real staging test account
returned successfully with no Supabase error logged; `reset-password.html`
and its inline JS confirmed served and syntactically correct;
`EXPO_PUBLIC_API_BASE_URL` interpolation confirmed to resolve to a
valid URL for staging. **This resolves the code defect. A final
physical-device regression test — opening a real reset email on an
actual phone and confirming the full flow end to end — remains
desirable before this is called fully launch-verified, and has not yet
been performed.**

### Help → "Set up call forwarding" added as first Help item — implemented (2026-08-18)

Closes the open item logged in
`docs/operations/HANDOVER_2026-08-15.md` §20.7 ("Help screen
improvement requested, not yet implemented"), and separately addresses
the related "obvious return path after the dialler opens" item from the
same section.

"Set up call forwarding" is now the first Help option in the mobile
app, above "Email support". It reuses the existing
`GET /api/v1/activation/instructions` endpoint and the persisted
activation-device record (the same pattern already used by the Account
tab's "Need to turn off protection?" screen) to display the customer's
actual forwarding instructions/code — no new backend endpoint or second
source of truth. Mobile (iPhone/Android) customers get a button that
opens the Phone app with the code pre-filled; landline customers get
plain written instructions. Every path ends with an explicit
instruction telling the customer how to return to Home Call Guard
afterwards.

- Mobile branch (`sandbox/mobile-app-v1`) commit: `3f8ba90`

Local/Expo verification passed: `tsc --noEmit` clean; the Expo web
bundler (`expo start --web`) bundled the full route tree with no
errors and served the new screen and its parent Help screen
successfully. **A final physical-device regression test remains
pending.**

### ~~Android incoming call: silent ringtone, and the incoming-call screen wasn't persistently answerable~~ — RESOLVED, physical device verified (2026-08-20)

Was Severity 2. Full root-cause trail and the reviewed native patch diff are
in `docs/operations/HANDOVER_2026-08-15.md` §20.6. Two separate defects,
found and fixed in sequence during renewed Android same-phone Voice SDK
testing this session, both now verified end-to-end on the physical Moto E7
with the exact built/installed APK confirmed by SHA-256 match between the
EAS artifact and the binary pulled back off the device.

**Defect 1 — silent ringtone.** Twilio's Android `AudioSwitch` library
(`com.twilio:audioswitch` 1.2.2) defaults to Earpiece over Speakerphone
when nothing is plugged in — confirmed directly against that library's
source. The incoming-call ringtone plays through whichever device
`AudioSwitch` currently has selected, so on a bare phone it played out of
the earpiece: technically ringing, inaudible in normal use. Fixed
JS-only, no native rebuild: `mobile/lib/voiceClient.ts` now explicitly
selects the Speaker device (`voice.getAudioDevices()` /
`AudioDevice.select()`) once, immediately after a successful
`voice.register()`, well before any call can arrive.

**Defect 2 — incoming-call UI not persistently answerable.** The
2026-08-16 patch (below) had removed `.setFullScreenIntent()` entirely
to fix a silent-auto-accept bug, but that also removed the only
mechanism keeping the incoming-call notification visible/answerable for
the whole ~55s ring window — without it, the notification is only ever
shown as a normal heads-up banner, which Android's own SystemUI
(`HeadsUpManagerPhone`) auto-collapses after ~5-6 seconds regardless of
app. A slow-to-answer test exposed this directly: the box visibly
disappeared and there was no obvious way to answer. Root cause of the
*original* 2026-08-16 bug was re-examined and found to be narrower than
first diagnosed: Android auto-launching a full-screen intent without a
real tap is expected, correct behaviour on this Android 10 device, not a
platform bug — the actual defect was the app's own code treating that
auto-launch as equivalent to a genuine user tap, silently stopping the
ringer either way. Fixed with a second, narrowly-scoped native patch:
`setFullScreenIntent()` is restored, but now points at its own distinct
action (`ACTION_FULL_SCREEN_INCOMING_CALL_DISPLAY`, new) that is
deliberately never handled by `VoiceService.onStartCommand()` — so
Android auto-launching the full-screen surface can no longer silence or
deprioritize the ringer, while a genuine manual tap on the notification
(unchanged action/path) still correctly does.

**A separate, real crash was also found and fixed along the way** (not
present in the final passing test, but real and reachable): an OEM
duplicate `ACTION_ACCEPT_CALL` intent delivery (`VoiceActivityProxy`
forwards any intent unconditionally, no de-duplication) could cause a
second, illegitimate `.accept()` call on an already-consumed
`CallInvite`; the resulting `onConnectFailure` callback then removed the
shared `CallRecord` entirely, causing the genuine `onConnected` callback
to crash with `NullPointerException` moments later
(`CallListenerProxy.java`). This is a confirmed, still-open upstream SDK
issue (`twilio/twilio-voice-react-native#581`), with a community fix
(`#687`) Twilio closed without merging. Hardened with a narrow patch
mirroring that community fix: `onConnectFailure`, `onRinging`,
`onConnected`, `onReconnecting`, `onReconnected`, and `onDisconnected`
in `CallListenerProxy.java` now null-check-and-return instead of
crashing when their `CallRecord` lookup is empty.

All three fixes ship as one combined `patch-package` patch against
`@twilio/voice-react-native-sdk@2.0.0-preview.2`
(`mobile/patches/@twilio+voice-react-native-sdk+2.0.0-preview.2.patch`)
plus the one JS-only speaker-selection change — required a native
rebuild (patch-package changes only take effect in a new EAS build).

**Final physical-device verification (2026-08-20), one isolated staging
call, `CA74f17126320559083c9e8a95cf00c41a`:**
- FCM registration and `CallInvite` delivery confirmed (`incomingCall:` logged at ring start).
- Audible ringtone confirmed (Speaker device selected before any call could arrive).
- Incoming-call UI stayed visible/answerable for ~14.5 seconds before answer — comfortably past the ~5-6s heads-up-collapse window that broke the previous attempt.
- Manual `acceptCall` logged exactly once — no duplicate accept.
- `onConnected` logged cleanly — no `FATAL EXCEPTION`, no `NullPointerException`, no "no CallRecord found" warning anywhere in the capture.
- Twilio's own call record: `status: "completed"`, 5s duration — not `no-answer`, not `failed`.

**Do not** re-open this without re-verifying on a physical device — this
status reflects a real answered call with connected audio, not a
simulator or a partial/auto-accepted test.

### ~~Unknown-caller pre-call screening replaced with live in-call monitoring~~ — implemented and physically verified on staging (2026-08-20)

**Product decision:** for a trusted/known contact, nothing changes — the
existing bypass still connects the call immediately with no monitoring
of any kind (unaffected by this change). For an unknown/non-contact
caller, the previous pre-call interaction (`<Gather>`-collected speech,
"please briefly state your reason for calling", then an OpenAI SCAM/SAFE
classification of that one sentence before deciding whether to connect)
is removed from the live route. It's replaced by one fixed announcement,
then the call connects immediately — the protection mechanism for an
unknown caller is now the live in-call monitoring/risk-scoring system,
running for the whole duration of the call, not a one-shot pre-connect
judgement of the caller's opening sentence.

**Code:** `server.js`, commit `bc1f8d0` ("Simplify unknown-caller flow to
live monitoring"). `/voice`'s unknown-caller branch now: logs the call →
says exactly *"This number is monitored and protected by Home Call
Guard."* → `attachLiveMonitoring(...)` → `dialHouseholdOrFailClosed(...)`.
Full before/after trace, file-by-file, is in the commit itself and this
session's own investigation; not repeated here.

**`/process` (the old `<Gather>` + OpenAI classifier) is dormant, not
deleted — rollback code only, not active.** `/voice` no longer contains
a `<Gather action="/process">`, so Twilio never reaches it for a real
call. Reverting is a one-line change (re-adding that `<Gather>`), not
git archaeology. Confirmed by a structural test
(`tests/live-monitoring-scenarios.test.mjs`) that parses `server.js`
itself to assert exactly this — that test suite passes in full (717
checks, 0 failures) as of this change.

**Physically verified on the real staging number** (`+441302490922`),
one real inbound PSTN call, call SID `CA54240a55f17fd50e8ddb03bb44827a91`,
2026-08-20 21:02:38–21:02:57 UTC (19s), with the actual `bc1f8d0` code
running (confirmed on disk and via the live process, not assumed):

- The caller (Andrew Deane) personally heard the new announcement,
  *"This number is monitored and protected by Home Call Guard."*, verbatim.
- No `<Gather>`/speech collection and no `/process` round-trip occurred —
  confirmed both statically (the live route contains neither) and
  behaviourally (no `SpeechResult` callback anywhere in the call's
  lifecycle).
- Live monitoring started before/alongside the customer connection:
  `media_stream_started` logged at 21:02:42.677, `attachLiveMonitoring`'s
  `<Start><Stream>` executes (non-blocking) immediately after the
  announcement and before `<Dial>`, per the code's own fixed order.
- Media stream connected and transcribed live: 6 transcript chunks
  logged (21:02:48.924–21:02:57.125), ordinary benign conversation.
- The protected customer leg connected: Twilio's own child-call record
  shows `+447769939682` dialled, `status: completed`, 12s duration.
- Peak risk score: 0 (`peakRiskScore: 0` at `media_stream_stopped`).
- No SMS warning sent (`warningSent: false`).
- No system termination (`terminatedBySystem: false`) — nothing crossed
  the red-line threshold, correctly, since the call was entirely benign.
- Zero Twilio notifications/errors for this call SID
  (`notifications.list()` returned empty) and zero backend/media-stream
  errors in the log.
- The call completed normally: parent call `status: "completed"`.

(A first attempt at this same test, earlier the same day, failed with
"Application error" — root-caused to a `502` from the local dev
backend's ngrok tunnel, since the process behind it had been stopped for
an unrelated reason; not a defect in this change, and resolved by
restarting that process before the successful test above.)

**Two items intentionally not resolved by this change, flagged
separately below:** the `result: "SAFE"` data-model semantics for a
newly-unscreened call, and the Privacy Policy's now-inaccurate
description of pre-call classification (see Severity 2, below).

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

### New unscreened monitored calls log `result: "SAFE"` without any classification having occurred

Introduced by the unknown-caller flow change above (`bc1f8d0`), and
deliberately not fixed as part of it — flagged there, recorded properly
here. The `calls` table's `result` column is
`text not null check (result in ('SAFE', 'SCAM'))` — no third value
exists for "unscreened, connected under live monitoring only". Every
unknown call connected via the new route logs `result: "SAFE"` and
`aiModel: null`. `SAFE` is true of the actual outcome (the call was
connected, not blocked) but no longer means what it meant when the old
classifier wrote that same value — it does **not** mean an AI judged the
caller safe. `aiModel: null` makes "no AI model was involved" explicit
on the same row, which is the most that's representable without a schema
change. Downstream effect: the dashboard's `describeCall` "We blocked a
suspected scam call" copy (for `result: "SCAM"`) becomes historical-only
— no code path can produce a new `SCAM` row anymore, since live
monitoring's `recordMonitoringOutcome` deliberately never writes
`result` (only `risk_score`/`decision_reason`/`warning_sent`/
`terminated_by_system`/`termination_reason`). Not fixed here — a real
fix (a third `result` value such as `'UNSCREENED'`, or a separate
boolean/text `screened` column) is a schema decision for product/
engineering to make deliberately, not something to bolt on implicitly.

### Privacy Policy describes an obsolete pre-call classification step, and doesn't describe live in-call monitoring at all

Also surfaced by the unknown-caller flow change (`bc1f8d0`), not fixed as
part of it. `public/privacy.html` §2 ("Call and screening records")
currently states: *"Where our AI classification step is used, the
caller's spoken words are converted to text and analysed at the time of
the call to help classify it."* This describes exactly the `/process`
mechanism that is no longer reachable from the live route (see above) —
as written, it now describes a data-processing activity that doesn't
happen, which is a real UK GDPR transparency-notice accuracy problem,
not just stale copy.

Separately, and more significant: **there is no existing disclosure
anywhere in `privacy.html` or `terms.html` of the live in-call audio
monitoring/transcription/risk-scoring** that already runs today for
unknown callers (previously only SAFE-classified ones; now all of them,
per the change above) — this is now the *sole* protection mechanism for
an unknown caller, not an edge case. The new spoken announcement (*"This
number is monitored and protected by Home Call Guard"*) is a good
practice and, if anything, an improvement in disclosure timing over the
old wording (it now precedes any monitoring, rather than following it) —
but a brief on-call announcement alone is unlikely to fully satisfy
written transparency-notice obligations on its own. Needs updated
privacy-policy wording describing what actually happens now. Recommend
routing through the same UK consumer-law/solicitor review as the Terms
entry above, rather than drafting this wording unilaterally — flagging
it as the next required launch change, not deciding the wording here.

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

### Apple Developer Program enrollment blocked — Account Holder surname

iOS build work cannot start until this clears (see the iOS pre-flight
checklist, `docs/operations/HANDOVER_2026-08-15.md` §21, item 1).
Enrollment is currently blocked pending correction of the Account
Holder's surname on the Apple ID/Developer account. **Action needed:**
correct the surname with Apple before attempting enrollment again; if
enrolling as AFMD Ltd (organization) rather than an individual, also
check the D-U-N-S number lookup first (`developer.apple.com/enroll/duns-lookup/`),
since that can independently add lead time.

### ~~Password reveal control uses novelty emoji~~ — fixed

Was present in `public/register.html`, `public/login.html`, and
`public/reset-password.html`: each password field's visibility toggle
rendered as an 👁 (eye) / 🙈 (monkey-covering-eyes) emoji pair. Replaced
in all three files with a conventional inline eye / eye-slash SVG icon
(no emoji), toggled via `btn.innerHTML` in place of the old
`btn.textContent` swap — the existing `aria-label` toggle logic
("Show password" / "Hide password", correctly dynamic already) was
otherwise unchanged. The mobile app has no equivalent reveal control on
any password field today; any one added later should follow this same
icon convention.

## Business account audit checklist (pre-launch)

Not yet performed as a deliberate, single pass — added here as a
short, explicit checklist rather than assumed covered by any of the
items above. For each account below, confirm: **legal/billing entity**
(is it AFMD Ltd, or a personal account that should be migrated?),
**payment method on file**, **invoice email address**, and **account
owner** (whose login/2FA controls it). None of these have been
deliberately re-confirmed in one pass; several were set up early in the
project and may still reflect placeholder or personal details.

- [ ] **Stripe** — legal/billing entity, payment method, invoice email, owner
- [ ] **Twilio** — legal/billing entity, payment method, invoice email, owner
  (note: the same Twilio account is shared across staging and production
  configuration in this repo — there is no separate staging subaccount,
  so this is a single audit, not two)
- [ ] **OpenAI** — legal/billing entity, payment method, invoice email, owner
- [ ] **Railway** — legal/billing entity, payment method, invoice email, owner
- [ ] **Supabase** — legal/billing entity, payment method, invoice email, owner
  (both the production project `psbzynxplxfbyrbdidmn` and staging project
  `tigwgmayeuisrxjjykqd`)
- [ ] **Resend** — legal/billing entity, payment method, invoice email, owner
- [ ] **IONOS** — legal/billing entity, payment method, invoice email, owner

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
