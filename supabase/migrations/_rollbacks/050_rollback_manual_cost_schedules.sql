-- Rollback for 050_manual_cost_schedules.sql.
-- STATUS: DRAFT — NOT APPLIED. Only meaningful if 050 was applied.
-- Drops the schedules table only. Any financial_entries rows already
-- posted from schedules (source_system = 'manual', entry_key
-- 'schedule:%') are ledger history and are deliberately NOT deleted here.
begin;
drop table if exists public.manual_cost_schedules;
commit;
