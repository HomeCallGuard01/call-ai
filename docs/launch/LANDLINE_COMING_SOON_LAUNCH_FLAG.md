# LANDLINE_COMING_SOON launch flag

**Status: integrated on `release/android-v10` (local only) — mobile app, backend gate, website and /go together. NOT pushed, NOT deployed. No production, Stripe, Twilio, Supabase or Apple/iOS change is part of this.**

## Why

Home Call Guard cannot yet deliver an approved call back to a landline handset. Test 3 on a real BT Digital Voice line (2026-09-21) showed the carrier diverts a return leg — even one whose caller ID is the divert target — straight back to Home Call Guard. Until a loop-safe landline delivery path exists, **new landline customers must not be able to pay for, or set up, a service that cannot work for them.** Landline is "Coming soon", exactly like iPhone.

## The flag

`LANDLINE_COMING_SOON` — a backend environment variable read by `services/featureFlags.js:isLandlineComingSoon()`.

**Fails closed.** It is `true` (Coming soon) whenever the variable is unset or anything other than the exact, lower-case string `"false"` — `"False"`, `"0"`, `"no"`, `""` and `" false"` all still mean Coming soon.

This is the **single authoritative source**. Everything else reads it:

| Consumer | How |
|---|---|
| `services/providerPolicy.js` `evaluateHouseholdCheckoutEligibility` | The one server-side decision every route below goes through. While the flag is on, a `device_type = 'landline'` household **cannot proceed to payment**, whatever its provider (supported, "other", missing, manipulated). Checked first, before any provider is considered. |
| Website + mobile carrier-compatibility routes (`POST`/`GET`) | Report `canProceedToPayment: false`. |
| `POST /billing/create-checkout-session` (website) and `POST /api/v1/billing/create-checkout-session` (mobile) | Reject **before any Stripe call** and before the entitlement lookup: 403 `carrier_incompatible` (mobile) / redirect to `/dashboard?checkout=carrier_incompatible` (website). |
| `GET /api/v1/launch-flags` (public, unauthenticated) | Publishes `landlineComingSoon` alongside `iosComingSoon`. |
| Mobile app | Reads `landlineComingSoon` from `/api/v1/launch-flags` and **fails closed**: landline is treated as available only when that response explicitly says `landlineComingSoon === false`. A failed, timed-out, malformed or field-less response keeps landline Coming soon. |
| Web onboarding (`upload.html`) | Same rule, in the page: landline opens only for a 2xx `launch-flags` object with `landlineComingSoon === false`. The Landline choice is recorded server-side with `provider: "other"` (so the capture-route contract is unchanged) and the response is **ignored** — a 400 or any other answer can never make landline available. The page keys on `reason: "landline_coming_soon"`, never on a state the server does not send. |
| `/go` | `services/goLanding.js` renders the Landline card as a Coming-soon waiting-list card unless `landlineComingSoon` is the boolean `false`. Android links to Google Play; iPhone and Landline collect interest through `POST /api/v1/waiting-list` with reasons `ios_coming_soon` / `landline_coming_soon` (the `reason` column is open text — no migration). |
| Public website | Homepage, support page and the 12 guides state that Android is available and iPhone/landline are coming soon; Landline is a non-clickable tile and no page links a landline sign-up route. These are static copy, not flag-driven. |

## What older clients see

`status` and `customerState` deliberately stay **`landline_provider_unsupported`** — the one landline-blocked state every already-shipped client (Android v8/v9 and earlier, the website's onboarding page) already understands, and renders as a dead end *before* payment. Only `reason` carries the real cause, `landline_coming_soon`; no client renders `reason`. Older clients therefore fail safely without meeting a state they do not know.

## What is deliberately NOT affected

- **Android / mobile checkout** — unchanged, every carrier verdict identical.
- **iPhone Coming soon** — unchanged (`IOS_COMING_SOON` is independent of this flag in both directions).
- **Existing landline households and Turn off protection** — `GET /api/v1/activation/instructions` and `GET /api/v1/me/activation-device` never consult this gate, so an existing landline customer keeps the cancel code. (The mobile app's Turn off protection screen is deliberately not gated either.)
- **Existing subscriptions / entitlements** — the flag only affects *new* checkout and the pre-check; it never touches an existing entitlement, a Stripe subscription or a webhook.
- **The landline implementation** — nothing was deleted. `LANDLINE_SUPPORTED_PROVIDERS`, the provider rules, `setHouseholdLandline`, the activation-code generation and the waiting-list reasons are all still in place underneath the flag.
- **Stripe products/prices, Twilio provisioning, Supabase schema** — untouched. No migration.

## Known limits (honest)

- **iOS purchases go through Apple StoreKit / RevenueCat**, which the server cannot intercept beforehand. iOS relies on the app's own pre-check against the carrier-compatibility route (which now says "cannot proceed" for landline). Not addressed here (Apple is out of scope).
- **A Stripe Checkout Session opened before this flag was deployed** can still be paid until it expires (Stripe's default is 24 hours). There are no genuine landline households, so this is nil in practice today.
- **Self-classification:** the server only knows the device type the client told it. A landline customer who claims to be on a mobile network is indistinguishable from a mobile customer — true before this flag too.
- **Admin-granted complimentary access** intentionally skips payment and is unchanged.

## Restoring landline

Set `LANDLINE_COMING_SOON=false` on the backend and redeploy. Effects:

- `evaluateHouseholdCheckoutEligibility` skips the Coming-soon branch; the original five-provider landline rules apply again (proven in `tests/landline-coming-soon-backend.test.mjs`, section 7).
- `/api/v1/launch-flags` returns `landlineComingSoon: false`, and the mobile app (which follows this value) shows landline as available **without a new build**.
- The website's static copy (homepage tiles, FAQ, guides, support page) and the `/go` waiting-list copy still say Coming soon and must be updated deliberately at that time; `upload.html` and `/go` open landline on their own once the flag says so.

Do **not** flip it until a loop-safe landline delivery path exists and has been physically proven.

## Tests

- `tests/landline-coming-soon-backend.test.mjs` — loads the real route modules and calls the real handlers with a Stripe stand-in that records any access.
- `tests/mobile-landline-coming-soon.test.mjs` — the mobile app's fail-closed handling, executed against the real `landlineAvailability.ts`.
- `tests/website-landline-coming-soon.test.mjs` — `upload.html` fail-closed behaviour, `/go` (executed) fail-closed matrix, the public-site claims scan, and the "one gate only / no superseded state / no migration" integration contract.
- `tests/provider-policy.test.mjs`, `tests/ios-coming-soon-and-payment-safety.test.mjs` — the landline provider-rule assertions now run with the flag explicitly `"false"` (they prove the preserved rules).
