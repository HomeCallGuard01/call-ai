-- Durable, append-only evidence that a customer actively agreed to the
-- Terms & Conditions and acknowledged the Privacy Policy before paying.
-- Closes a real gap found during the carrier-onboarding-gate audit: this
-- codebase had a Terms/Privacy link on the Subscribe screen but recorded
-- no evidence anywhere that anyone had actually read or agreed to them —
-- a single overwritable households column would let a later re-acceptance
-- (or a bug) silently erase the record of what a customer agreed to and
-- when, which defeats the purpose of keeping evidence at all. A separate
-- append-only table means every acceptance is preserved permanently,
-- including if the customer accepts again later (e.g. re-subscribing
-- after cancelling, or a materially updated Terms version).
--
-- STATUS: DRAFT — NOT APPLIED.
--
-- Renumbered 029 → 039 (2026-09-13, canonical-release-base reconciliation):
-- the carrier-onboarding-gate work was originally authored against a
-- branch whose migration history stopped at 027, and picked the next
-- two free numbers (028/029) without knowing that origin/main's own
-- lineage — via PR #24 and the p0-batch1-carrier-policy-quarantine
-- branch — had already claimed 028 (household_self_protecting), 029
-- (anonymize_household_deletes_contacts_and_calls), and, crucially, 038
-- for the functionally-identical household_carrier_compatibility
-- migration this one depends on. This file is the only genuinely new
-- migration from that work once reconciled against the correct lineage
-- — the carrier-compatibility migration itself was dropped as a
-- duplicate of the existing 038. See the release-lineage reconciliation
-- analysis (2026-09-13) for the full migration table.
--
-- Deliberately minimal — no device fingerprinting, IP address, or other
-- personal data beyond what's already collected elsewhere in this app.
-- household_id is enough to identify who accepted; accepted_at + the two
-- version strings are enough to prove what they agreed to and when.
--
-- terms_version/privacy_version are free-text, not foreign keys to a
-- versioned-documents table — this app's Terms/Privacy are static HTML
-- files (public/terms.html, public/privacy.html) with no existing
-- versioning mechanism. Version constants live in application code
-- (services/legalVersions.js) and must be bumped by hand whenever either
-- document materially changes, mirroring this codebase's established
-- "single source of truth in application code, not SQL" pattern already
-- used for provider/landline data (see providerPolicy.js).
--
-- acceptance_type exists so this table can hold more than one kind of
-- consent record in future (today, only 'subscription_terms' — the
-- combined Terms+Privacy acknowledgement shown before purchase) without
-- a schema change; it is deliberately free-text for the same reason
-- carrier_provider_key is in migration 028.

begin;

create table if not exists public.terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  acceptance_type text not null default 'subscription_terms',
  terms_version text not null,
  privacy_version text not null,
  accepted_at timestamptz not null default now()
);

create index if not exists terms_acceptances_household_id_idx
  on public.terms_acceptances(household_id);

-- Insert-only RPC, matching this codebase's existing pattern for every
-- household-scoped write (set_household_phone_number in 023,
-- set_household_carrier_compatibility in 028) rather than a broad INSERT
-- grant. No update/delete path exists anywhere — this table is evidence,
-- not application state, and is never meant to change once written.
create or replace function public.record_terms_acceptance(
  p_household_id uuid,
  p_terms_version text,
  p_privacy_version text,
  p_acceptance_type text default 'subscription_terms'
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result timestamptz;
begin
  insert into public.terms_acceptances (household_id, acceptance_type, terms_version, privacy_version)
    values (p_household_id, coalesce(p_acceptance_type, 'subscription_terms'), p_terms_version, p_privacy_version)
    returning accepted_at into v_result;

  return v_result;
end;
$$;

revoke all on function public.record_terms_acceptance(uuid, text, text, text) from public;
grant execute on function public.record_terms_acceptance(uuid, text, text, text) to service_role;

-- No grants at all on the table itself to anon/authenticated — every
-- access (the RPC above for writes; any future admin/support read) goes
-- through service_role only, matching how twilio_number_quarantine and
-- every other evidence/audit-style table in this codebase is locked down.

commit;

-- Read-only verification — run after commit.
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'terms_acceptances'
  ) then
    raise exception 'MIGRATION 039 VERIFICATION FAILED: terms_acceptances table missing';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_terms_acceptance'
  ) then
    raise exception 'MIGRATION 039 VERIFICATION FAILED: record_terms_acceptance function missing';
  end if;
end
$$;
