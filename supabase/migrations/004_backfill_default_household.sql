-- Sprint 7: Household Identity — backfill default household
--
-- Run this AFTER:
-- 002_create_households_and_roles.sql
-- 003_add_household_id_ownership.sql
--
-- Purpose:
-- Creates one default household for existing development data
-- and assigns all existing contacts and calls to it.
--
-- Purely additive.
-- Existing data is preserved.

-- ------------------------------------------------------------
-- Create default development household
-- ------------------------------------------------------------

insert into public.households (
    email,
    phone_number,
    twilio_number,
    status
)
select
    'default-household@homecallguard.internal',
    '+447715562700',
    '+441615700779',
    'active'
where not exists (
    select 1
    from public.households
    where email = 'default-household@homecallguard.internal'
);

-- ------------------------------------------------------------
-- Backfill existing contacts and calls
-- ------------------------------------------------------------

with default_household as (
    select id
    from public.households
    where email = 'default-household@homecallguard.internal'
)

update public.contacts
set household_id = (
    select id
    from default_household
)
where household_id is null;

with default_household as (
    select id
    from public.households
    where email = 'default-household@homecallguard.internal'
)

update public.calls
set household_id = (
    select id
    from default_household
)
where household_id is null;

-- ------------------------------------------------------------
-- Notes
-- ------------------------------------------------------------
--
-- The default household exists only to preserve pre-authentication
-- development data.
--
-- New households created through registration will receive their
-- own household record and ownership.
--
-- Future migrations may remove this development household once all
-- legacy records have been migrated.
