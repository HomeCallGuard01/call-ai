# APP_DECISION_008 — Call Delivery Architecture (Self-Protecting Return Path)

STATUS: LOCKED — implemented 23 Aug 2026. Companion to APP_DECISION_003 (activation strategy) — that document covers how forwarding gets turned on; this one covers where an approved call actually goes once it does.

## The incident this closes

Production's first real forwarded call, 15 Aug 2026, looped indefinitely: an approved call was dialled back to `household.phone_number` over PSTN, which still had the customer's own unconditional carrier forwarding active to the same Twilio number — the carrier intercepted Twilio's own dial-back and redirected it straight into a brand-new inbound call, forever. Full incident: `docs/operations/HANDOVER_2026-08-15.md` §6-13.

A same-day fix (`fix/call-forwarding-loop-2026-08-15`, commit `b2a8924`) attempted to guard this using Twilio's `ForwardedFrom` request parameter. **Confirmed dead code, 23 Aug 2026**: real Twilio Console Request Inspector data for two actual forwarded calls shows `ForwardedFrom` absent on this UK carrier path. A guard conditioned on a parameter the carrier never sends can never fire. This branch was never merged into `main`.

## The decision

**The loop is made impossible by construction, not by a runtime check.** `households.self_protecting boolean not null default true` (migration 028) is an explicit, stored fact — never inferred by comparing phone numbers at call time, never dependent on any Twilio-supplied parameter.

- **`self_protecting = true` (the default, and the only mode standard onboarding produces):** the household's own phone is both the forwarded line and the intended recipient. `services/callRouting.js`'s `decideCallDeliveryPlan` returns `{ mode: "client-only" }` for these households — no PSTN number is ever constructed anywhere in this code path. Delivery is exclusively via a Twilio Voice SDK `<Client>` noun to the Home Call Guard app (`client:household_<id>`), which never touches the PSTN/carrier-forwarding layer at all, so the loop condition cannot occur regardless of carrier behaviour. If the Client doesn't answer (app not installed, not registered, or timed out), the call fails safely (`/call-delivery-failed`, a plain "please try again later" message) — it never falls through to a PSTN dial-back.
- **`self_protecting = false` (a genuinely separate destination — a different family member's line, a landline monitored by someone else):** PSTN `<Number>` delivery remains valid and unchanged, since the destination is confirmed distinct from whatever's actually forwarded. `<Client>` is still offered in parallel as a bonus.
- **Standard onboarding never asks the customer to understand or choose this** — the normal customer is not expected to know what "self-protecting" means. `self_protecting` defaults to `true` for every household; only a distinct, not-yet-built "I'm protecting someone else's phone" journey would ever set it `false`. Until that journey exists, every real household is correctly on the safe-by-default path.

## Why this, not the app-vs-website question

The earlier framing of this problem as "does call delivery require the app" was incomplete. The real constraint is narrower and unconditional: **a self-protecting household can never safely receive an approved call over PSTN, regardless of which client (website or app) configured activation.** The one-tap website activation mechanism (APP_DECISION_003) and this delivery decision are independent — a customer can activate forwarding entirely through the website, and still requires the app's Voice SDK registration to actually receive the resulting approved call. "Do not claim Protected until forwarding AND the required app call-delivery endpoint are actually ready" (product requirement, 23 Aug 2026) follows directly from this.

## Platform status

- **Android:** real-device proven (`sandbox/mobile-app-v1` commit `5069d42`) — FCM push delivery, real incoming-call UI, manual answer, two-way audio, confirmed twice on a physical Moto E7.
- **iOS:** client code already correct (`mobile/lib/voiceClient.ts` calls `voice.initializePushRegistry()`, delegating CallKit/PushKit integration to Twilio's SDK; `aps-environment: production` and `UIBackgroundModes: ["audio", "voip"]` already configured). **Blocked on one missing resource**: no Twilio iOS Voice Push Credential has ever been created (`TWILIO_VOICE_PUSH_CREDENTIAL_SID_IOS` absent from every env file) — an owner-only action (Apple Developer Portal APNs key + Twilio Console), not a code gap. Real-device proof pending as of this document's status date.

## What was NOT built today (explicitly deferred)

Customer notification (voicemail/SMS/missed-call alert) for the case where an approved call reaches `/call-delivery-failed` — the household currently gets no notification at all when this happens. Logged as a real, known gap; not built as part of this decision, to keep this change scoped to the routing/delivery-safety fix it's actually about.
