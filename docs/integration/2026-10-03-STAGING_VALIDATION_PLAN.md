# Staging validation plan — Launch Fortress candidate (PLAN ONLY — NOT EXECUTED)

Nothing in this document has been run. Every step needs Andrew's explicit go-ahead.
Staging = Supabase `tigwgmayeuisrxjjykqd`. **Staging currently uses the production Twilio
account** (number-inventory memory) — every telephony step below must use the
non-production provisioning guard and dedicated test numbers only, and must never release
or reconfigure a production number.

## 0. Preconditions (stop if any is false)

1. Decisions recorded: D3 = reject and latching breaker (decided 2026-10-04); D9 floors, reserve scope, automatic-hold threshold, placeholder £ budgets for staging only.
2. Staging DB snapshot/backup taken and its restore tested (Supabase PITR or `pg_dump` of `public` + `auth.users`).
3. Staging history repair for 052 decided (`supabase migration repair --status applied 052`, Andrew).
4. Branch deployed to a **staging-only** Railway service; `NODE_ENV` and the environment-guard signature say non-production.

## 1. Rollback conditions (abort and restore if any occurs)

Any genuine signed call rejected; `fc_check_invariants()` not ok; any provider mutation on a
production number; any unexpected Twilio spend (usage trigger); `/voice` p95 > 2 s; any
migration error.

## 2. Migration sequence (staging)

Staging has 046, 047, 051, 057–061 (+052 objects). Apply with `--include-all` (or per file with history rows), in order:
`053 → 054 → 055 → 056 → 062 → 063 → 064 → 065 → 066 → 067 → 068 → 069 → 070`.
After each: grants check (`scripts/verify-table-grants.js`), and after 067: `select public.fc_check_invariants();`.
Rollback order: strictly reverse, using `_rollbacks/`; **067 only with the kill switch on and no live calls**; 062/063 never after customer-visible data.

## 3. Staging-only configuration

`FC_REQUIRE_SIGNED_VOICE=true`, `TWILIO_WEBHOOK_AUTH_MODE` unset (enforce), `TWILIO_WEBHOOK_ALLOWED_HOSTS` = staging hosts,
`FC_DEGRADED_MODE` unset (D3 = reject; bounded is refused outside test/development), `ALLOWANCE_SOURCE=fortress`, `ALLOWANCE_TOPUPS_ENABLED` off until §9,
`APP_ENV=staging`, `ALLOWANCE_ALLOW_SANDBOX_CREDITS=true` only for §9, `ENABLE_NUMBER_LIFECYCLE_SWEEP_SCHEDULE` unset,
`TRUST_PROXY_HOPS` = Railway's verified hop count, `ABUSE_AUDIT_HASH_SECRET` set, `TWILIO_ACCOUNT_SID` set.
Staging budget profiles set with `fc_set_budget_profile` (audited) to small test values.

## 4. Webhook / signature validation

Real signed `/voice` from a test number: 200 + `<Dial timeLimit>`; same request replayed: identical TwiML, one `fc_reservations` row;
unsigned POST: 403; alternate-host Voice URL (if any): accepted by the guard **and** by Fortress (single verdict).
Evidence: request/response pairs, `fc_reservations` rows, logs.

## 5. Real handset tests (Motorola continuation per `~/hcg-staging-handset-test/README.md`)

Trusted call (no stream, bypass), unknown call (announcement + stream + transcription), caller hangs up during announcement
(monitoring slot freed — 056 fix), failed delivery (apology; settled). Evidence: screen recording, Twilio call logs, DB rows.

## 6. Containment

1. Budget exhaustion mid-call: `fc_admin_adjust` negative on the test household → parent call ended at lease end; Twilio shows all legs ended; `overrun_gbp` recorded.
2. Kill switch → live calls end within one lease; new calls `<Reject>`; incident mode shows full_stop; reset audited.
3. Breaker: lower `global_hourly_floor_gbp` → storm of short calls → latch; reset via `fc_reset_breaker`.
4. Two instances sweeping the same leases: each renewed exactly once.
5. `timeLimit` semantics: billed parent duration vs timeLimit.
Pass: no call outlives its paid lease + 60 s grace + sweep interval; Σ committed ≤ budget + reported overrun.

## 7. Concurrency

10 simultaneous calls (call generator to a test number) on a nearly exhausted test budget: Σ reserved ≤ headroom.
Account-number race: two `psql` sessions × 50 sign-ups → distinct numbers. Routing race: same number for two households → one success.

## 8. Abuse

Burst from one handset (>8/5 min) → cooldown; trusted CLI during a flood still delivered (reserve); loop attempt via a second test number → `<Reject>`.

## 9. Billing

Stripe **test mode**: subscribe, renew, cancel, duplicate event, top-up (one product), refund → £ reversed; complimentary → Stripe conversion keeps access.
RevenueCat **sandbox**: purchase → entitlement with `revenuecat_environment='sandbox'`, no number provisioned, `fc_resolve_profile` = `sandbox`;
replayed and out-of-order events; sandbox purchase on a complimentary account leaves it complimentary.

## 10. Number provisioning failure paths (non-production guard only)

Double-click purchase → one; simulated assign failure → re-read → release; DB unreadable → kept + alert; adoption on retry.

## 11. Evidence to capture

Date, operator, environment, commit SHA, every request/response, DB rows before/after, Twilio call SIDs and durations, Twilio usage,
alerts received. Record each M-01…M-17 result in `docs/launch-gate/` so the registry can be promoted honestly.

## 12. Restore

Kill switch on → stop staging service → restore snapshot (or reverse rollbacks 070→053) → verify `schema_migrations` → restart previous staging build.

## 13. Added 2026-10-04 — kill switches, destinations, provider containment

1. Household hold via the admin route on a test household during a live call → that call ends at
   lease end; new calls (trusted and unknown), SMS and a number purchase all refused; release via
   the admin route; audit rows present (incl. a refused automatic release).
2. Breaker: trip with a lowered hourly floor; restore the floor; confirm calls are STILL refused;
   reset via the admin route (authenticated admin) and confirm resumption and the audit row.
3. Automatic hold: lower `household_auto_hold_daily_gbp` on staging; generate calls; confirm the hold.
4. Try adding 09/087/070/076 trusted contacts from web and app — refused server-side.
5. Provider LEVEL 4: complete `2026-10-04-PROVIDER_FINANCIAL_CONTAINMENT.md` §3 with dated evidence
   and the written Twilio answers (§4) — no provider change is made as part of the plan without
   Andrew's explicit instruction.
