-- Adds the minimum evidence fields for the red-line termination
-- architecture (2026-08-15): a critical/red-line behaviour can now
-- trigger immediate call termination, independent of the 0-100
-- progressive score. These three columns record whether that happened,
-- not the transcript that caused it.
--
-- terminated_by_system: true only when Home Call Guard itself ended the
-- call via the bounded termination sequence (services/liveMonitoring/
-- callTermination.js) — never set for a call that ended normally.
--
-- termination_reason: a short, comma-joined list of critical signal
-- category IDs (e.g. "isolation_from_bank, isolation_from_family") —
-- same data-minimisation principle as the existing decision_reason
-- column (migration 001): never the transcript or the caller's actual
-- words.
--
-- terminated_at: when termination was recorded, stamped at persistence
-- time by database/calls.js's recordMonitoringOutcome.
--
-- STATUS: DRAFT — NOT APPLIED. Not run against staging or production as
-- part of this change.

begin;

alter table calls
  add column if not exists terminated_by_system boolean not null default false;

alter table calls
  add column if not exists termination_reason text;

alter table calls
  add column if not exists terminated_at timestamp with time zone;

commit;
