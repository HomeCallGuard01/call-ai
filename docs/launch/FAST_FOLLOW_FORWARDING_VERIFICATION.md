Document: Fast-Follow — Restore Proactive Carrier-Forwarding Verification
Status: Deferred (Option C) — not part of the canonical release candidate
Decided: 2026-09-13, during the canonical-release-base reconciliation
Related: docs/operations (staging branch integration/mobile-app-onboarding,
commit 44ce81e), release-lineage reconciliation analysis (same date)

---

# Title

Restore proactive carrier-forwarding verification

# Problem

The canonical RC can confirm Voice SDK/client delivery
(`voice_client_registered_at`, `deliveryReady`) and can eventually infer
that carrier forwarding is working from a real inbound call
(`delivery_verified_at`, `activation_verified_at`) — but it no longer has
staging's proactive outbound verification mechanism, which immediately
proves carrier-side forwarding is actually enabled, without waiting for
an organic real call or asking the customer to place one manually.

This mechanism existed and was under active, physically-tested
development on `integration/mobile-app-onboarding` (staging's branch) as
recently as its own most recent commit (`44ce81e`, 2026-08-31), but that
branch diverged from the lineage PR #24/PR #37 and the canonical RC are
built on before the two were ever reconciled. Nobody deliberately chose
to drop it — the branches simply never merged. See the full read-only
review from this session (2026-09-13) for the complete analysis.

# Why it matters

Three genuinely complementary signals, not duplicates:

- `voice_client_registered_at` / `deliveryReady` — proves the app/Voice
  SDK client is currently reachable. Says nothing about carrier
  forwarding.
- `forwarding_verified_at` (the mechanism this item is about) — proves
  the **first hop**: customer's phone number → HCG's Twilio number.
  Established either proactively (an automated outbound test call placed
  by HCG, round-tripping back through the customer's own carrier
  forward) or passively (any genuine real call reaching `/voice` at all).
- `delivery_verified_at` — proves the **second hop**: HCG's Twilio
  number → the household's registered Voice SDK client, via real Twilio
  evidence (`DialCallStatus === "completed"`) that an approved call
  actually connected.

A household can genuinely have one without the other. The proactive
half of `forwarding_verified_at` (the outbound test call) is the only
one of the three that can confirm anything **before** a real customer
call ever happens — everything else in the canonical RC today is
retrospective.

# Retain for future work

The following were reviewed read-only (2026-09-13) and found safe,
well-engineered, and genuinely isolated from call-delivery routing — no
interference with PR #24's self-protecting architecture or PR #37's
reachability fix, no PSTN dial-back, no loop risk (the outbound
verification call hangs up unconditionally on recognition, never
re-dials). Source: `integration/mobile-app-onboarding` @ `44ce81e`.

- `services/forwardingVerification.js` — the full mechanism: TTL'd
  verification-state checks, the atomic claim, the outbound Twilio call.
- The `forwarding_verified_at` concept (migration
  `031_household_forwarding_verification.sql` on that branch's own
  numbering — will need a fresh number on the canonical RC, e.g. the
  next free one after 039).
- The dedicated, shared verification caller-ID number
  (`VERIFICATION_CALLER_ID_NUMBER`) — already purchased and configured
  on staging (`+442046521883`), confirmed live this session.
- The atomic claim RPC
  (`claim_household_forwarding_verification_attempt`) — race-free
  against double-taps/two devices via a single `UPDATE ... WHERE`, no
  application-level mutex needed.
- Passive refresh on any genuine inbound call reaching `/voice`
  (`mark_household_forwarding_verified`, called both on a recognised
  verification return-call and on any ordinary real call).
- Return-call detection running **before** normal Known/Unknown routing
  in `/voice` (`isVerificationReturnCall`) — three independent facts
  (caller ID, pending attempt, not timed out) must all agree; a stale or
  spoofed caller ID alone can never fabricate a false "verified" state.
- `tests/forwarding-verification.test.mjs`.

# Future design question

Define exactly how `forwarding_verified_at` composes with
`delivery_verified_at`, `deliveryReady`, and `fullyProtected` in the
canonical protection-status model
(`services/callRouting.js`'s `computeProtectionStatus`,
`mobile/lib/homeStatus.ts`'s `isProtectionActive`/`fullyProtected`).

Staging's own model (`voiceClientReachable && forwardingVerified`) is
**not** simply portable — the canonical RC's model
(`endToEndDeliveryVerified && deliveryReady`) is a different shape, and
reconciling them is a genuine product decision (does "Protected" require
all of forwarding-verified, delivery-verified, and currently-reachable?
does forwarding-verified become a faster intermediate "Setting up,
forwarding confirmed" state rather than gating "Protected" itself?),
not a mechanical merge.

# Explicitly out of scope for this item

Do not port or merge this feature into `integration/canonical-release-base`
as part of the current release candidate. This document exists so the
mechanism is not silently lost, not to schedule it.
