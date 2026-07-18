Document: Project Overview
Version: 1.0
Last Updated: 2026-07-14
Status: Active
Owner: Andrew Deane
Related Sprint(s): All — this is the entry point for the entire repository

---

# Home Call Guard

## Executive Summary

Home Call Guard is a phone protection service for households. It screens
incoming calls to a home phone line, automatically lets known and trusted
callers through, and checks unknown callers before they can reach anyone
in the house — blocking likely scam or nuisance calls and warning the
household about them.

The problem it solves: scam phone calls disproportionately target older
and more vulnerable people, and existing call-blocking apps are built for
tech-confident smartphone users, not for someone who just wants their
home phone to keep working the way it always has.

The target customer is a household — often protecting an elderly parent
or relative — who wants that protection without having to learn new
technology, change their phone number, or manage complicated settings.

What makes it different: it works invisibly, at the phone-line level,
rather than requiring an app on the call recipient's phone. Setup is done
once, by the household, on the household's behalf — not by the person
being protected.

## Vision

Home Call Guard is intended to be:

- A consumer-first security product, not a technical tool
- Protection specifically for people vulnerable to scam and nuisance
  calls, delivered without requiring technical understanding from them
- Simple to onboard: add trusted contacts, enable protection, done
- A subscription-based SaaS business (currently £4.99/month)
- Built to scale from a handful of households to thousands
- Built to withstand technical and business due diligence
- Designed with a future acquisition as a realistic outcome, not an
  afterthought

## Current MVP

Only functionality that has actually been built and is present in the
codebase is listed here.

- **Customer registration** — Supabase Auth-based sign-up, with required
  email confirmation.
- **Login** — session-based login using Supabase Auth.
- **Password reset** — a request/confirm email flow is implemented.
- **Secure authentication** — least-privilege design: the registration
  and login flow creates each customer's household and role record using
  only that customer's own authenticated session, never a privileged
  service-role key.
- **Household model** — every customer is represented by a household
  record, which contacts and calls belong to.
- **Contact management** — households can upload trusted contacts via
  CSV; known contacts bypass call screening.
- **Dashboard** — a live dashboard showing protection status, contact and
  call statistics, and recent call activity, backed by the database
  rather than static or in-memory data.
- **Call history** — every screened call is persisted, with safeguards
  against duplicate records from webhook retries.
- **Stripe integration (current status)** — not yet implemented. A Stripe
  sandbox and product have been configured, but checkout/payment
  processing is not built.
- **Twilio integration (current status)** — implemented and functioning.
  Twilio handles inbound call routing; unknown callers are prompted for a
  reason for calling, which is screened by keyword rules and, where
  needed, an AI classification step.

## High Level Architecture

At a high level, the system is a Node.js/Express backend that sits
between Twilio (which handles the phone call itself), Supabase (which
provides the database and authentication), Stripe (payments, not yet
integrated), and OpenAI (which classifies ambiguous call transcripts as
safe or suspicious). The frontend is server-rendered HTML/CSS/JavaScript
— there is no separate single-page application framework.

- **Frontend** — plain HTML pages served by the backend (registration,
  login, password reset, dashboard).
- **Backend** — Node.js with Express, handling Twilio webhooks, the
  dashboard API, and authentication routes.
- **Supabase** — hosted PostgreSQL plus authentication (Supabase Auth).
- **Twilio** — inbound call handling and call routing.
- **Stripe** — payment processing (planned; not yet integrated).
- **OpenAI** — call transcript classification for calls that keyword
  rules can't confidently resolve.
- **Database** — PostgreSQL via Supabase, with Row Level Security
  enabled on customer-facing tables.
- **Authentication** — Supabase Auth (email/password), with
  httpOnly-cookie session handling on the backend.
- **Security** — layered: Row Level Security policies, explicit table
  grants, and service-role access reserved for the one table (`calls`)
  that deliberately has no direct customer-facing policy at all.

Full detail: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Engineering Principles

The project follows a consistent set of principles, applied throughout
rather than added retroactively:

- **Least privilege** — customer-facing flows use the customer's own
  authenticated session wherever possible; service-role access is
  reserved for the narrow cases that genuinely require it.
- **Security first** — Row Level Security and environment-variable
  secrets were adopted from the earliest decisions in the project, not
  introduced later.
- **Simplicity** — the simpler of two working solutions is preferred over
  the more elaborate one.
- **Maintainability** — code and schema changes are kept small and
  reviewable; premature abstraction is avoided.
- **Evidence before assumptions** — technical claims (e.g. why an error
  occurs, whether a fix works) are verified against logs, queries, or
  direct tests before being acted on, rather than assumed.
- **Incremental development** — work proceeds sprint by sprint, each with
  a defined, bounded goal.
- **Documentation alongside development** — every sprint is documented
  (objective, work completed, decisions, verification) as part of the
  work, not after the fact.
- **Git discipline** — deliberate commits, backup branches before risky
  reorganisation, and a preference for reviewing changes before applying
  them.
- **No hardcoded secrets** — all credentials are environment variables,
  excluded from version control.
