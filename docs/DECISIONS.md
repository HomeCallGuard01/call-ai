# Home Call Guard Engineering Decisions

This document records important technical and business decisions made during the development of Home Call Guard.

Each decision should include:
- Date
- Decision
- Alternatives considered
- Reason

---

# Decision 001

## Date

07 July 2026

## Decision

Use Supabase as the application database.

## Alternatives considered

- GoHighLevel
- JSON files

## Reason

GoHighLevel is our CRM and marketing platform.

Supabase is designed to securely store application data such as:

- Users
- Trusted Contacts
- Call History
- AI Results
- Stripe Customer IDs

This architecture will scale to thousands of customers.

---

# Decision 002

## Date

07 July 2026

## Decision

Use Row Level Security (RLS) on all customer data.

## Alternatives considered

- No Row Level Security
- Application-only security

## Reason

Every customer must only be able to access their own information.

RLS will be enabled manually on each table as it is created, giving us full control over security policies.

# Decision 003

## Date

08 July 2026

## Decision

All application configuration will use environment variables.

## Reason

API keys, database URLs and secrets must never be hardcoded into source code.

This allows different Development, Testing and Production environments while keeping secrets secure.

Decision 001
Date: 08 July 2026

Decision:
Replace local contacts.json with Supabase.

Reason:
- Multi-user support
- Scalable
- Cloud backup
- Required for customer accounts
- Removes local file dependency

Impact:
- CSV uploads now write directly to Supabase.
- AI call screening reads live contacts.
- contacts.json deprecated.

---

# Decision 004

## Date

09 July 2026

## Decision

Replace local JSON contact storage with Supabase.

## Reason

The JSON file was suitable for prototyping but not for a scalable SaaS platform.

Supabase provides:

- Cloud storage
- Scalability
- Customer separation
- Future authentication
- Reliable backups

## Result

contacts.json has been completely removed from the production architecture.

Supabase is now the single source of truth.

---

# Decision 005

## Date

10 July 2026

## Decision

Add a `calls` table in Supabase and remove the in-memory `callLogs` array from `server.js`.

## Alternatives considered

- Keep call history in-memory (status quo)
- Write call history to a local JSON/log file

## Reason

The in-memory array did not survive a server restart, so the dashboard's "Recent Activity" and daily stats were never trustworthy after any redeploy. A local file was rejected for the same reason `contacts.json` was rejected in Decision 004: it does not scale, is not customer-separable, and reintroduces the local-file dependency this project has already moved away from.

## Impact

- `server.js` no longer holds any customer-facing state in memory.
- `/dashboard-data` and `/logs` now read live from Supabase.
- RLS is enabled on `calls`. Unlike `contacts`, it has no anon/authenticated policies at all — see Decision 007 for why this table deliberately does not mirror `contacts`' current access pattern.
- Requires a manual one-time step: running `supabase/migrations/001_create_calls_table.sql` in the Supabase SQL Editor, since the app cannot run schema migrations itself.

---

# Decision 006

## Date

10 July 2026

## Decision

Write call log entries to Supabase without waiting for the write to complete before responding to Twilio (`logCall(...)` is called without `await`, with a `.catch()` for error logging only).

## Alternatives considered

- Await the Supabase insert before returning TwiML

## Reason

`/process` responds to a live phone call. Blocking that response on a database round-trip adds latency the caller would notice, for a write that is purely for analytics/dashboard purposes and isn't needed to decide how the call proceeds. This follows the same fail-open, log-and-continue pattern already used for OpenAI failures in the same route.

## Impact

- Call screening latency is unaffected by Supabase performance or outages.
- If the insert fails, the error is logged server-side but the call still connects/blocks correctly and the customer sees no difference. The only consequence is a missing row in call history.

---

# Decision 007

## Date

11 July 2026

## Decision

Access the `calls` table only through a `service_role`-backed Supabase client (`supabaseAdmin` in `server.js`), with RLS enabled and zero policies for `anon`/`authenticated`. `contacts` keeps using the existing anon-key client, unchanged.

## Alternatives considered

- Mirror `contacts`: permissive anon `USING (true)` / `WITH CHECK (true)` policies on `calls`
- Defer any access-model decision until Sprint 7 authentication exists

## Reason

The anon key is only safe to use when RLS is genuinely restrictive; with no auth system yet, any RLS on `calls` would have to be permissive, which means the key would grant full read/write on all call history to anyone who obtains it — and Supabase's REST API is directly internet-reachable, independent of and invisible to `server.js`'s own logs. This is a materially bigger exposure than our own unauthenticated routes, since it bypasses the app entirely.

Critically, this is not blocked on Sprint 7's auth work. There are two separate questions: *who can reach the Supabase API at all* (solved now, by using service-role from a server that never exposes it to the browser) and *which rows a given logged-in household can see* (real per-row RLS, which does need Sprint 7). Locking down the first doesn't require the second to exist.

