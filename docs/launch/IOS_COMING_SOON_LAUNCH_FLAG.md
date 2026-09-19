# IOS_COMING_SOON launch flag

**Status: implemented, staged for review. Not yet deployed to production or staging. Apple Build 12 untouched — this document does not authorise touching it.**

**2026-09-19 addendum — a related, separate launch-safety correction**: while implementing this, review found that landline households proceeded to payment unconditionally, with no server-side record of *which* landline provider they had — `setHouseholdLandline()` took no provider argument at all. Fixed alongside this work (migration 043, `services/providerPolicy.js`'s `LANDLINE_SUPPORTED_PROVIDERS`): only the five explicitly-verified providers (BT, Sky, Virgin Media, TalkTalk, Plusnet) may now proceed; "Other/not sure" and any unaudited/manipulated provider value fails closed before payment and is offered the same waiting-list mechanism, with `reason: "unsupported_carrier"` and `deviceType: "landline"`. This is unrelated to the `IOS_COMING_SOON` flag itself (it is not flag-gated — the five-provider list is a real, permanent product fact, not a temporary launch restriction) but shares the same waiting-list infrastructure this document describes below.

## Why

Android and landline launch is proceeding while Apple App Store approval for the iOS app remains pending (Build 12, uploaded to internal TestFlight only, not submitted to App Review). New iPhone customers must not be able to reach paid checkout until Apple approves the app and a real iOS purchase path exists to serve them.

## The flag

`IOS_COMING_SOON` — a backend environment variable, read by `services/featureFlags.js:isIosComingSoon()`. Defaults to `true` (fails toward "not available") whenever unset or anything other than the literal string `"false"`.

This is the **single** source of truth. Everything else reads it, directly or indirectly:

- `services/providerPolicy.js`'s `evaluateHouseholdCheckoutEligibility` — blocks checkout for any household with `device_type = 'iphone'` while the flag is true. This is the actual enforcement point, server-side, immediately before both `POST /billing/create-checkout-session` (web) and `POST /api/v1/billing/create-checkout-session` (mobile) ever reach Stripe.
- `GET /api/v1/launch-flags` — public, unauthenticated, returns `{ iosComingSoon: boolean }`. The homepage banner, the website's iPhone waiting-list section, and (once a future mobile build exists) the app all read this to decide what to show.

## Removal — restoring iPhone purchasing

One step: **set `IOS_COMING_SOON=false`** on the backend and redeploy.

Immediate effect, no other code change needed:
- `evaluateHouseholdCheckoutEligibility` stops blocking `device_type = 'iphone'` households; they fall through to the normal `evaluateProviderCompatibility` carrier gate, exactly like any mobile household (proven directly in `tests/ios-coming-soon-and-payment-safety.test.mjs`).
- `GET /api/v1/launch-flags` starts returning `iosComingSoon: false`.
- The homepage banner and the website's waiting-list section both disappear automatically (they're shown only when this fetch says the flag is on).
- The website's device-type picker's "iPhone — Coming soon" label and its dead-end panel need a small follow-up source edit (revert the label, remove the short-circuit branch in `evaluateCarrierCompatibility`) — not flag-driven on the website today, since the website is static-served HTML and this was judged simpler than adding a second runtime fetch to gate the label text itself. Left as an explicit, separate step rather than silently auto-hiding — worth a deliberate decision at the time, not a surprise.

For the **mobile app**, `mobile/app/(setup)/device-picker.tsx`'s "iPhone — Coming soon" label and its dead-end step are hardcoded source, not flag-driven — because the app can only ever change behaviour via a new build regardless of what any runtime flag says. Restoring iPhone purchasing on mobile requires: revert the label, remove the `type === "iphone"` short-circuit in `selectDevice`, and cut a new build once Apple has approved the app. This is the "no major rewrite" property the launch instruction asked for — the change is a small, localised revert of one screen, not new engineering.

## What device_type = 'iphone' means, and doesn't

- Persisted server-side via the same `set_household_carrier_compatibility` RPC (migration 041) that already handles `mobile`/`landline` — reuses the established pattern rather than inventing a parallel mechanism.
- Atomically clears `carrier_provider_key`/`carrier_tariff_type` on the same write, identically to the landline case — no stale mobile-carrier data survives a switch to or from `iphone`.
- Does **not** imply anything about UK mobile carrier compatibility — an iPhone customer might genuinely be on a fully-supported network. The block is about there being no way to complete onboarding/activation for an iPhone yet, not a carrier verdict.
- A manipulated request that also claims a supported carrier is still blocked while `device_type = 'iphone'` and the flag is on — proven directly in the test suite.

## Waiting list

One reusable mechanism (migration 042, `public.waiting_list_signups`) for two reasons: `ios_coming_soon` and `unsupported_carrier`. Unauthenticated by design — a prospective signup has no session. `POST /api/v1/waiting-list` validates `reason` against a known set and the email shape before writing; `provider_key` is only ever stored for the `unsupported_carrier` reason. RLS denies `anon`/`authenticated` all access; only `service_role` (i.e., only this backend route) can read or write it.
