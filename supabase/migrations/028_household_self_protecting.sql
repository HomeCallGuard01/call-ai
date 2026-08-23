-- STATUS: DRAFT — NOT APPLIED. Needs manual application via the
-- Supabase SQL Editor (no working Management API/direct Postgres access
-- from this environment — same limitation as migration 027). Update this
-- header to APPLIED, with date + project ref, once run.

-- Adds the explicit, stored fact that makes the customer's own forwarded
-- carrier number impossible-by-construction to ever PSTN-dial back to.
--
-- Root cause of the incident this closes (docs/operations/
-- HANDOVER_2026-08-15.md; reconciled further 2026-08-23): a household's
-- destination for safe calls (households.phone_number) and the number
-- physically forwarded to Home Call Guard's Twilio number are, for the
-- single-phone customer this product is primarily built for, the exact
-- same number. Dialling that number back over PSTN is intercepted by
-- the customer's own still-active carrier forward and re-enters /voice
-- as a brand-new call — an infinite loop, reproduced for real on
-- 2026-08-15 and confirmed still live and unguarded in production on
-- 2026-08-23 (Twilio's ForwardedFrom parameter is absent on this carrier
-- path, so the only previously-written guard, fix/call-forwarding-loop-
-- 2026-08-15, can never fire — see that migration's own commit history,
-- never merged).
--
-- Rather than infer this from comparing phone numbers at call time
-- (fragile — formatting differences, a customer choosing to set a
-- second number equal to their own for some legitimate reason we haven't
-- anticipated), this stores the customer's own stated intent once,
-- explicitly, during onboarding. Defaults to true: standard mobile
-- onboarding is the single-phone, self-protecting case by design (per
-- product decision, 2026-08-23) — a customer is never asked "are you
-- setting this up on the phone you want protected", since the normal
-- customer should not need to understand this distinction at all. Only
-- an explicitly separate, not-yet-built "I'm protecting someone else's
-- phone" journey would ever set this false — until that journey exists,
-- every household is correctly self_protecting by default, which is
-- also the safe default (fails toward Client-only delivery, never
-- toward an unguarded PSTN dial-back).

begin;

alter table public.households
  add column if not exists self_protecting boolean not null default true;

commit;

-- Read-only verification — run after commit.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'households' and column_name = 'self_protecting';
