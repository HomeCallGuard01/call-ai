Document: Launch Readiness
Version: 1.1
Last Updated: 2026-07-18
Status: Active
Owner: Andrew Deane

---

# Stripe Billing — Launch Readiness

## Sandbox end-to-end: verified 17 July 2026

The full paid-subscription journey was tested against Stripe Sandbox through the real app UI (Safari), not mocked:

register → confirm email → log in → dashboard → "Get Protected Today" → Stripe Checkout → test-card payment → redirect back → webhook → subscription/entitlement activated → dashboard shows "Protected"

Verified directly in both Stripe and Supabase (not just the UI):

- Stripe: exactly one `active` subscription for the test customer
- Supabase `subscriptions`: exactly one `active` row, matching the Stripe subscription ID
- Supabase `entitlements`: exactly one `active` row, `external_reference` matching the same subscription ID

## What had to be fixed to get a clean pass

| Issue | Fix |
|---|---|
| `set_household_stripe_customer_id` / `process_stripe_webhook_event` / `claim_stripe_webhook_event` RPCs didn't exist in the database | Applied migrations 013 and 014 (were committed but never run) |
| Safari lost the session after email confirmation | `localhost` vs `127.0.0.1` are different cookie origins; confirmation redirect always targeted `localhost` regardless of which host was used to register. Added a canonicalizing 301 redirect in `server.js`, applied before auth middleware, preserving path/query |
| Stripe CLI webhook forwarding silently dropped events | CLI's relay session was cycling through repeated "Session expired, reconnecting..." — restarted to a stable connection; missed events recovered by replaying the real historical Stripe event directly against the webhook route with a valid signature, rather than repeating the payment |
| Cancelling an accidental duplicate subscription would have wrongly expired the real active entitlement | `process_stripe_webhook_event` expired *any* active entitlement for a household on *any* subscription going non-qualifying, without checking which subscription the entitlement actually referenced. Fixed in migration 015 to require `entitlements.external_reference` match |
| "Confirming your payment" banner never cleared | `upload.html` set it visible on `?checkout=success` but nothing ever hid it again. Now cleared once `/dashboard-data` reports the protected state |

## Duplicate checkout sessions — investigated and fixed (18 July 2026)

**Root cause:** the checkout button was never disabled after submission, and no server-side check existed for a subscription already in progress. When a webhook was delayed/dropped (see the CLI relay fix above), the dashboard gave no confirmation, so a genuine second click ~3.5 minutes later was processed as an unrelated new request. The idempotency key's wall-clock 5-minute bucket didn't catch it either — the two real attempts, though under 4 minutes apart, fell in different buckets.

**Fix:**
- `upload.html`: subscribe button disables itself and shows "Redirecting to checkout…" immediately on submission, preventing a repeat click on the same page instance
- `routes/billing.js`: queries Stripe directly for an existing `active`/`trialing` subscription before creating a new Checkout Session — this is what actually closes the gap, since it checks Stripe itself rather than our webhook-populated DB (unreliable in exactly this window). `past_due`/`unpaid` deliberately excluded from this check for now — see the code comment for the reasoning; broadening it is a product decision, not made here
- Existing idempotency key kept as-is, now documented: it guards against the client retrying the identical request, not a deliberate second attempt
- Automated tests: `tests/checkout-existing-subscription.test.mjs` (active/trialing block creation, no qualifying subscription allows it), `tests/subscribe-button.test.mjs` (button disables and updates text on submission, stays disabled on repeat invocation)

**Deferred — not done in this pass:** a database-level concurrency lock (Postgres advisory lock or reservation row) for two requests arriving genuinely simultaneously (faster than the button can visually disable, or from two separate tabs). The fix above addresses the actual incident (a delayed webhook prompting a manual retry minutes later); true concurrent-request protection remains a defense-in-depth improvement to pick up separately, since it requires new schema/locking infrastructure rather than tightening existing logic.

## Known gaps — not yet resolved

- **Migrations 007–009 unconfirmed:** `007_grant_authenticated_household_reads.sql`, `008_household_isolation_contacts.sql`, `009_service_role_minimum_app_privileges.sql` are all still headed "DRAFT — NOT APPLIED". These cover contacts/household RLS isolation and minimum service-role privileges — real security surface. Given 013/014 headers were also stale (already applied, header just not updated), their true state against the live database should be explicitly confirmed rather than assumed either way before launch.
- **Migration 005 is deliberately frozen** ("Frozen after Sprint 7 for MVP launch... Do not run against production until explicitly re-approved") — its contacts-RLS piece was superseded by 008. Not a gap to fix, just noted so it isn't mistaken for an oversight.
