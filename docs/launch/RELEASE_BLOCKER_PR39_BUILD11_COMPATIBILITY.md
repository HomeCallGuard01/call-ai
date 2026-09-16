# Release blocker: PR #39 (carrier/device_type checkout gate) vs. Apple Build 11

**Status: OPEN. Do not deploy PR #39 to production. Do not merge PR #39.**

## The dependency, stated plainly

**PR #39 / the carrier-device-type backend must not be deployed to production while Apple Build 11 is the production/review client, because Build 11 does not persist `carrier_provider_key` or `device_type`, and would be blocked by the new checkout-eligibility gate.**

This applies to the whole carrier-onboarding-gate feature, not only the 2026-09-16 landline/`device_type` addition — the mobile checkout gate (`evaluateHouseholdCheckoutEligibility` wired into `POST /api/v1/billing/create-checkout-session`) predates today's fix and is equally implicated.

## Exact Build 11 source commit

`0e6b9d3955d5aca084467013d8c055144edb7cb3` — "Fix Apple Build 10 rejection: Contacts purpose string, pre-permission bypass, Android references", branch `fix/apple-build11-review-remediation`, merged into `sandbox/mobile-app-v1` via `0faeb6e` (2026-09-15). A dedicated worktree, `/Users/ad/call-ai-apple-build11`, is checked out at `0faeb6e` — independent confirmation this is the exact submitted tree.

## Why this is a hard block

At `0e6b9d3`:
- `mobile/app/(setup)/device-picker.tsx` is the pre-carrier-gate screen (its own header: "Purely a local routing decision — no backend call needed").
- `mobile/lib/api.ts` has no `checkCarrierCompatibility`, `setHouseholdLandline`, or any call to `/api/v1/onboarding/carrier-compatibility`.
- `mobile/lib/api.ts`'s `createCheckoutSession` posts to `/api/v1/billing/create-checkout-session` with an empty body — it never sends `deviceType`, and never could.

A Build 11 household therefore always has `carrier_provider_key = null` and (after migration 040) `device_type = null`. If the mobile checkout gate is live in production, `evaluateHouseholdCheckoutEligibility` resolves that shape to `unverified` / `canProceedToPayment: false` — every Build 11 customer attempting to subscribe via the app receives a false `carrier_incompatible` 403, mobile or landline alike. There is no app-version gate or grandfather exemption anywhere in the backend today.

This is a request-shape-independent problem: `create-checkout-session`'s contract itself hasn't changed (still no required body fields), so Build 11's request is not rejected for anything it sends — it is blocked by a new *precondition on server-side state* that Build 11 has no way to ever satisfy.

## What is and isn't affected

- **New signups via Build 11 (or any earlier build): blocked**, per above — this is the actual production-deployment blocker.
- **Existing already-subscribed customers, any build**: unaffected. They don't call `create-checkout-session` again in normal use; `GET /api/v1/me/dashboard` only gains an additive `deviceType` field, gated on nothing.
- **Login, contacts, Voice SDK registration, call delivery/routing**: unaffected. None of today's or PR #39's changes touch auth, contacts, `services/voiceAccessToken.js`/`services/voicePushCredential.js`, or `services/callRouting.js`'s `decideCallDeliveryPlan`/`computeProtectionStatus`. See `docs/mobile-app/APP_DECISION_008_call_delivery_architecture.md`'s 2026-09-16 update for a related but distinct naming-collision note: migration 040's `households.device_type` is unrelated to the differently-scoped, deliberately-deferred `device_type` once designed for PSTN call-delivery routing.

## What this is not asking for

No workaround, bypass, or version-exemption for Build 11 has been added, and none should be, per explicit instruction. Build 11 itself, the App Store Connect submission, and production are all untouched by this work. This document exists to record the dependency, not to resolve it.

## Resolution

**Production deployment of PR #39 (with or without the 2026-09-16 landline/device_type fix) requires a separate compatibility/release decision after the Apple Build 11 review outcome is known** — e.g. once Build 11 is approved and a superseding build (with the carrier-onboarding UI) has shipped and reached sufficient adoption, or once an explicit, deliberately-designed compatibility mechanism (version gate, grace period, or similar) is proposed, reviewed, and approved on its own merits. Not decided here.

## Current state (2026-09-16)

- Migration 040 and the full carrier/device_type backend + web + mobile-source changes are implemented, tested (full suite green), and applied to **staging only** (`tigwgmayeuisrxjjykqd`).
- Production (`psbzynxplxfbyrbdidmn`) is untouched and remains on its pre-PR-39 schema/backend.
- PR #39 is pushed with this work, **not merged**.
- Apple Build 11 is untouched; App Store Connect is untouched.
