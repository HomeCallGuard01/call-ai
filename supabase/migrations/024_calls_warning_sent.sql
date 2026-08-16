-- Adds calls.warning_sent, the one new column needed to answer "was a
-- customer warning issued for this call" after the fact.
--
-- Part of restoring the progressive live-monitoring system (selectively
-- ported from sandbox/v1.5-live-monitoring, 2026-08-11): calls.risk_score
-- and calls.decision_reason already exist (migration 001) but have never
-- been populated by any code path. This migration adds the one field
-- those two didn't already cover. Deliberately minimal — no transcript or
-- audio column is added, by design (data minimisation): decision_reason
-- is populated with short signal-category IDs (e.g.
-- "urgency_or_threat, payment_or_transfer_request"), never the caller's
-- actual words.
--
-- STATUS: DRAFT — NOT APPLIED. Not run against staging or production as
-- part of this change. database/calls.js's recordMonitoringOutcome fails
-- closed (logs and continues, never affects the live call) until this is
-- applied — see its own comment for detail.

begin;

alter table calls
  add column if not exists warning_sent boolean not null default false;

commit;
