Document: Documentation Map
Version: 1.0
Last Updated: 2026-07-14
Status: Active
Owner: Andrew Deane
Related Sprint(s): N/A — entry point for all documentation

---

# Home Call Guard — Documentation Map

**Start here:** [`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md) is the
entry point for the whole repository — a concise summary intended to
bring a new engineer, investor, or due diligence reviewer up to speed in
about five minutes. This file is the detailed map beneath it: every
document listed below now carries a consistent header (`Document`,
`Version`, `Last Updated`, `Status`, `Owner`, `Related Sprint(s)`) so its
purpose and currency are clear without opening the file.

## Architecture

- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — system overview, customer
  flow, data flow, folder structure, security principles, MVP decisions.

## Launch

- [`docs/launch/FINAL_ACCEPTANCE_REPORT.md`](launch/FINAL_ACCEPTANCE_REPORT.md) —
  Launch Polish Sprint scope, changes, and a full end-to-end UAT run
  against a real customer account (no auth bypass, no mocked data).
- [`docs/launch/KNOWN_ISSUES.md`](launch/KNOWN_ISSUES.md) — pre-launch
  issues by severity; the former Severity 1 blocker (no Twilio number
  ever assigned to a new customer) is verified reaching Twilio's real
  API, pending a registered-address decision before a number can
  actually be purchased.
- [`docs/launch/TWILIO_NUMBER_LIFECYCLE.md`](launch/TWILIO_NUMBER_LIFECYCLE.md) —
  the full number lifecycle: automatic provisioning on payment, a 30-day
  grace period on cancellation vs. immediate release on account deletion,
  and why.
- [`docs/engineering/016_017_migration_incident_notes.md`](engineering/016_017_migration_incident_notes.md) —
  working notes from a real incident applying migrations 016/017: a
  bundled transaction that reported success while changing nothing, the
  staged repair that actually worked, and a real PL/pgSQL bug it
  surfaced.
- [`docs/launch/POST_LAUNCH_ROADMAP.md`](launch/POST_LAUNCH_ROADMAP.md) —
  scheduling for the above, cross-referenced to the pre-existing
  `docs/ENGINEERING_ROADMAP.md` rather than duplicating it.
- [`docs/launch/LAUNCH_DAY.md`](launch/LAUNCH_DAY.md) — the launch-day
  runbook: Stripe test→live switch, required env vars, deploy, smoke
  test, rollback.
- [`docs/business/`](business/) — commercial strategy (marketing plan,
  KPIs, acquisition readiness, operations). Not yet written — deferred
  until commercial strategy is worked through.

## Engineering

- [`PROJECT.md`](../PROJECT.md) — high-level roadmap (root of the repo).
  Explicitly defers to `docs/PROJECT_STATUS.md` for sprint-by-sprint detail.
- [`docs/PROJECT_STATUS.md`](PROJECT_STATUS.md) — current status and the
  "Completed Sprints" summary this documentation set's Sprint 1–6
  reconstructions were built from.
- [`docs/DECISIONS.md`](DECISIONS.md) — numbered engineering/business
  decisions, now cross-referenced to the sprint each was made in.
- [`docs/ENGINEERING_PRINCIPLES.md`](ENGINEERING_PRINCIPLES.md) — general
  principles, not tied to any one sprint.
- [`docs/ENGINEERING_ROADMAP.md`](ENGINEERING_ROADMAP.md) — deferred
  post-MVP work (password policy, security testing, repository hygiene).
- [`docs/AI_AGENT_GUIDE`](AI_AGENT_GUIDE) — working rules for AI agents
  contributing to this codebase.

## Database

No single dedicated database document exists yet. The database schema
lives in `supabase/migrations/` (numbered, chronological, each with its
own header comment stating purpose and status — e.g. `STATUS: APPLIED AND
VERIFIED` or `STATUS: REVIEWED DRAFT — NOT APPLIED`). Schema changes are
also described in the `WORKLOG.md`/`DECISIONS.md` of whichever sprint
introduced them — see Sprint History below, particularly Sprint 6
(`calls` table), Sprint 7 (`households`/`user_roles`), and Sprint 8
(least-privilege grants/RLS).

## Sprint History

- [`docs/sprints/README.md`](sprints/README.md) — the master index: every
  sprint, its title, description, status, and date (where known), plus a
  record of conflicts found in the historical record.
- `docs/sprints/Sprint_NNN/` — one folder per sprint, each containing
  `README.md` (objective/scope/outcome/next steps), `WORKLOG.md`,
  `DECISIONS.md`, and `VERIFICATION.md`.

## Due Diligence

- [`docs/due_diligence/DUE_DILIGENCE/`](due_diligence/DUE_DILIGENCE/) —
  15 numbered documents (Executive Summary, Product Vision, Architecture,
  Security, Data Flow, Third Party Services, API Keys, Deployment, Risks,
  Exit Strategy, Roadmap, IP, Cost Model, Customers, Metrics). Several of
  these are currently empty placeholders — see Documentation Improvement
  Recommendations below.

## API

No API reference document exists yet. `docs/api/` exists as an empty
placeholder directory.

## Security (future)

No dedicated security document exists yet. Security-relevant content is
currently split across `docs/ENGINEERING_ROADMAP.md` (password policy,
security testing checklist) and `docs/DECISIONS.md`'s "Decision 010"
(overlapping content — see recommendations below), plus RLS/grant
decisions recorded per-sprint (notably Sprint 6, 7, 8).

---

# Documentation Improvement Recommendations

Found while building this documentation map. Nothing below has been
acted on — no files were deleted, merged, renamed, or archived as part of
this review. These are suggestions for future tidy-up work.

1. **Sprint 4 has two conflicting descriptions.** `Sprint_004/README.md`
   describes Supabase/contacts/CSV/RLS work; `docs/PROJECT_STATUS.md`'s
   own "Sprint 4 – Dashboard MVP" describes converting the static
   dashboard to live data instead. Thematically, `Sprint_004/README.md`'s
   content is a closer match to what `docs/PROJECT_STATUS.md` calls
   "Sprint 3." Needs a human decision to reconcile — recorded, not fixed
   (see `docs/sprints/README.md`).

2. **`PROJECT.md` and `docs/PROJECT_STATUS.md` tell two different early
   sprint stories** (Sprint 1/2A/2B vs. Sprint 1/2/3). `PROJECT.md`
   already declares `docs/PROJECT_STATUS.md` authoritative for
   sprint-by-sprint detail in its own text, so this isn't a true conflict
   requiring adjudication — but the two files could be more explicit about
   which numbering scheme is historical/superseded.

3. **`docs/DECISIONS.md` has duplicate decision numbering.** Two entries
   are both labelled "Decision 001" (one for choosing Supabase, one for
   replacing `contacts.json`). Worth renumbering for clarity.

4. **`docs/DECISIONS.md`'s "Decision 010" and `docs/ENGINEERING_ROADMAP.md`
   substantially duplicate each other** — both cover password policy,
   password generation, the eye-icon toggle, password manager
   compatibility, future authentication methods (passkeys, SSO), and
   security testing. Candidate for merging into a single source, likely
   `docs/ENGINEERING_ROADMAP.md` since it's the more structured of the two.

5. **`docs/sprints/READMEmd`** — a stray, untracked file (no `.md`
   extension) duplicating the sprint index, containing personal working
   notes that assert Sprint 8 is fully verified. That assertion isn't
   corroborated by anything shared back in the conversation this
   documentation was built from (see `Sprint_008/VERIFICATION.md`).
   Needs a decision: fold verified parts into `Sprint_008/VERIFICATION.md`
   once actually confirmed, then remove the stray file.

6. **Four empty placeholder directories**: `docs/api/`, `docs/archive/`,
   `docs/images/`, `docs/sql-history/`. No content, no README explaining
   intended use. Either populate with a purpose statement or remove until
   needed.

7. **`docs/AI_AGENT_GUIDE` has no file extension**, inconsistent with
   every other document in `docs/` (all `.md`). Consider renaming to
   `docs/AI_AGENT_GUIDE.md`.

8. **Several `docs/due_diligence/DUE_DILIGENCE/*.md` files are empty**
   (confirmed empty during the earlier repository-cleanup pass — e.g.
   "07 API Keys.md" was found to be a single blank line). Worth an
   inventory pass to identify which of the 15 are real content vs.
   unfilled placeholders.

9. **Known runtime issues not yet tracked in any roadmap/known-issues
   document**: `SUPABASE CALLS READ ERROR: Invalid API key` (the `calls`
   table's service-role key, flagged in `Sprint_006/VERIFICATION.md`) and
   `permission denied for table contacts` (observed during Sprint 8
   testing, not yet investigated). Both are currently only mentioned
   inline in sprint verification notes, not centrally tracked the way the
   `node_modules` git-tracking issue was added to
   `docs/ENGINEERING_ROADMAP.md`'s "Repository Hygiene" section.

10. **Nested naming redundancy**: `docs/due_diligence/DUE_DILIGENCE/` —
    lowercase parent folder containing an uppercase-named subfolder with
    the same conceptual name. Cosmetic; consider flattening.
