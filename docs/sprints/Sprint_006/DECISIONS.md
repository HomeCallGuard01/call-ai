Document: Sprint 6 – Reliable Call History — Decisions
Version: 1.0
Last Updated: 2026-07-14
Status: Complete
Owner: Andrew Deane
Related Sprint(s): Sprint 6

---

# Sprint 6 – Reliable Call History — Decisions

`docs/DECISIONS.md` Decisions 005–009, all dated 10–11 July 2026:
- Decision 005: add `calls` table, remove in-memory `callLogs`
- Decision 006: write call log entries without awaiting the insert
- Decision 007: access `calls` only via service-role, zero anon/authenticated
  RLS policies (contacts left unchanged, deliberately not mirrored)
- Decision 008: use `call_sid` as an idempotency key, `DO NOTHING` on conflict
- Decision 009: entitlement architecture (households/subscriptions/entitlements)
  designed and approved as documentation only — not built this sprint
