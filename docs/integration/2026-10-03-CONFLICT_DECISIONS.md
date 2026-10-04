# Conflict decisions — Launch Fortress integration (2026-10-03)

Every substantial textual and semantic conflict, and how it was resolved. No
safety-critical conflict was resolved by taking "ours" or "theirs" wholesale.
`package.json` conflicts (the old one-line `&&` test chain) were resolved by an
ordered union at each merge and finally replaced by `scripts/run-all-tests.mjs`.

## Merge-time decisions

### M4 — fix/nonprod-telephony-mutation-guard
- package.json: test-line union.
- services/twilioProvisioning.js: HEAD (fraud) split ensure→purchaseTwilioNumber w/ abuse guard; incoming added env guard at top of purchase. Kept both: abuse admission + single-flight in ensure; env guard first in purchase. Renamed incoming local `guard` → `environmentGuard` (dep key `guard` kept) because `guard` is purchaseTwilioNumber's abuse-guard parameter (would be SyntaxError). Removed incoming's duplicate shouldAttemptProvisioning (already in ensure).
- tests/telephony-environment-isolation: invariant "exactly 2 .remove()" → "exactly 1 non-post-purchase remove + 2 post-purchase removes of purchased.sid" (fraud added provider-response-rejected cleanup, same safe class).
### M5 — fix/revenuecat-sandbox-environment-guard — clean.
### M6 — security/financial-containment-p0 (brings 30d454c + ledger 7ad12c9)
Conflicts: package.json, server.js (9 hunks), mediaStreamHandler.js (4), tests/subscription-enforcement-voice-gate (2).
- C6.1 Signature verdict: Fortress recomputed isGenuineTwilioRequest vs APP_URL; voice-p0 guard sets req.twilioVerified (alt-host aware). Kept ONE verdict = req.twilioVerified for /voice; isSignedTwilioRequest defers to it. Reason: with FC_REQUIRE_SIGNED_VOICE=true a genuine call on an allowlisted alternate host would be rejected by Fortress.
- C6.2 Financial port: abuse layer's financialAuthorizationPort contract (telephony reject only on kill switch; unavailable ⇒ allow) contradicts Fortress fail-closed. Port left UNWIRED (null); Fortress containment.authorizeCall is the single authority, called after abuse screening and before trust takes effect. Trust only sizes the reservation / decides monitoring.
- C6.3 Monitoring condition: monitoringDecision.monitor (Fortress reservation covers monitoring AND 056 allowance/ceilings) AND abuseDecision.monitor AND not duplicate.
- C6.4 All /voice responses (incl. 056/Fortress refusals) leave via sendVoiceTwiml (egress guard + replay cache). settleIfNoDial evaluated on FINAL post-egress xml (egress guard may replace <Dial> with <Reject>).
- C6.5 Callbacks (/call-delivery-failed, /call-status): duplicate → no side effects; verified → abuse lease release + 056 end + Fortress settle; unverified → nothing (sweeper settles from provider status). Previously fraud released abuse leases even for unverified.
- C6.6 Abuse concurrency leases released on 056/Fortress refusal and on no-Dial settle (else leaked 10 min).
- C6.7 Sweeper + env-gated lifecycle jobs: both kept.
- C6.8 Media stream server: abuse lease release on stream end + 056 metering/smsBudget.
- C6.9 SMS chain: guardSmsClient(incident gate, destination policy, per-hh count caps) → smsBudget (056 period ceiling) → containedSmsClient (Fortress £ auth per message). smsBudget's "sent anyway" on 056 DB error only runs after Fortress fail-closed authorisation.
- C6.10 Transcription: Fortress "no paid request until attached to reservation" AND voice-p0 per-household transcription cap.
- C6.11 POLICY: 056 household_burst contradicted abuse layer (household volume = flag only, no victim lockout). Burst now opt-in (default 0 = off) and never refuses trusted callers (SQL + in-memory fallback). 056 caller_flood aligned to abuse layer: 9/300s (was 6/600s) as cross-instance DB backstop.
- C6.12 BUG FIX: 056 fs_close_call never ended a monitoring session that never attached a stream → held household stream slot until staleness → next scam call could go unmonitored. Now ended with the call (reserved & no stream only).
- Tests: wiring test asserts single verdict + duplicate-before-settlement (stronger); callpath test injects trusting authoriser (voice-p0 fail-closed); /voice regex tolerates middleware; EARLY_RETURN updated; attacks + voice-surface harnesses route RPCs to real PGlite (056 + Fortress SQL) via tests/helpers/pgliteRestBridge.mjs with all synthetic households entitled + pinned budget.
- Verified pre-existing: migrations.pglite "051 contribution view" fails identically on untouched 30d454c (git archive).
### M7 — feature/customer-allowance
- package.json union; server.js imports union (containment + allowance).
- routes/mobileApi.js RevenueCat grant: kept guard's sandbox skip of Twilio provisioning AND allowance's production-only plan sync. resolveEventEnvironment now delegates to the guard's resolveEventIsSandbox (single definition, fail-closed).
### M8 — feature/customer-identity-carrier-abstraction
- package.json union only.
- Semantic: customer-identity.pglite forge scenario inserted households as `authenticated` naming account_number; security 059 (staging-applied) restricts authenticated INSERT to (auth_user_id, email, status) → permission denied. Test now proves both layers separately (grant refusal; trigger overwrite from a privileged role).
### M9 — feature/number-lifecycle-sweep
- server.js imports: union; RESTORED `buildWebhookUrl, isGenuineTwilioRequest` import — voice-p0 had dropped it, Fortress still calls both (isSignedTwilioRequest fallback, /webhooks/provider-usage-alert) → latent ReferenceError in the M6 tree. Found by eslint no-undef (scratchpad tool); now lint-clean.
- twilioProvisioning.releaseQuarantinedTwilioNumber: both pre-release guards, env guard first (no provider call in mixed env), then 047 entitlement re-read (fail closed).
- tests/migrations.pglite: both appended sections kept.
- Semantic: sweep scheduler was gated only by ENABLE_NUMBER_LIFECYCLE_SWEEP_SCHEDULE; now also requires numberLifecycleJobsDecision.run (env guard). Scheduler source test updated to the stricter condition.
- telephony-environment-isolation "production release" test injects blocksRelease:false (isolates env guard; 047 check fails closed against unreachable DB, correctly).
- Pre-existing on main (not touched): duplicate export key setHouseholdCarrierCompatibility in database/households.js.
### M10 — release/ios-1.0.2 (call-delivery / android readiness / ios parity / forwarding fix / channel pricing)
- server.js imports: union. Its requestSignedByTwilio (APP_URL-only recompute) now defers to isSignedTwilioRequest (single verdict).
- /voice: HEAD (guarded route). DUPLICATE client-origin guard collapsed to one: isVoiceSdkClientOriginated (From OR Caller, case-insensitive, trimmed) — strictly broader than fraud's inline From check; abuse layer step 1 kept as defence in depth; reply via sendVoiceTwiml.
- Dial: Fortress dialOptions(timeLimit) + routing telemetry; telemetry `monitoring` = actual decision (financial ∧ abuse ∧ !duplicate), was "entitled".
- /call-delivery-failed: delivery fallback response via sendVoiceTwiml; duration/evidence write + delivery-failed alert now verified-only (same rule as settlement). /call-status evidence write verified-only.
- Voicemail prototype route (non-prod only; <Record> ≤60 s) was UNAUTHENTICATED → now behind signature guard + integrity, reply via sendVoiceTwiml.
- Startup: env-gated lifecycle jobs (HEAD) + push-failure polling (theirs; off unless DELIVERY_PUSH_FAILURE_POLLING=on). Theirs' ungated release-check start dropped (superseded by env gate).
- Migrations: 060_call_delivery_events → 064, 061_household_iphone_carrier → 065 (+ rollbacks, headers, test paths, code comments).
- Tests updated to integrated forms (client-origin predicate; voicemail route guard; dial signature with dialOptions; telemetry decision; /voice guarded route anchor; Dial includes timeLimit).
### M11 — feature/admin-control-centre-v2
- package.json union; server.js route imports/mounts union (delivery timeline + business control + classification); migrations test sections union.
- Migration 055_account_classification_history → 069 (+rollback, headers, service/route/html comments, workflow test, migrations-test section labels). Delivery evidence keeps 055.
- usage-safety "fails by design" resolved truthfully: call_length reports "code present — verify" when containment module exists (never "enforced"); new rows financial_reservation, global_breaker, abuse_screening; test asserts every limit module present and none claimed enforced by the dashboard.

