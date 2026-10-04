#!/usr/bin/env bash
# PREPARED 2026-10-04 — NOT EXECUTED. Applies the soft-launch candidate's
# migrations to the STAGING Supabase project only.
#
# Default is a DRY RUN. A real run needs ALL of:
#   APPLY=yes  CONFIRM_STAGING_REF=tigwgmayeuisrxjjykqd  BACKUP_RESTORE_TESTED=yes
# and the Supabase CLI linked to the staging project (`supabase link`), which
# prompts for the staging DB password (never stored here).
#
# Order (docs/launch/2026-10-04-STAGING-READINESS.md §2):
#   052 053 054 055 056 062 063 064 065 066 067 068 069 070 071 072 (rehearsed on a restored copy)
# `supabase db push --include-all` applies every un-applied local migration in
# number order. NEVER point this at production (psbzynxplxfbyrbdidmn).
set -euo pipefail
STAGING_REF="tigwgmayeuisrxjjykqd"
PROD_REF="psbzynxplxfbyrbdidmn"
cd "$(dirname "$0")/../.."
linked="$(cat supabase/.temp/project-ref 2>/dev/null || true)"
if [[ "$linked" == "$PROD_REF" ]]; then echo "REFUSED: linked to PRODUCTION"; exit 2; fi
if [[ "$linked" != "$STAGING_REF" ]]; then echo "REFUSED: not linked to staging ($STAGING_REF); run: supabase link --project-ref $STAGING_REF"; exit 2; fi

echo "== Pending migrations (dry run) =="
supabase migration list --linked
supabase db push --linked --include-all --dry-run

if [[ "${APPLY:-}" != "yes" || "${CONFIRM_STAGING_REF:-}" != "$STAGING_REF" || "${BACKUP_RESTORE_TESTED:-}" != "yes" ]]; then
  echo "DRY RUN ONLY. To apply: APPLY=yes CONFIRM_STAGING_REF=$STAGING_REF BACKUP_RESTORE_TESTED=yes $0"
  exit 0
fi

# 052's objects already exist on staging but its history row does not. The
# 2026-10-04 rehearsal on a restored copy proved 052 re-runs cleanly over them,
# so it is applied normally (records history + guarantees the objects) rather
# than history-repaired.
echo "== Apply 052…072 in order =="
supabase db push --linked --include-all
echo "== Verify =="
node scripts/staging/verify-staging-schema.js
echo "Now run in the SQL editor: select public.fc_check_invariants();  and  node scripts/verify-table-grants.js (staging)"
