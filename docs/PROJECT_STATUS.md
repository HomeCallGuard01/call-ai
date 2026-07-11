# Home Call Guard – Project Status

## Current Status

**Project:** Home Call Guard

**Version:** v0.6 Pre-MVP

**Overall Status:** 🟢 Healthy

**Current Sprint:** None in progress — Sprint 7 (Household Identity) not yet started

**Date Updated:** July 2026

---

# Vision

Protect every household from scam and nuisance calls without changing how they use their home phone.

Our mission is to deliver peace of mind through intelligent call screening, trusted contact management and simple, reassuring customer experiences.

---

# Completed Sprints

## ✅ Sprint 1 – Foundation

Completed:

- Node.js backend
- Express server
- Twilio integration
- OpenAI integration
- Local development environment
- Git repository

---

## ✅ Sprint 2 – AI Screening

Completed:

- AI call classification
- Keyword scam detection
- Trusted caller bypass
- Safe caller routing
- Scam call blocking

---

## ✅ Sprint 3 – Contact Protection

Completed:

- CSV upload
- Contact parsing
- Supabase integration
- Trusted contact storage
- Known caller identification

---

## ✅ Sprint 4 – Dashboard MVP

Completed:

- Converted the static `/dashboard` demo into a live page reading from `GET /dashboard-data`
- Protection status hero, 4 live stat cards (protected contacts, calls today, blocked, safe)
- Recent activity list with a calm empty state, no fake/demo rows
- Calm on-page error handling if `/dashboard-data` fails to load
- CSV upload form kept working, unchanged
- Mobile responsive, accessible contrast and font sizes

---

## ✅ Sprint 5 – Dashboard Experience

Completed:

- Protection status made dynamic (loading / protected / status-unavailable) instead of a hardcoded "Protected"
- Removed the non-functional sidebar navigation entirely; replaced with a simple top header (logo, "Home Call Guard", "Protection Dashboard" subtitle)
- Refresh interval tuned to 15 seconds
- Empty-activity wording consolidated to one consistent message (previously duplicated/inconsistent between the static markup and the JS render path)
- Larger, more visible pulsing shield; larger, precisely cropped header logo

---

## ✅ Sprint 6 – Reliable Call History

### Objective

Persist genuine call activity in Supabase so dashboard statistics and recent activity survive server restarts.

### What was built

