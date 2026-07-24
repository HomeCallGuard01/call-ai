# Sandbox Status — Registration/Auth/Dashboard/Contacts/Membership work

**Branch:** `sandbox/v1.5-registration-auth`, off `main` @ `69bf34c`

This branch covers Stage 1 (registration anti-enumeration), Stage 2 (dashboard Twilio-number removal + wording), Stage 3/3.6/3.7 (trusted contacts CRUD + upload experience), and Stage 4 (Membership card, Billing Portal, cancellation/trial/payment-issue states) — see the commit history for each stage's own detailed message.

## QA billing fixture (Stage 4 launch-readiness checkpoint)

The QA sandbox household (`6555f0f4-2978-478f-8bdc-68ec3f2c74b2`, `qa-sandbox-v1.5@homecallguard.co.uk`) carries two permanent test-only billing artifacts, kept deliberately rather than deleted (see below for why):

- **`subscriptions` row**, `id: e855a412-5c64-4a92-8ce7-926a9900cc6f`, `stripe_subscription_id: 'sub_stage4_test'` (synthetic, not a real Stripe object), currently left in a terminal `status: 'canceled'`, `cancel_at_period_end: true` state. Used to exercise the Membership card's active/trial/cancelled/payment_issue rendering during Stage 4 by temporarily editing its `status`/`cancel_at_period_end` fields and re-querying `/dashboard-data` — safe to reuse the same way for future dashboard/billing UI work.
- **Real Stripe test-mode customer**, `cus_UwjbJaxUoGpKL7`, attached to this household's `stripe_customer_id` via the sanctioned `set_household_stripe_customer_id` RPC. Used to prove the real `/billing/manage-membership` → Stripe Billing Portal redirect end-to-end. Test-mode only, costs nothing, affects nothing outside this account's test data.
- All entitlement rows ever created against this household (4 total, spanning Stage 2/3/3.6/4 testing) are `status: 'revoked'`.

**Why these are kept, not deleted:** `service_role` has no `DELETE` grant on `subscriptions` or `entitlements` (migration 012 — deliberate least-privilege, confirmed real via a live `permission denied` error, not assumed). Per explicit instruction, this was not treated as a reason to request a broader grant. The rows are inert (terminal `canceled` status, all entitlements revoked) and clearly fake-labelled (`sub_stage4_test`, `price_stage4_test`).

**Confirmed isolation** (checked directly against the real database at time of writing): this is the *only* `subscriptions` row for this household; the three real customer households (`d8036eb6`, `5bc60e90`, `33e7ae3e`) each have exactly one real, untouched, `status: 'active'` subscription row of their own, with real Stripe subscription IDs. There is no code path anywhere in this app that joins or reads across `household_id` when computing another household's entitlement/membership state, so this fixture cannot affect any other household by construction, not merely by convention.