- **Production-ready mindset** — features are built to the standard of
  something real customers will use, not throwaway prototypes.

Full detail: [`ENGINEERING_PRINCIPLES.md`](ENGINEERING_PRINCIPLES.md).

## Repository Structure

```
docs/         Documentation — architecture, decisions, principles,
              roadmap, sprint history, due diligence, project status
database/     Data-access helper modules (households, contacts)
public/       Static frontend pages (registration, login, password reset)
services/     Shared service clients (Supabase client construction, phone
              number normalisation)
middleware/   Express middleware (session/auth handling)
supabase/     Database migrations (numbered, chronological, each with a
              status header)
server.js     Main application entry point and route definitions
```

Sprint-by-sprint detail for how this structure came to be, including
which files each sprint touched, is in
[`docs/sprints/`](sprints/README.md).

## Current Project Status

**Completed:** Sprints 1 through 7 — backend/Twilio/OpenAI foundation, AI
call screening, contact protection, the live dashboard, persistent call
history, and the household/role data model.

**In progress:** Sprint 8 — customer registration and authentication,
built on a least-privilege model. Registration, login, household
creation, and role creation are confirmed working end to end via direct
testing. Two items remain open before this sprint closes: diagnosing why
a confirmation email wasn't received in one test, and recording formal
database-level verification of the created rows.

**Next priorities:** close out the remaining Sprint 8 verification items,
then proceed to the features described in Future Roadmap below.

Full detail: [`PROJECT_STATUS.md`](PROJECT_STATUS.md).

## Technology Stack

- Node.js
- Express
- Supabase
- PostgreSQL
- Twilio
- Stripe (configured; not yet integrated into the application)
- OpenAI
- HTML / CSS / JavaScript
- GitHub
- VS Code

## Security Model

- **Authentication** — Supabase Auth, email/password, with required email
  confirmation.
- **Row Level Security (RLS)** — enabled on customer-facing tables;
  policies scope each customer to their own data via `auth.uid()`.
- **Least privilege** — the registration/login flow was deliberately
  built to avoid the service-role key entirely, using narrowly-scoped
  database grants and RLS policies instead.
- **Service-role isolation** — where service-role access is used (the
  `calls` table), it is isolated to that specific table, with RLS
  enabled and zero customer-facing policies on it.
- **Environment variables** — all credentials (database, Twilio, OpenAI)
  are environment variables, excluded from version control.
- **Password reset** — implemented as a request/confirm email flow.
- **Secure session handling** — sessions are held in httpOnly cookies,
  not exposed to frontend JavaScript.

Full detail and the reasoning behind specific security decisions:
[`DECISIONS.md`](DECISIONS.md), and the per-sprint `DECISIONS.md`/
`VERIFICATION.md` files under [`docs/sprints/`](sprints/README.md),
particularly Sprint 7 and Sprint 8.

## Documentation Guide

- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Engineering Principles: [`ENGINEERING_PRINCIPLES.md`](ENGINEERING_PRINCIPLES.md)
- Engineering Roadmap: [`ENGINEERING_ROADMAP.md`](ENGINEERING_ROADMAP.md)
- Sprint History: [`sprints/README.md`](sprints/README.md)
- Database Documentation: schema lives in `supabase/migrations/`; narrative
  detail is in each sprint's `WORKLOG.md`/`DECISIONS.md` under
  [`docs/sprints/`](sprints/README.md)
- Due Diligence: [`due_diligence/DUE_DILIGENCE/`](due_diligence/DUE_DILIGENCE/)
- Decision Log: [`DECISIONS.md`](DECISIONS.md)
- Project Status: [`PROJECT_STATUS.md`](PROJECT_STATUS.md)
- Full documentation map (all of the above, with descriptions):
  [`README.md`](README.md)

## Future Roadmap

Only work that is actually documented elsewhere as planned is listed here.

- Stripe Checkout and payment processing (configured but not yet built)
- Weekly protection reports
- A customer-facing portal
- An admin console
- Launch-candidate hardening pass
- Password policy, password generation, password-manager compatibility,
  and future authentication methods (passkeys, SSO) — see
  [`ENGINEERING_ROADMAP.md`](ENGINEERING_ROADMAP.md)
- Pre-launch security testing (rate limiting, session timeout, account
  enumeration, penetration testing) — see
  [`ENGINEERING_ROADMAP.md`](ENGINEERING_ROADMAP.md)
- Real per-household Row Level Security on `contacts`/`calls` (currently
  a reviewed, unapplied migration draft) — see Sprint 7's documentation

Full detail: [`PROJECT_STATUS.md`](PROJECT_STATUS.md)'s planned roadmap
section.

## Design Goals

- Simple for customers
- Secure by default
- Easy to maintain
- Easy to scale
- Audit friendly
- Acquisition ready

## Final Notes

This repository is intended to provide a complete engineering record of
Home Call Guard from initial concept through to production. All
significant architectural decisions, verification evidence, sprint
history, and technical documentation are maintained alongside the source
code to support long-term maintenance, collaboration, and future
technical due diligence.
