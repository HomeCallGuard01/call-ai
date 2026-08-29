# APP_DECISION_005 — Backend / API Strategy

STATUS: Proposed for review. Not implemented.

## Authentication: bearer tokens, not cookies

`requireAuth` today reads `sb_access_token`/`sb_refresh_token` cookies and redirects to `/login.html` on failure — both wrong assumptions for a mobile client. Supabase's own client SDKs (including `@supabase/supabase-js`, usable from React Native) handle bearer-token session storage and refresh natively, so the recommended approach is: **the app authenticates directly against Supabase Auth using the Supabase JS client** (same signUp/signInWithPassword/resend/recovery calls the web app already uses), stores the session via Expo SecureStore, and sends the access token as an `Authorization: Bearer` header to new/adapted backend endpoints.

A new `requireAuthApi` middleware (parallel to, not a replacement for, `requireAuth`) is needed: same `getUser()`/`refreshSession()` logic, but returns `401 JSON` instead of a redirect, and reads the token from the `Authorization` header instead of a cookie. This is additive — the existing `requireAuth` continues to serve the web app unchanged.

## Endpoints that can be reused as-is

- `/billing/create-checkout-session`, `/billing/manage-membership` — Stripe's own hosted checkout/portal already returns proper redirect URLs; the app opens these in an in-app browser (Expo `WebBrowser`), no backend change needed.
- The underlying **query logic** in `database/contacts.js`, `database/billing.js`, `database/households.js` — fully reusable; only the route layer wrapping them needs a mobile-appropriate variant.

## New endpoints required

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/me/dashboard` | Mobile-shaped equivalent of `/dashboard-data` — same underlying data, restructured for the app's screen set (status/contacts/activity as distinct, purpose-built shapes rather than one page's JS-specific blob) |
| `POST /api/v1/contacts/bulk` | JSON-body variant of contact upload for the native contact-picker flow (APP_DECISION_004) — reuses existing parsing/dedup logic, new transport only |
| `POST /api/v1/activation/verify` | Confirms call-forwarding activation actually worked (APP_DECISION_003) — checks for a real routed test call in the `calls` table within a short window |
| `POST /api/v1/devices/register` | Push-notification token registration (new table — see below) |
| `GET /api/v1/notifications/preferences` / `PUT` | The two-category notification toggle from APP_DECISION_002 |

## Database changes required

- **`push_tokens` table** (new): `household_id`, `device_token`, `platform` (ios/android), `created_at`. Needs the same least-privilege treatment as everything else in this schema — `service_role` gets `SELECT/INSERT/UPDATE`, a narrow RPC or direct RLS-scoped write for the app's own token registration (matching the existing `authenticated`-scoped-by-`auth.uid()` pattern already used for households/contacts), no blanket table grant.
- **`notification_preferences`** — either a new small table or two boolean columns on `households` (`notify_high_risk_call`, `notify_account_action`) — the latter is simpler and consistent with how `twilio_provisioning_status` etc. already live directly on `households` rather than a separate settings table.
- No changes needed to `subscriptions`, `entitlements`, `stripe_webhook_events`, `calls`, or the core `contacts` schema — the mobile app is a new *client* and a thin new *API surface*, not a new data model.

## What NOT to build

A GraphQL layer, a separate mobile-specific backend service, or a rewrite of the existing REST-ish routes into a formal API framework. The existing pattern (Express routes + thin `database/*.js` query wrappers + narrow Supabase RPCs for privileged writes) has been exercised hard this engagement (webhook ordering, household bootstrap, anonymisation) and holds up — extend it, don't replace it.
