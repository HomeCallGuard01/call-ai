// complimentaryInvites.js — Friends & Family invite links (2026-09).
//
// Deliberately thin: this reuses database/billing.js's existing,
// already-approved grantComplimentaryEntitlement() for the actual
// entitlement grant (source='admin_manual', entitlement_type=
// 'complimentary') rather than inventing a second entitlement mechanism.
// This module only manages the invite's own lifecycle — creation,
// listing, revocation, and single-use atomic redemption.
'use strict';

const crypto = require('crypto');
const { grantComplimentaryEntitlement } = require('../database/billing');

function resolveSupabaseAdmin() {
  try {
    return require('./supabaseClients').supabaseAdmin;
  } catch (err) {
    console.error('COMPLIMENTARY INVITES: failed to load Supabase client:', err.message);
    return null;
  }
}

const ALLOWED_DURATIONS_DAYS = [30, 90, 365];
const DEFAULT_REDEMPTION_WINDOW_DAYS = 7;

// Cryptographically secure, unguessable — 32 random bytes (256 bits),
// URL-safe. Never persisted; only its SHA-256 hash is stored.
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createInvite({ durationDays, note, createdByAuthUserId, redemptionWindowDays = DEFAULT_REDEMPTION_WINDOW_DAYS }, deps = {}) {
  const { client = resolveSupabaseAdmin() } = deps;
  if (!client) throw new Error('Supabase admin client not configured');
  if (!ALLOWED_DURATIONS_DAYS.includes(durationDays)) {
    throw new Error(`durationDays must be one of ${ALLOWED_DURATIONS_DAYS.join(', ')}`);
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  const redemptionExpiresAt = new Date(Date.now() + redemptionWindowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await client
    .from('complimentary_invites')
    .insert({
      token_hash: tokenHash,
      duration_days: durationDays,
      note: note ? String(note).trim().slice(0, 500) || null : null,
      created_by: createdByAuthUserId || null,
      redemption_expires_at: redemptionExpiresAt,
    })
    .select('id, duration_days, note, created_at, redemption_expires_at, status')
    .single();

  if (error) {
    console.error('COMPLIMENTARY INVITES: CREATE ERROR:', error.message);
    throw error;
  }

  // The raw token is returned exactly once, here — the caller (the admin
  // route) is responsible for building the invite URL and returning it
  // in this one response; it is never logged and never stored anywhere
  // except as the hash already written above.
  return { invite: data, token };
}

async function listInvites(deps = {}) {
  const { client = resolveSupabaseAdmin() } = deps;
  if (!client) return { available: false, reason: 'SUPABASE_SERVICE_ROLE_KEY not configured' };

  const { data, error } = await client
    .from('complimentary_invites')
    .select('id, duration_days, note, created_at, redemption_expires_at, status, redeemed_at, redeemed_household_id, grant_outcome')
    .order('created_at', { ascending: false });

  if (error) return { available: false, reason: error.message };

  const invites = (data || []).map((row) => ({ ...row, displayStatus: computeDisplayStatus(row) }));
  return { available: true, invites };
}

// Pure — a 'pending' row whose redemption window has passed is shown as
// 'expired' without needing a background sweep job. This is display-only:
// redeemInvite() independently re-checks the real deadline against the
// database at redemption time, so a stale displayStatus can never be the
// thing that actually decides whether a token is still redeemable.
function computeDisplayStatus(invite, now = Date.now()) {
  if (invite.status === 'pending' && new Date(invite.redemption_expires_at).getTime() < now) {
    return 'expired';
  }
  return invite.status;
}

async function revokeInvite(inviteId, deps = {}) {
  const { client = resolveSupabaseAdmin() } = deps;
  if (!client) throw new Error('Supabase admin client not configured');

  // Only a still-pending invite can be revoked — an already redeemed/
  // expired/revoked row is left untouched, matching
  // revokeComplimentaryEntitlement's own "nothing to do" pattern.
  const { data, error } = await client
    .from('complimentary_invites')
    .update({ status: 'revoked' })
    .eq('id', inviteId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('COMPLIMENTARY INVITES: REVOKE ERROR:', error.message);
    throw error;
  }

  return { revoked: !!data };
}

// Redeems an invite for an already-existing household — never creates a
// household itself. Called only after the caller (server.js's /register
// or /login) has already confirmed the household row exists.
//
// Never overwrites, expires, downgrades or modifies an existing paid
// entitlement: that guarantee lives entirely in
// grantComplimentaryEntitlement()'s own safety guard (database/
// billing.js), reused here unchanged. If the household already has an
// active real (Stripe/RevenueCat) entitlement, the grant is refused and
// nothing about that entitlement is touched — the invite is still
// consumed (see grant_outcome below) since re-trying it would only ever
// hit the same refusal again.
async function redeemInvite(token, household, deps = {}) {
  const { client = resolveSupabaseAdmin() } = deps;
  if (!client) return { redeemed: false, reason: 'not_configured' };
  if (!token || typeof token !== 'string') return { redeemed: false, reason: 'no_token' };
  if (!household || !household.id) return { redeemed: false, reason: 'no_household' };

  const tokenHash = hashToken(token);
  const nowIso = new Date().toISOString();

  // The atomic single-use guarantee: this UPDATE can only match and
  // return a row while status is still 'pending' AND the redemption
  // deadline has not passed. Two concurrent requests for the same token
  // cannot both succeed — Postgres serializes the UPDATE at the row
  // level, so the loser gets zero matching rows back.
  const { data: claimed, error: claimError } = await client
    .from('complimentary_invites')
    .update({ status: 'redeemed', redeemed_at: nowIso, redeemed_household_id: household.id })
    .eq('token_hash', tokenHash)
    .eq('status', 'pending')
    .gt('redemption_expires_at', nowIso)
    .select('id, duration_days, note')
    .maybeSingle();

  if (claimError) {
    console.error('COMPLIMENTARY INVITES: REDEEM ERROR:', claimError.message);
    return { redeemed: false, reason: 'error' };
  }

  if (!claimed) {
    return { redeemed: false, reason: 'invalid_expired_or_used' };
  }

  // Full duration from the moment of redemption, not from invite
  // creation — a recipient who takes a few days to open the link and
  // register still gets the full 30/90/365 days.
  const endsAt = new Date(Date.now() + claimed.duration_days * 24 * 60 * 60 * 1000).toISOString();

  let grantResult;
  try {
    grantResult = await grantComplimentaryEntitlement(
      household.id,
      {
        grantedByAuthUserId: null,
        notes: `Friends & Family invite${claimed.note ? ` — ${claimed.note}` : ''}`,
        endsAt,
      },
      deps
    );
  } catch (err) {
    console.error('COMPLIMENTARY INVITES: GRANT ERROR AFTER REDEMPTION:', err.message);
    grantResult = { granted: false, reason: 'grant_error' };
  }

  await client
    .from('complimentary_invites')
    .update({ grant_outcome: grantResult.granted ? 'granted' : `refused:${grantResult.reason}` })
    .eq('id', claimed.id);

  // A Friends & Family account is never a genuine customer, regardless
  // of whether the downstream grant itself succeeded — its origin, not
  // the entitlement outcome, is what this classification records. Same
  // upsert-on-household_id pattern migration 031 already established.
  const { error: classifyError } = await client
    .from('account_classifications')
    .upsert(
      {
        household_id: household.id,
        classification: 'internal_test',
        note: 'Friends & Family complimentary invite',
        classified_by: 'friends_family_invite',
      },
      { onConflict: 'household_id' }
    );

  if (classifyError) {
    console.error('COMPLIMENTARY INVITES: CLASSIFICATION ERROR:', classifyError.message);
  }

  return { redeemed: true, granted: grantResult.granted, reason: grantResult.reason };
}

module.exports = {
  ALLOWED_DURATIONS_DAYS,
  DEFAULT_REDEMPTION_WINDOW_DAYS,
  generateToken,
  hashToken,
  computeDisplayStatus,
  createInvite,
  listInvites,
  revokeInvite,
  redeemInvite,
};
