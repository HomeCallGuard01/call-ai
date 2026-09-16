Document: Fast-Follow — Family / Multi-Line Architecture Requirement
Status: Deferred — not part of the current release, recorded so it is not forgotten
Decided: 2026-09-16, during the landline checkout-eligibility fix (migration
040_household_device_type.sql)
Related: supabase/migrations/038_household_carrier_compatibility.sql,
040_household_device_type.sql, services/providerPolicy.js

---

# Title

Move device type, carrier/provider, tariff type, forwarding configuration/
status, and compatibility status from household-wide properties to
per-protected-line records, when Family/multi-line support is built.

# Problem

Home Call Guard is expected to later support a Family/multi-user
subscription protecting multiple phones/lines under one subscription —
for example, one household with three protected lines: Mobile (Vodafone),
Mobile (Lebara), and Landline (BT), each potentially with its own
compatibility status and forwarding configuration.

The current schema treats all of the following as **household-wide**
properties, i.e. exactly one value per household:

- `households.device_type` (migration 040 — mobile/landline)
- `households.carrier_provider_key` / `carrier_tariff_type` /
  `carrier_compatibility_captured_at` (migration 038)
- `households.twilio_number` / `twilio_provisioning_*` (migration 016/017)
- `households.activation_verified_at` (migration 021)
- `households.delivery_verified_at` (migration 036)
- `households.voice_client_registered_at` (migration 035)

This is correct and sufficient for the current, single-protected-line
product, but every one of these fields is really a property of **the
protected line**, not of the household/subscription as a whole. Once a
household can have more than one protected line, all of these need to
move.

# Decision (2026-09-16)

`households.device_type` was added in migration 040 as a household-wide
column, matching the existing interim pattern already established by
migration 038's carrier fields. This is an **acceptable, low-risk interim
step**, not a new architectural commitment — see the assessment below.

# Why this doesn't materially obstruct the future model

- `device_type` is a plain nullable `text` column with a `CHECK`
  constraint, no foreign keys, no dependent views, no other table
  references it. Migrating it to a new per-line table later is a
  standard "promote a scalar to a related table" refactor: create the
  new table, copy each household's current value into exactly one row
  (the household's single existing protected line), then drop the
  household-level column once the multi-line UI/API exists.
- It is not a special case relative to the fields already in the same
  position (`carrier_provider_key`, `twilio_number`,
  `activation_verified_at`, `delivery_verified_at`,
  `voice_client_registered_at`, etc.) — all of these already need the
  exact same future migration, for the exact same reason. Adding one
  more column of the same shape does not increase the size or
  difficulty of that eventual refactor in any meaningful way.
- `services/providerPolicy.js`'s `evaluateHouseholdCheckoutEligibility`
  reads `household.device_type`/`carrier_provider_key`/
  `carrier_tariff_type` directly off the household object passed in —
  when a `protected_lines` table exists, this function's *shape* stays
  the same (it takes a device_type + carrier + tariff and returns a
  verdict); only the *caller* changes, to resolve and pass in the right
  line's record instead of the household's own columns. No rework of
  the actual policy/eligibility logic is required.

# Required when Family/multi-line is designed

1. Create a `protected_lines` (or similarly named) table:
   `id, household_id, device_type, carrier_provider_key,
   carrier_tariff_type, carrier_compatibility_captured_at, twilio_number,
   twilio_provisioning_status, activation_verified_at,
   delivery_verified_at, voice_client_registered_at, ...` — one row per
   protected phone/line.
2. Backfill: for every existing household, create exactly one
   `protected_lines` row from its current household-level values —
   lossless, since today's model is already "household == exactly one
   line."
3. Update `evaluateHouseholdCheckoutEligibility` (or its successor) and
   every caller (`routes/billing.js`, `routes/mobileApi.js`, mobile
   `device-picker.tsx`/`activate.tsx`, web `upload.html`) to operate on
   a specific `protected_lines` row rather than the household row
   directly.
4. Decide the subscription/billing model implications (one subscription
   price covering N lines? per-line pricing? a cap on N?) — a genuine
   product decision, not something this document attempts to answer.
5. Deprecate/drop the household-level columns listed above once nothing
   reads them anymore.

# Explicitly out of scope right now

Do not build Family/multi-line support as part of the current landline
checkout-eligibility fix (PR #39) or any related work in this pass. This
document exists so the future requirement is not silently forgotten, not
to schedule it.
