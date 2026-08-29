# APP_DECISION_006 — Implementation Roadmap

STATUS: Proposed for review. Not implemented.

## Phasing principle

Each phase should produce something demonstrable and should not block on a phase that comes after it. Backend additions (Phase 0) are deliberately sequenced first since the app has nothing to talk to otherwise.

## Phase 0 — Backend foundation (can be completed autonomously once approved)

- `requireAuthApi` middleware (bearer-token variant of `requireAuth`).
- New endpoints: `/api/v1/me/dashboard`, `/api/v1/contacts/bulk`, `/api/v1/activation/verify`.
- `push_tokens` table + registration endpoint, `notification_preferences` columns.
- **Effort:** Low-Medium. **Risk:** Low — additive only, existing web routes untouched, same testing pattern as every prior fix this engagement (unit tests with injected fakes + the PGlite migration suite for any schema change).
- **Dependency:** None. Can start immediately after approval.

## Phase 1 — App shell + authentication

- Expo project scaffold, navigation (four-tab structure from APP_DECISION_002).
- Supabase Auth integration: register/login/forgot-password/reset-password screens, SecureStore session persistence.
- **Effort:** Medium. **Risk:** Low — Supabase's own SDKs are designed for exactly this; no novel integration work.
- **Dependency:** Phase 0's `requireAuthApi` for anything past login itself.

## Phase 2 — Core dashboard experience

- Home/status screen, Activity screen, Account screen, consuming Phase 0's new endpoints.
- **Effort:** Medium. **Risk:** Low.
- **Dependency:** Phase 0 + Phase 1.

## Phase 3 — Trusted contacts (native)

- `expo-contacts` integration, custom multi-select UI, bulk-upload flow.
- **Effort:** Medium. **Risk:** Low-Medium (permission-flow UX needs real device testing on both platforms, not just simulator — contact-permission dialogs and edge cases like "zero contacts on device" vary in practice).
- **Dependency:** Phase 0's `/api/v1/contacts/bulk`.

## Phase 4 — Activation flow

- Provider/device-type picker, code display + copy, the verification flow (`/api/v1/activation/verify`).
- **Effort:** Medium. **Risk:** Medium — this is the phase most dependent on real-world testing (real forwarding codes on real devices/carriers), and the one place UX quality directly determines whether non-technical customers succeed unassisted.
- **Dependency:** Phase 0's verification endpoint; ideally sequenced after Phase 2 so there's a working dashboard to land in once activation succeeds.

## Phase 5 — Push notifications

- Device token registration, the two notification categories (APP_DECISION_002), triggering logic on the backend (high-risk-call detection already exists in the screening pipeline — this phase wires a push send onto an existing signal, not a new detection capability).
- **Effort:** Medium. **Risk:** Medium — push requires real Apple/Google push credentials and device testing; can't be fully verified in a simulator.
- **Dependency:** Phase 0's `push_tokens` table, Phase 2's dashboard (notifications should deep-link somewhere meaningful).

## Phase 6 — Billing/membership in-app

- Membership status display, Billing Portal handoff via in-app browser.
- **Effort:** Low. **Risk:** Low — Stripe's hosted Portal is doing the heavy lifting; this is thin.
- **Dependency:** Phase 2.

## Which phases can be completed autonomously without further input

**Phase 0 entirely**, and the bulk of **Phases 1, 2, 3, and 6** — these follow directly from decisions already made in this document set and the existing backend patterns, without needing new product decisions mid-build. **Phase 4 (activation) will likely need at least one check-in** — real-device testing against actual UK carriers is something I can't fully simulate, and copy/UX choices for a non-technical audience benefit from your review before being treated as final. **Phase 5 (push)** needs your Apple/Google developer account credentials at minimum, which is inherently not something to proceed on autonomously.

## Suggested build order

Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 6 → Phase 4 → Phase 5. This gets a working, testable app (auth + dashboard + contacts + billing) before tackling the two phases (activation, push) that most need real-device and real-credential involvement — so those don't block earlier, lower-risk progress.
