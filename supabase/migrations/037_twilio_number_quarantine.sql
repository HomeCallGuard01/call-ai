-- Safe Twilio-number quarantine foundation (P0 Batch 1, component D).
--
-- STATUS: NOT APPLIED to any database (staging or production) — proposed
-- only, per this batch's explicit instruction. Review before applying.
--
-- Confirmed real risk (carrier/activation audit, 2026-09-10): both
-- existing release paths -- releaseExpiredTwilioNumber (30-day grace
-- period after subscription cancellation) and releaseTwilioNumberImmediately
-- (used by services/accountDeletion.js) -- called Twilio's real
-- incomingPhoneNumbers(sid).remove() with zero check anywhere for
-- whether the former customer's carrier-level call forwarding had
-- actually been removed. A number reassigned by Twilio to a new HCG
-- customer would silently start receiving, screening, and
-- Whisper-transcribing an unrelated stranger's calls; if reassigned
-- outside HCG entirely, the old customer's callers reach a completely
-- unrelated third party with no context. A real privacy/misdirected-call
-- risk, not a theoretical one.
--
-- Explicit correction this migration was built to (2026-09-10, standing
-- instruction, reversing an earlier draft of this design): a number must
-- NEVER be auto-released from Twilio purely because time has passed
-- while deactivation is unconfirmed. This table intentionally has no
-- "release after N days regardless" mechanism -- deactivation_confirmed
-- starts false and stays false until a human explicitly confirms it
-- (no automatic caller exists anywhere in this batch -- see below); only
-- then does a number become eligible for the release runner to actually
-- call Twilio's API. An unconfirmed number is held indefinitely. The
-- ~£1/month Twilio rental cost of holding an unconfirmed number
-- indefinitely is accepted as the deliberate trade-off -- preventing
-- misdirected calls/privacy exposure takes priority over that small
-- continuing cost. A longer-term/manual release policy for
-- indefinitely-unconfirmed numbers can be defined later; this migration
-- does not add one.
--
-- What actually changes at the Twilio-API level, per household/number:
-- both release paths above now INSERT a row here instead of calling
-- .remove() -- see services/twilioProvisioning.js's updated
-- releaseExpiredTwilioNumber/releaseTwilioNumberImmediately. The genuine
-- Twilio release only happens later, for CONFIRMED rows, via the new
-- releaseQuarantinedTwilioNumber/runConfirmedQuarantineRelease functions
-- (services/twilioProvisioning.js, services/twilioNumberReleaseRunner.js).
--
-- Confirmation itself is deliberately NOT automated in this batch -- no
-- reliable automatic signal for "the customer definitely removed their
-- carrier-level forwarding" exists yet (this is exactly the gap the
-- broader carrier-aware architecture design would eventually close with
-- a self-report + support-assisted flow). confirmTwilioNumberDeactivation
-- (database/twilioQuarantine.js) is exposed as the mechanism a human
-- (support, admin) calls after manually verifying with the customer --
-- this migration adds the foundation, not an end-to-end automatic
-- confirmation pipeline.
--
-- Table is purely internal -- written and read only by the app's own
-- service-role client, matching acquisition_events/account_classifications'
-- precedent (migrations 031/032) -- no authenticated/anon policy needed.
--
-- Additive, reversible, isolated: one new table, zero existing table or
-- column altered. Dropping this table
-- (`drop table if exists public.twilio_number_quarantine;`) has no
-- effect on any other feature -- nothing else references it.
--
-- household_id is nullable with ON DELETE SET NULL, NOT CASCADE --
-- corrected 2026-09-10 after review. The original CASCADE was wrong: the
-- entire purpose of this table is to retain the Twilio number/SID,
-- release reason, timestamps, and deactivation-confirmation state for as
-- long as the number itself remains genuinely un-released, specifically
-- INCLUDING after the customer's own household/auth data is gone --
-- CASCADE would silently delete the one record proving an un-recycled
-- Twilio number still exists and is still unconfirmed, which is exactly
-- backwards for a safety mechanism whose entire job is "never forget
-- about this number." (households.id is never actually hard-deleted
-- anywhere in this codebase today -- confirmed by search;
-- anonymize_inactive_household, migration 020, anonymises the row in
-- place and never deletes it -- so this was latent, not yet a live bug,
-- but the wrong design to ship as a "foundation.") SET NULL means a
-- future hard-delete of a household row (should one ever be added) only
-- loses the household *reference* on this table, never the quarantine
-- row itself or any of the fields listed above.
--
-- twilio_sid is captured directly at quarantine time (looked up via the
-- Twilio API once, when the number is quarantined) rather than relying
-- solely on searching Twilio by phone number again later at release time
-- -- the phone-number search remains as a fallback (see
-- services/twilioProvisioning.js's releaseQuarantinedTwilioNumber) for
-- any row where this lookup wasn't available, but is no longer the only
-- way to find the right Twilio resource once a number is genuinely ready
-- for release.

begin;

create table if not exists public.twilio_number_quarantine (
  id uuid primary key default gen_random_uuid(),

  household_id uuid
    references public.households(id)
    on delete set null,

  twilio_number text not null,
  twilio_sid text,

  release_reason text not null
    check (release_reason in ('subscription_grace_expired', 'account_deletion')),

  -- Starts false and MUST stay false until a human explicitly confirms
  -- deactivation -- see this migration's own header. No automatic caller
  -- sets this true anywhere in this batch.
  deactivation_confirmed boolean not null default false,
  deactivation_confirmed_at timestamptz,
  deactivation_confirmed_method text,

  quarantined_at timestamptz not null default now(),
  released_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists twilio_number_quarantine_household_id_idx
  on public.twilio_number_quarantine (household_id);

-- Hot-path query shape used by the confirmed-release runner.
create index if not exists twilio_number_quarantine_confirmed_unreleased_idx
  on public.twilio_number_quarantine (deactivation_confirmed)
  where deactivation_confirmed = true and released_at is null;

alter table public.twilio_number_quarantine enable row level security;

-- No policy for authenticated/anon -- see this migration's own header.
-- Matching migration 022's explicit-default-privileges posture, this
-- table's default privileges do not implicitly extend to service_role
-- either; the grant below is what makes access work.
grant select, insert, update on public.twilio_number_quarantine to service_role;

commit;
