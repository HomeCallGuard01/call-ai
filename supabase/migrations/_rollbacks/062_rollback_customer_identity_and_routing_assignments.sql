-- ROLLBACK for 062_customer_identity_and_routing_assignments.sql
--
-- STATUS: DRAFT — NOT APPLIED. Renumber together with 062.
--
-- WARNING — read before running:
--   * This DROPS households.account_number, the account-number registry,
--     and all routing-assignment history. Export them first.
--   * Once any account number has been shown to a customer (dashboard,
--     email, support), DO NOT run this. Re-applying 062 afterwards would
--     restart the sequence and issue DIFFERENT numbers, breaking the
--     "permanent, never reassigned" guarantee. Instead, stop the consumers
--     (they all tolerate account_number being absent) and leave the
--     schema in place.
--   * The legacy Twilio columns and functions are untouched by 062, so
--     dropping the mirror triggers restores pre-062 behaviour exactly.

begin;

drop trigger if exists households_mirror_twilio_number on public.households;
drop trigger if exists twilio_quarantine_mirror on public.twilio_number_quarantine;
drop trigger if exists households_account_number_assign on public.households;
drop trigger if exists households_account_number_register on public.households;

drop function if exists public.backfill_routing_assignments_from_legacy();
drop function if exists public.twilio_quarantine_mirror();
drop function if exists public.households_mirror_twilio_number();
drop function if exists public.hcg_record_identity_anomaly(text, uuid, text, text);
drop function if exists public.routing_assignment_rollback_replacement(uuid, text, text);
drop function if exists public.routing_assignment_complete_port(uuid, text, text, text);
drop function if exists public.routing_assignment_make_primary(uuid, text, text);
drop function if exists public.routing_assignment_transition(uuid, text, text, text, text, text, text, text);
drop function if exists public.routing_assignment_create(uuid, text, text, text, text, text, text, text, uuid, text);
drop function if exists public.hcg_set_audit_context(text, text);

drop table if exists public.routing_assignment_events;
drop table if exists public.routing_assignments;
drop table if exists public.customer_identity_sync_anomalies;
drop table if exists public.telephony_providers;

drop function if exists public.routing_history_block_mutation();
drop function if exists public.routing_assignments_record_event();
drop function if exists public.routing_assignments_guard();
drop function if exists public.routing_assignment_transition_allowed(text, text, boolean);

drop table if exists public.hcg_account_numbers;
drop function if exists public.hcg_account_numbers_block_mutation();
drop function if exists public.backfill_household_account_numbers();
drop function if exists public.households_register_account_number();
drop function if exists public.households_assign_account_number();

alter table public.households drop constraint if exists households_account_number_format;
alter table public.households drop constraint if exists households_account_number_key;
alter table public.households drop column if exists account_number;

drop function if exists public.hcg_format_account_number(bigint);
drop function if exists public.hcg_account_check_digit(bigint);
drop sequence if exists public.hcg_account_serial_seq;

commit;
