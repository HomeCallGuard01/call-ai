Home Call Guard

Document:
Project

Version:
0.6

Last Updated:
13 July 2026

Current Sprint:
Sprint 6 – Reliable Call History

Owner:
Andrew Deane

Status:
Active

# Home Call Guard

## Vision

Protect people from scam and nuisance calls using intelligent AI call screening.

---

## Current Version

v0.4 - Stripe onboarding build

---

## Current Branch

onboarding-stripe-build

---

## Sprint 1 - Complete

- GitHub repository created
- Working backup branch created
- Development branch created
- Stripe Sandbox created
- Home Call Guard £4.99/month product created
- VS Code development environment configured

---

## Sprint 2A - Architecture Blueprint

### Goal

Design the system before adding more code.

### Customer Journey

Website
↓
Start Protection
↓
Stripe Checkout
↓
Payment Successful
↓
Customer Account Created
↓
Add Mobile Number
↓
Add Trusted Contacts
↓
Enable Protection
↓
Run Test Call
↓
Dashboard Active

---

## Architecture v1

### Frontend

- Landing page
- Stripe checkout button
- Onboarding screens
- Customer dashboard
- Admin dashboard later

### Backend

- Node.js
- Express
- Routes split by feature

### Payments

- Stripe subscriptions
- £4.99/month
- Stripe customer linked to Home Call Guard user

### Database

Supabase recommended.

Tables required:

- users
- trusted_contacts
- calls
- weekly_reports
- subscriptions

### Calls

Twilio handles call routing and screening.

Customer does not see Twilio wording.

### AI

OpenAI reviews unknown caller transcript and returns:

- risk score
- category
- decision
- explanation

### Dashboard

Dashboard should answer:

"Am I protected?"

Key cards:

- Protection status
- Calls screened
- Calls blocked
- Trusted contacts
- Last screened call

---

## Sprint 2B - Deferred

Build Stripe Checkout integration.

Expected result:

Customer clicks Start Protection, pays £4.99/month, then lands on onboarding page.

Status: not yet built. Development took the dashboard/persistence track first (Sprints 4 and 6, see below) instead of continuing directly to Stripe. Detailed sprint-by-sprint status now lives in `docs/PROJECT_STATUS.md` — this file is the high-level roadmap, that one is the current state.

---

## Dashboard & Call History - Complete (Sprints 4 and 6)

Built cloud contact storage, a live customer dashboard, and persistent, idempotent call history — see `docs/PROJECT_STATUS.md` for full detail on each sprint.

Key outcome: the dashboard (`/dashboard`) is now backed entirely by Supabase (`contacts` and `calls` tables). No in-memory or local-file state remains for customer-facing data. `calls` is locked to server-only (service-role) access rather than the anon key `contacts` still uses — see `docs/DECISIONS.md` for why.

A future commercial access model (households, subscriptions, entitlements) has been designed and approved for later sprints but not built yet — documentation only, see `docs/DECISIONS.md`.

---

## Roadmap - Next

- Sprint 7: Household Identity (households table, auth, per-household RLS)
- Sprint 8: Payments & Entitlements (Stripe Checkout, deferred from Sprint 2B above)
- Sprint 9: Weekly Protection Reports
- Sprint 10: Customer Portal
- Sprint 11: Admin Console
- Sprint 12: Launch Candidate

---

## Rule

Do not develop directly on main.

Always commit working milestones to GitHub.