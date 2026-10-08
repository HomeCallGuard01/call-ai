#!/usr/bin/env bash
# Magrathea trial: READ-ONLY REST probe (R1–R7 in docs/carriers/MAGRATHEA-TRIAL-PLAN.md §3.1).
#
# Default is a dry run: prints the requests it would make, touches no network.
# --execute performs each allowlisted GET exactly once (requires approval A2).
#
# Safety:
#   - exact-path allowlist; GET only. (Method is NOT a safety signal in this API:
#     account/transfer moves money via GET, so nothing outside the list is callable.)
#   - credentials come from the macOS Keychain (service hcg-magrathea-rest) and are
#     passed to curl on stdin (-K -), never argv, never echoed, never written to disk.
#   - output goes OUTSIDE the repo (may contain PII and Network Numbers, which must not
#     reach end users or git).
set -euo pipefail
set +x

API="https://restapi.magrathea.net:8443/v1"
ACCOUNT="112168"
DDI="03300884327"
KEYCHAIN_SERVICE="hcg-magrathea-rest"
EVIDENCE_ROOT="/Users/ad/hcg-magrathea-trial"

ALLOWLIST=(
  "R1 /account/services"
  "R2 /account/detail/${ACCOUNT}"
  "R3 /account/balance/${ACCOUNT}"
  "R4 /account/gettariff/${ACCOUNT}"
  "R5 /account/cdrs/${ACCOUNT}"
  "R6 /number/status/${DDI}"
  "R7 /block/info/${DDI}"
)

EXECUTE=0
case "${1:-}" in
  "") ;;
  --execute) EXECUTE=1 ;;
  *) echo "usage: $0 [--execute]" >&2; exit 2 ;;
esac

if [[ $EXECUTE -eq 0 ]]; then
  echo "DRY RUN: no network calls. Would GET, once each:"
  for entry in "${ALLOWLIST[@]}"; do echo "  ${entry%% *}  GET ${API}${entry#* }"; done
  echo "Output dir would be: ${EVIDENCE_ROOT}/probe-<UTC>/ (mode 700)"
  exit 0
fi

# Credentials: account name and secret both from Keychain; never printed.
USER_NAME="$(security find-generic-password -s "$KEYCHAIN_SERVICE" 2>/dev/null \
  | sed -n 's/^ *"acct"<blob>="\(.*\)"$/\1/p')"
if [[ -z "$USER_NAME" ]]; then
  echo "Keychain item '$KEYCHAIN_SERVICE' not found; see plan §2.2." >&2; exit 3
fi

umask 077
OUT="${EVIDENCE_ROOT}/probe-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
chmod 700 "$EVIDENCE_ROOT" "$OUT"

for entry in "${ALLOWLIST[@]}"; do
  id="${entry%% *}"; path="${entry#* }"
  code="$(
    { printf 'user = "%s:' "$USER_NAME"
      security find-generic-password -s "$KEYCHAIN_SERVICE" -w | tr -d '\n'
      printf '"\n'
    } | curl -sS -K - -X GET --max-time 20 \
          -H 'Accept: application/json' \
          -o "$OUT/${id}.json" -w '%{http_code}' "${API}${path}"
  )" || code="curl-error"
  printf '%s\t%s\tGET %s\n' "$(date -u +%FT%TZ)" "$code" "$path" >> "$OUT/index.tsv"
  echo "$id GET $path -> $code (body in $OUT/${id}.json)"
done

echo "Done. Review $OUT; do not copy contents into the repo or chat."
