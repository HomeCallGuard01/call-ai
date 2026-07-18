Document: Sprint History Index
Version: 3.0
Last Updated: 2026-07-14
Status: Active
Owner: Andrew Deane
Related Sprint(s): All

---

# Sprint History

Standard layout: each sprint gets its own `docs/sprints/Sprint_NNN/`
folder containing four files — `README.md` (objective, scope, outcome,
next steps), `WORKLOG.md` (work completed, files changed, database
changes), `DECISIONS.md`, and `VERIFICATION.md` (verification status,
outstanding tests). Every `README.md` links to its own three siblings.

Sprints 001, 002, 003, 005, 006, and 007 were reconstructed from git
history, migration files, commits, and `docs/PROJECT_STATUS.md` /
`docs/DECISIONS.md` — not from memory or inference. Where the available
evidence didn't support a claim, the relevant file says so explicitly
("Historical details incomplete – to be reconstructed later" or
"Unknown") rather than guessing.

| Sprint | Title | Description | Status | Date |
|---|---|---|---|---|
| 001 | Foundation | Node.js/Express backend, Twilio and OpenAI integration, local dev environment, git repository | Complete | Unknown (earliest commits ~2026-06-19, not confirmed as this sprint's exact boundary) |
| 002 | AI Screening | AI call classification, keyword scam detection, trusted caller bypass, scam call blocking | Complete | Unknown (commits ~2026-06-23–25, not confirmed) |
| 003 | Contact Protection | CSV upload, contact parsing, Supabase integration, trusted contact storage, known caller identification | Complete | Unknown (commits ~2026-06-24–25, not confirmed) |
| 004 | *(see conflict note below)* | Supabase cloud backend adoption, contacts table, CSV upload, RLS | Complete | Unknown |
| 005 | Dashboard Experience | Dynamic protection status, live stats/activity with 15s refresh, header redesign | Complete | 2026-07-10 (commit `5882708`) |
| 006 | Reliable Call History | Persistent `calls` table, idempotent Twilio logging, service-role access model | Complete | 2026-07-11 (commit `dcee78e`) |
| 007 | Household Identity | `households`/`user_roles` tables, ownership columns/FKs, default-household backfill, draft per-household RLS (frozen) | Complete | Unknown exact date; confirmed applied before Sprint 8 began (July 2026) |
| 008 | Customer Registration & Authentication (Least-Privilege) | Registration/login flow, least-privilege household/role self-service via RLS + grants (Migrations 006–007) | In Progress | 2026-07-13 to 2026-07-14 (ongoing) |
| 009 | Complete Household Isolation | Contacts RLS (Migration 008), least-privilege service_role grants (Migration 009), household-scoped dashboard/contacts/calls throughout `server.js` | Complete | 2026-07-14 |

Descriptions for 001–003, 005–007 are taken from `docs/PROJECT_STATUS.md`'s
own "Completed Sprints" section, the most detailed and internally dated
source found. This superseded an older, less reliable index whose
descriptions for Sprint 5 ("Authentication UI") and Sprint 6 ("Password
reset") were checked against commits `5882708` and `dcee78e` respectively
and found to be **incorrect** — corrected above.

## Known unresolved conflicts in the historical record

**Sprint 4 — two different, irreconcilable descriptions exist**, and
neither has been edited to fix this (`Sprint_004/README.md` is kept
intact per instruction):
- The existing `Sprint_004/README.md` (migrated from the original
  `SPRINT_004_Contacts.md`) describes connecting to a cloud backend:
  Supabase adoption, environment variables, contacts table, CSV upload, RLS.
- `docs/PROJECT_STATUS.md`'s own "Sprint 4 – Dashboard MVP" section
  describes something else entirely: converting the static `/dashboard`
  demo into a live page reading from `GET /dashboard-data`.
- Thematically, `Sprint_004/README.md`'s actual content is a much closer
  match to what `docs/PROJECT_STATUS.md` calls "Sprint 3 – Contact
  Protection" than to its own "Sprint 4."
- Flagged, not resolved. Reconciling it would require judgment calls
  beyond what's directly recoverable from the available records.

**`PROJECT.md` contains an entirely different sprint narrative** for its
early numbering (Sprint 1: repo/branch/Stripe-sandbox/VS Code setup;
Sprint 2A: Architecture Blueprint; Sprint 2B: Stripe Checkout, deferred) —
this does not match `docs/PROJECT_STATUS.md`'s Sprint 1 ("Foundation") or
Sprint 2 ("AI Screening") at all. `PROJECT.md` resolves this itself, in
its own text: *"Detailed sprint-by-sprint status now lives in
`docs/PROJECT_STATUS.md` — this file is the high-level roadmap, that one
is the current state."* On that basis, `docs/PROJECT_STATUS.md` was
treated as authoritative above, and `PROJECT.md`'s differing narrative
was not used.

**A stray, untracked file, `docs/sprints/READMEmd`,** contains personal
working notes (not authored by the assistant) asserting Sprint 8 is fully
verified end-to-end, including database verification. That claim is
**not corroborated** by anything shared back into the conversation this
documentation set was built from — see `Sprint_008/VERIFICATION.md` for
the evidence-graded account of what's actually confirmed. Not merged or
deleted; flagged for your attention.
