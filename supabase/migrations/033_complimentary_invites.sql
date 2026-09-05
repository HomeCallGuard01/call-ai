-- Friends & Family complimentary invite links (2026-09)
--
-- Purpose: let an admin generate a single-use, expiring invite link that
-- grants a brand-new registrant complimentary access via the existing,
-- already-approved admin-manual complimentary entitlement mechanism
-- (database/billing.js's grantComplimentaryEntitlement — unchanged by
-- this migration). This table only tracks the invite's own lifecycle;
-- it never stores billing state itself and never creates a Stripe/
-- RevenueCat object.
--
-- Only a SHA-256 hash of the invite token is stored — the raw token is
-- returned to the admin exactly once (at creation) and is never written
-- to any table or log. token_hash is UNIQUE so the same raw token can
-- never collide with/overwrite another invite's row.
--
-- Single-use + atomicity: services/complimentaryInvites.js's
-- redeemInvite() flips status 'pending' -> 'redeemed' with a single
-- UPDATE ... WHERE status = 'pending' AND redemption_expires_at > now()
-- ... RETURNING. Postgres serializes concurrent UPDATEs to the same row,
-- so if two requests race to redeem the same token, only one can match
-- status = 'pending' and receive a row back — the other sees zero rows
-- affected. This is what actually enforces single-use, not application
-- logic.
--
-- This is purely additive: one new table, no existing table altered.

begin;

create table if not exists public.complimentary_invites (
  id uuid primary key default gen_random_uuid(),

  -- SHA-256 hex digest of the raw invite token. The raw token is never
  -- persisted anywhere.
  token_hash text not null unique,

  duration_days integer not null
    check (duration_days in (30, 90, 365)),

  note text,

  -- auth.users id of the admin who created this invite. Not FK'd to
  -- auth.users, matching this codebase's existing convention for
  -- similar admin-attribution columns (e.g. entitlements.created_by).
  created_by uuid,

  created_at timestamptz not null default now(),

  -- Deadline for REDEEMING the invite (not the granted entitlement's own
  -- expiry, which is duration_days computed from the moment of
  -- redemption — see redeemInvite()). Defaults to a 7-day window at the
  -- application layer.
  redemption_expires_at timestamptz not null,

  status text not null default 'pending'
    check (status in ('pending', 'redeemed', 'expired', 'revoked')),

  redeemed_at timestamptz,

  redeemed_household_id uuid
    references public.households(id)
    on delete set null,

  -- Outcome of the downstream grantComplimentaryEntitlement() call, e.g.
  -- 'granted' or 'refused:active_paid_entitlement_exists' — for audit
  -- only; the invite itself is still consumed (status='redeemed') even
  -- if the grant was refused, since a paid entitlement must never be
  -- touched regardless of how the household got here.
  grant_outcome text
);

alter table public.complimentary_invites enable row level security;

-- No policy for `authenticated`/`anon` — this table is written only by
-- the admin dashboard (creating/listing/revoking invites) and by the
-- registration/login server code (redeeming one), both already running
-- as service_role. Same posture as account_classifications and
-- acquisition_events.

grant select, insert, update on public.complimentary_invites to service_role;

commit;