- New `calls` table in Supabase (`supabase/migrations/001_create_calls_table.sql`): `id`, `household_id` (nullable, unused until Sprint 7), `call_sid` (unique), `number`, `status`, `result`, `decision_reason`, `risk_score`, `processing_time_ms`, `call_duration`, `ai_model`, `created_at`. Check constraints on `status`, `result`, `risk_score` range, and non-negative `processing_time_ms`/`call_duration`.
- Removed the in-memory `callLogs` array from `server.js` entirely.
- `/process` writes every screened call via `logCall()`, fired without blocking the Twilio response (avoids adding database latency to a live call).
- **Idempotency:** `logCall()` upserts on `call_sid` with `ignoreDuplicates: true` (`INSERT ... ON CONFLICT (call_sid) DO NOTHING`), so a Twilio webhook retry cannot create a duplicate call record.
- **Populated this sprint:** `call_sid` (from Twilio's `CallSid`), `ai_model` (captured only when the OpenAI classification branch actually runs), `processing_time_ms` (wall-clock time spent in `/process`).
- **Left null this sprint (by design):** `decision_reason` and `risk_score` (need an AI prompt change, out of scope), `call_duration` (needs a separate Twilio `statusCallback` webhook that doesn't exist yet), `household_id` (needs Sprint 7's `households` table).
- `/dashboard-data` computes `protectedContacts`, `callsToday`, `blocked`, `safe`, `recentCalls` from live Supabase queries.
- `/logs` also reads from Supabase (capped at the most recent 200 rows) instead of the deleted array.
- Dashboard data now survives server restarts.
- **Security:** `calls` has RLS enabled with no `anon`/`authenticated` policies at all (default-deny). It's reachable only through a `service_role`-backed client (`supabaseAdmin` in `server.js`), used exclusively for `calls` operations. `contacts` is unchanged — it still uses the existing anon-key client. Full reasoning in `docs/DECISIONS.md` (Decisions 007–008).
- **Verified during implementation:** the initial design constructed the service-role Supabase client unconditionally, which throws synchronously and crashes the entire server (not just call logging) if `SUPABASE_SERVICE_ROLE_KEY` is unset. Fixed before shipping — the client is now constructed only when the key is present, and every calls-table helper checks for it and fails open (empty data / logged error), matching the fail-open pattern already used everywhere else in this file.
- Empty recent-activity state: "No recent call activity yet."

### Documentation-only work produced alongside this sprint (not built)

A future commercial access model was designed and approved for later sprints: `households` (replaces the earlier "customers" naming — the product protects a home line, not an individual), `subscriptions`, an optional future `plans` table (conditional on a genuine second pricing tier existing), and an `entitlements` table that separates *service plan* from *Stripe payment record* from *current right to use the service* — covering standard paying households, founding/trial discounts, promotions, free trials, complimentary access (including non-paying households), and future partner/staff accounts. See `docs/DECISIONS.md` (Decision 009) for the full design and reasoning.

### Manual action still required

Run `supabase/migrations/001_create_calls_table.sql` in the Supabase SQL Editor, then add `SUPABASE_SERVICE_ROLE_KEY` to `.env` (Project Settings → API in Supabase) and restart the server. Neither step has been performed yet — this file only reflects code that is ready to run once both are done.

### Success criteria

- Restart server → dashboard still shows previous calls: **pending manual migration + key**
- Recent activity remains available: **pending manual migration + key**
- Statistics generated from database: **pending manual migration + key**
- No functionality lost: **confirmed** — server starts cleanly and every other route works whether or not the service-role key is present

---

# Planned Roadmap

## Sprint 7 – Household Identity

Introduce household records, ownership, and authentication.

Deliverables:

- `households` table (see Decision 009)
- `contacts.household_id` / `calls.household_id` backfilled, FK-constrained, then `NOT NULL`
- Supabase Auth wiring (`auth_user_id`)
- Real per-row RLS on `contacts`/`calls` keyed on `auth.uid()`

---

## Sprint 8 – Payments & Entitlements

Deliverables:

- `subscriptions` table
- `entitlements` table (see Decision 009)
- Stripe Checkout, £4.99 subscription, webhook handling
- Automatic `paid_subscription`/`founding_offer` entitlement creation from Stripe events
- Conditional `plans` table — only if a genuine second tier or regional price is planned by this point

---

## Sprint 9 – Weekly Protection Reports

Deliverables:

- Weekly email summary
- Scam statistics
- Trusted caller summary
- Protection score

---

## Sprint 10 – Customer Portal

Deliverables:

- Authentication-backed login
- Personal dashboard, secure household isolation, profile page
- Add / edit / delete / search contacts
- Settings

---

## Sprint 11 – Admin Console

Deliverables:

- Household management
- Revenue dashboard
- System monitoring
- Support tools

---

## Sprint 12 – Launch Candidate

Deliverables:

- Production deployment
- Marketing launch
- Customer onboarding
- First 100 paying households

---

# Current Technical Debt

- No authentication
- No household ownership (`household_id` columns exist but are nullable/unenforced)
- `contacts` table still relies on permissive anon-key RLS; `calls` now uses the stricter service-role pattern but `contacts` hasn't been aligned to match yet
- No Stripe integration
- No weekly reports
- Debug routes still exist (`/test-db`, `/test-get-contacts`)
- Some repository cleanup required

---

# Business Goal

Launch a reliable consumer SaaS product protecting home phone users from scam calls.

Target subscription:

**£4.99/month**

Primary focus:

Deliver outstanding customer value, scale rapidly, and build a business that is attractive for acquisition while remaining robust enough to operate independently.

---

# Next Immediate Actions

1. Run `supabase/migrations/001_create_calls_table.sql` in Supabase
2. Add `SUPABASE_SERVICE_ROLE_KEY` to `.env` and restart the server
3. Confirm dashboard statistics/recent activity survive a real restart
4. Commit Sprint 6
5. Design Sprint 7 (Household Identity)