`contacts` was deliberately left alone this sprint — auditing/tightening its current policies wasn't asked for, and this project's own principle is to change only what's directly related to the sprint's objective.

## Impact

- `calls` cannot be read or written by anything holding only the anon key, including a leaked or guessed one.
- Requires a new `SUPABASE_SERVICE_ROLE_KEY` in `.env` (manual step — never committed, never logged, never sent to the browser).
- `contacts`' access model is unchanged and remains a known piece of technical debt (see `docs/PROJECT_STATUS.md`).
- Discovered during implementation: constructing the service-role client unconditionally throws synchronously and crashes the whole server if the key is absent — not just calls functionality. Fixed by constructing `supabaseAdmin` only when the key is present and having every calls-table helper fail open (return empty / log and continue) when it isn't, matching this codebase's existing fail-open convention.

---

# Decision 008

## Date

11 July 2026

## Decision

Use Twilio's `CallSid` as a unique idempotency key on `calls`, and write call records with `INSERT ... ON CONFLICT (call_sid) DO NOTHING` (via `supabase-js`'s `.upsert(..., { onConflict: "call_sid", ignoreDuplicates: true })`).

## Alternatives considered

- Plain `INSERT`, accepting possible duplicate rows on Twilio webhook retries
- `ON CONFLICT (call_sid) DO UPDATE` (overwrite the existing row on retry)

## Reason

Twilio may retry the `/process` webhook if it doesn't get a timely response; a retry represents the same call, not a legitimate change in outcome, and this app has no workflow that needs to revise an already-logged call. `DO UPDATE` was rejected because OpenAI's classification isn't perfectly deterministic call-to-call, so a retry could silently overwrite a correct first record with a different result. `DO NOTHING` gives a clean "first write wins" guarantee that matches actual intent: prevent duplicates, not enable revisions.

## Impact

- A Twilio retry can never produce two rows for the same call.
- `call_sid` is nullable-safe: Postgres does not treat two `NULL`s as conflicting, so a call somehow missing a `CallSid` still inserts normally, just without idempotency protection for that one row.

---

# Decision 009

## Date

11 July 2026

## Decision

Adopt a future commercial access model that separates three concerns: the service plan, the Stripe subscription/payment record, and a household's current right to use the service — via three future tables: `households` (replaces "customers" — the product protects a home line, not an individual), `subscriptions`, and `entitlements`. An optional future `plans` table is documented but deliberately not committed to.

This is a documentation-only decision. None of these tables are created in Sprint 6.

## Alternatives considered

- A single mutable "customer level" field representing current plan/status
- Treating every household (including complimentary/staff/founder access) as a real Stripe subscription, some at £0

## Reason

Home Call Guard needs to support standard paying households, founding/trial discounts, promotions, free trials, complimentary access (including non-paying households such as the founder's family), and future partner/staff accounts — without misrepresenting non-paying access as fake Stripe subscriptions, and without losing history every time a household's access changes (trial → paid → promotion, etc). A single mutable field can only ever describe the current state; separate `entitlements` rows preserve the full timeline, which matters for support, analytics, and dispute resolution.

`entitlements` fields: `id`, `household_id`, `entitlement_type` (`paid_subscription` / `free_trial` / `founding_offer` / `promotion` / `complimentary` / `partner` / `staff`), `status` (`scheduled` / `active` / `expired` / `revoked`), `starts_at`, `ends_at`, `source`, `external_reference`, `notes`, `created_at`, `created_by`, `updated_at`.

A `plans` table (subscriptions referencing plan rows instead of embedding `stripe_price_id` directly) was considered and documented, but not adopted now — this product currently has exactly one price point, and building a plans table for a single plan is premature abstraction. It should be built in Sprint 8 only if a genuine second tier or regional price is actually planned by then; otherwise `subscriptions.stripe_price_id` stays as a plain column.

## Impact (once implemented — not yet built)

- The app determines "is this household currently protected" by checking for an `entitlements` row where `status = 'active'` and `starts_at <= now()` and (`ends_at IS NULL` or `ends_at > now()`) — never by asking whether a Stripe subscription exists.
- Complimentary households (e.g. the founder's family) get an `entitlements` row with `source = 'admin_manual'`, no `external_reference`, and no `subscriptions` row at all.
- A founding-user discount is real Stripe billing (a coupon or discounted price on a genuine subscription) plus a parallel `entitlements` row with `source = 'stripe'` and `external_reference` pointing at the Stripe subscription ID, giving a durable internal label independent of Stripe's own price/plan bookkeeping.
- Promotions and free trials expire via `ends_at`, checked at read time (no batch job required for correctness); a periodic job to flip `status` to `expired` is a later, optional convenience for admin tooling.
- Scope split: `households` belongs in Sprint 7 (Household Identity). `entitlements`, `subscriptions`, and the conditional `plans` table belong in Sprint 8 (Payments & Entitlements) — the sprint's own name now settles what was previously an open question about whether `entitlements` should ship alongside `households` instead.