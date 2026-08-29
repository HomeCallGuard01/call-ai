# APP_DECISION_001 — Overall Architecture

STATUS: Proposed for review. Not implemented.

## Decision

Build the mobile app as a **separate client against the existing backend**, not a rewrite. The website remains the system of record for admin/support and the fallback web-based onboarding path; the app becomes the primary day-to-day customer surface (protection status, trusted contacts, membership, notifications). Backend changes are additive — new endpoints and a few schema additions — never a replacement of what exists.

## Why not a rewrite

Everything that actually matters for a scam-screening product — the Twilio call-handling pipeline, the OpenAI behavioural classification, the Stripe billing lifecycle (including the event-ordering guard fixed this engagement), the least-privilege Supabase RLS/RPC model — lives entirely server-side and is completely unaffected by what client renders the dashboard. There is no technical reason to touch any of it to ship a mobile app. Rewriting it would introduce risk (this system now has a real, tested, hardened webhook-ordering and household-bootstrap history behind it) for zero customer-facing benefit.

## Stack recommendation: React Native + Expo + TypeScript

Per your stated default, and I don't see a compelling reason to deviate:

- **One shared codebase for iPhone and Android** is the right call for a small team shipping a v1 — the platform-specific work that genuinely differs (call-forwarding activation instructions, contact-picker integration, push-notification registration) is a thin native-module layer, not the whole app.
- **Expo** removes the need to own native build tooling (Xcode/Gradle config, signing, provisioning profiles) for most of the app, while still supporting a native "dev client" build the moment something needs a native module Expo doesn't ship (e.g. CallKit integration if you ever pursue that — see APP_DECISION_003/007).
- **TypeScript** matters more here than usual because the API contract between app and backend is currently informal (JSON shapes defined only by what `upload.html`'s JS happens to read) — typed request/response contracts (APP_DECISION_005) prevent silent drift as both sides evolve independently.

### Explicit deliverable confirmation

This project produces **one shared TypeScript/React Native codebase** that builds into **two separate, real, store-submittable native applications**:

1. **An iOS application, built and submitted to the Apple App Store.**
2. **An Android application, built and submitted to Google Play.**

This is not two codebases sharing some logic — it is one codebase, compiled twice. Expo's build service (EAS Build) produces a genuine native `.ipa` for App Store submission and a genuine native `.aab`/`.apk` for Google Play submission from the same source tree, which is precisely why React Native + Expo is suitable here: the alternative (two fully separate native codebases, Swift/Kotlin) would double the implementation and maintenance effort for a product where almost nothing about the core experience (status, contacts, activity, membership) genuinely differs by platform.

**Platform-specific implementation is scoped narrowly, only where iOS or Android capabilities or interface conventions actually require it** — consistent with what this document and `APP_DECISION_003` already establish:
- Call-forwarding activation instructions and constraints differ by platform (iOS's `tel:` restriction on `*`/`#` strings vs. Android's equivalent manual-dialling reality) — this is content/copy branching, not a separate app.
- Native contact-picker integration (deferred to post-launch per the Launch Feature Matrix) will use one cross-platform library (`expo-contacts`) wrapping both platforms' native contact APIs behind one JS interface, not two separate native implementations.
- Push notification registration differs at the OS level (APNs vs. FCM) but Expo's notification APIs abstract this behind one JS call.
- Any platform-native UI conventions (e.g. iOS vs. Android settings-list styling, back-gesture conventions) are handled by React Navigation's built-in platform adaptation, not bespoke per-platform screens.

No feature in the approved specification requires, or should be given, a genuinely separate implementation per platform outside of these narrow, OS-capability-driven exceptions.

## What stays on the website

- Admin dashboard (`routes/admin.js`) — no reason to ever mobile-ify this.
- Onboarding **fallback**: any customer who can't or won't install an app still needs a working web path. Don't gate account creation behind app-store approval.
- Legal pages (terms/privacy) — link to them from the app rather than duplicating.

## What moves to the app as the primary experience

Protection status, trusted contacts, membership/billing view (portal handoff can stay a web view — see APP_DECISION_005), notifications, and the onboarding/activation flow itself (a mobile-native activation experience is the single highest-leverage improvement available — see APP_DECISION_003).

## Architectural risk this decision deliberately avoids

Building a "membership-only" fully custom API is not proposed. The existing `/dashboard-data`-style aggregate endpoints are reused conceptually (same underlying queries) but re-exposed behind properly namespaced, mobile-appropriate, bearer-token-authenticated endpoints (APP_DECISION_005) — not by pointing the app at the literal existing web routes, which return HTML redirects on auth failure and are shaped for one specific page's JS, not general consumption.
