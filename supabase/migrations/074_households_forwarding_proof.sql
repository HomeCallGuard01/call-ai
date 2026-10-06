-- 074_households_forwarding_proof.sql
--
-- STATUS: DRAFT — NOT APPLIED ANYWHERE (LF-2 fix, 2026-10-06).
-- Numbering: 074 verified free on every remote branch, local branch and
-- worktree before creation. Re-run scripts/check-migration-numbering.js.
--
-- LF-2 (real-device finding 2026-10-05, HIGH): a customer could be shown
-- "Protected" without any call forwarding. activation_verified_at is stamped
-- by ANY genuine inbound call to the household's HCG number (server.js /voice
-- → stampActivationVerifiedOnRealCall), including a direct dial or a stray
-- call to a recycled number, and Twilio's ForwardedFrom cannot tell a
-- forwarded call from a direct dial (184 production calls, 2026-09-08). The
-- staging household reached `protected` on the device although the protected
-- iPhone forwarded nothing.
--
-- Decision (Andrew, 2026-10-06, option B + C): an ordinary inbound call must
-- NOT mark forwarding verified, and nobody is shown Protected merely because
-- their HCG number received a call.
--
--   activation_verified_at  keeps its stamp, now meaning only "a call reached
--                           the HCG number" (evidence, not proof).
--   forwarding_proven_at    NEW: the ONLY input to the protection gate
--                           `forwardingVerifiedForCurrentNumber`. Set only by
--                           a genuine forwarding proof. Nothing in the
--                           application writes it yet: the controlled
--                           verification-call design (option A) is pending
--                           approval. Until then no household is "Protected";
--                           the app shows the truthful `forwarding_unconfirmed`
--                           stage instead.
--   forwarding_proof_method how it was proven (constrained list).
--
-- Purely additive and nullable; no existing column, row or grant changes. The
-- application tolerates the columns being absent (undefined ⇒ not proven).

begin;

alter table public.households
  add column if not exists forwarding_proven_at timestamptz,
  add column if not exists forwarding_proof_method text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'households_forwarding_proof_method_check'
      and conrelid = 'public.households'::regclass
  ) then
    alter table public.households
      add constraint households_forwarding_proof_method_check
      check (forwarding_proof_method is null or forwarding_proof_method in ('verification_call'));
  end if;
end;
$$;

comment on column public.households.forwarding_proven_at is
  'Genuine proof that calls to the customer''s own phone are diverted to the HCG number (LF-2). The ONLY input to the protection gate. Never set by an ordinary inbound call. Migration 074.';
comment on column public.households.activation_verified_at is
  'A genuine inbound call reached the HCG number (evidence only — NOT forwarding proof since migration 074 / LF-2).';

commit;