## Post-merge integration decisions (with commits)

| # | Decision | Why | Commit |
|---|---|---|---|
| P1 | Media-stream entry `toNumber`/`fromNumber` come from the server-side stream authorisation, never `customParameters` | Re-introduced by the Fortress merge (056 fields predated voice-p0 stream tokens); launch-gate PR-02 | ddb756e |
| P2 | `normaliseNumber` is country-aware (UK keeps legacy 10-digit key; international keeps full E.164) | Every remaining user (To routing, rapid-abuse alerts, contact dedupe, legacy /process) was still tail-collidable; PR-03 | ddb756e |
| P3 | `normaliseUkPhoneToE164` applies the HOUSEHOLD_PHONE destination policy | Its only purpose is a household destination; 09/084/087/070/076/07624/03 now refused at both layers; PR-04 | ddb756e |
| P4 | Purchase succeeds but assign throws → re-read: committed ⇒ success; confirmed unassigned ⇒ release; unreadable ⇒ keep (tagged) + critical alert | Releasing a number whose assignment may have committed can kill a live customer's forwarding target (total call loss). The judge's PR-07 stays FAIL for the DB-unreadable branch — deliberate | ddb756e |
| P5 | Inbound household lookup: indexed `.in()` over storage variants; ambiguous ⇒ null; miss ⇒ paginated safety-net scan + negative cache | Full-table select was capped at 1000 rows (silent call loss at scale); PR-09 | ddb756e |
| P6 | Unauthenticated auth endpoints rate-limited (per-mailbox suppress/429, no per-email on /login, global ceilings, per-IP only with TRUST_PROXY_HOPS) | Email bombing, mass sign-up, credential stuffing; a per-IP limit behind Railway's proxy would become global. Probe PR-11's static grep does not recognise the identifier — not renamed to game it | c7cee81 |
| P7 | Provisional schemas numbered 066/067; 066 search_path '' + service_role grants + validate-before-divide | Repo grants check; correctness | d699886 |
| P8 | Paid profiles' delivery reserve scope `trusted_only` (was `all`); £ unchanged | An unknown-caller flood drained the reserve and then locked out trusted callers. **Decision flagged for Andrew** (reversible via audited fc_set_budget_profile) | d699886 |
| P9 | Migration 068: every allowance credit moves the same £ capacity Fortress enforces, atomically; £ truncated to 4 dp; margin cap at credit time | Top-ups in minutes were capacity Fortress never funded | d699886 |
| P10 | Fortress kill switch / latched breaker feed abuse incident mode (full_stop); abuse financial port stays unwired | One incident picture; one financial authority (the port's fail-open contract contradicts Fortress) | 0208fc5 |
| P11 | Abuse concurrency check-and-claim made atomic within the process | 10 simultaneous calls from one caller all read the same count (found by the integrated suite) | 0208fc5 |
| P12 | `trusted` (skip monitoring) separated from `deliveryTrusted` (eligible for trusted-only reserve / 056 unknown-only blocks) | A spoofed flood suspended trust and so locked real trusted callers out of the reserve kept for them (found by the integrated suite) | 0208fc5 |
| P13 | Migration 070 + RevenueCat rules: one canonical entitlement decision | Stale active rows blocked Stripe; complimentary→Stripe customers lost access when the free grant ended; Apple grants expired paying Stripe customers; replay/out-of-order could shorten access; sandbox could supersede complimentary/App Review | fe2026d |
| P14 | Sandbox (053 environment) entitlement → unfunded `sandbox` Fortress profile | A sandbox purchase is not payment | fe2026d |
| P15 | Customer allowance defaults to the Fortress £ source; `trustedCallersContinue` + scope-honest copy | With a trusted-only reserve, "calls continue" would have been false | 155c966 |
| P16 | Commercial config validator (reports; decides nothing) + read-only admin overview | §9/§10/§15; dashboard ≠ enforcement stated in the payload | 155c966 |
| P17 | Removed a stray copy of the RevenueCat block from `grantComplimentaryEntitlement` | My own unbounded replace injected it (ReferenceError on extending a complimentary grant); caught by the full suite; all changed files audited for duplicates | 438082d |
| P18 | 051 contribution-view test made date-independent | Pre-existing time bomb (failed once "now" reached October, also on base) — currencies were never mixed | 599b232 |

## 2026-10-04 decisions (Andrew-approved) and implementation choices

| # | Decision / choice | Why | Commit |
|---|---|---|---|
| P19 | D3 = reject default; bounded only test/development with explicit opt-in; production assert at boot | fail closed | eac6c40 |
| P20 | Breaker latching and live-call termination made non-negotiable (CHECK constraints); admin reset route with authenticated actor | decision 1 | (this commit) |
| P21 | Per-household hold lives INSIDE the Fortress SQL (one authority, cross-instance, under the same lock), not in the process-local abuse store; the abuse store now reads/writes it | decision 2; unbypassable | (this commit) |
| P22 | Refused hold release returns `{ok:false}` instead of raising, so the refused attempt stays audited (raising rolled the audit row back) | auditability | (this commit) |
| P23 | Automatic fraud hold only for repeated number provisioning; softer multi-account signals stay provisioning-only | avoid locking out families — **policy for Andrew** | (this commit) |
| P24 | Fail-safe destination cost ceiling per purpose; unknown rate ⇒ refused; provider-metadata port (unwired) | decision 3 | (this commit) |
| P25 | Trusted-contact creation validated by `isValidContactNumber` (all write paths); international / Crown Dependency still allowed as caller-ID matchers — **policy for Andrew** | decisions 3–4 | (this commit) |
| P26 | Real-PG storm assertion: a refusal may now be `household_hold` for the household that test step 6 automatically held (undercount) | new control firing correctly | (this commit) |
