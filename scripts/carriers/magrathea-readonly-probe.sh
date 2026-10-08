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
KEYCHAIN_SERVICE="hcg-magrathea-rest"            # password
KEYCHAIN_USER_SERVICE="hcg-magrathea-rest-user"  # username
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
ONLY=""
for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    --only=*) ONLY="${arg#--only=}"      # comma-separated IDs, e.g. --only=R6,R7
              [[ -n "$ONLY" ]] || { echo "--only needs at least one probe id" >&2; exit 2; } ;;
    *) echo "usage: $0 [--execute] [--only=R1,R2,...]" >&2; exit 2 ;;
  esac
done

# --only can only narrow the allowlist, never add to it.
if [[ -n "$ONLY" ]]; then
  SELECTED=()
  IFS=',' read -r -a WANT <<< "$ONLY"
  for w in "${WANT[@]}"; do
    # Each probe runs at most once (Magrathea misuse clause).
    for s in "${SELECTED[@]+"${SELECTED[@]}"}"; do
      [[ "${s%% *}" == "$w" ]] && { echo "duplicate probe id '$w'" >&2; exit 2; }
    done
    found=0
    for entry in "${ALLOWLIST[@]}"; do
      [[ "${entry%% *}" == "$w" ]] && { SELECTED+=("$entry"); found=1; }
    done
    [[ $found -eq 1 ]] || { echo "unknown probe id '$w' (not in allowlist)" >&2; exit 2; }
  done
  ALLOWLIST=("${SELECTED[@]}")
fi

if [[ $EXECUTE -eq 0 ]]; then
  echo "DRY RUN: no network calls. Would GET, once each:"
  for entry in "${ALLOWLIST[@]}"; do echo "  ${entry%% *}  GET ${API}${entry#* }"; done
  echo "Output dir would be: ${EVIDENCE_ROOT}/probe-<UTC>/ (mode 700)"
  exit 0
fi

# Credentials: username and password are separate Keychain items (both entered at a
# hidden prompt, so neither appears in any command line or history); never printed.
kc() { security find-generic-password -s "$1" -w 2>/dev/null; }
# curl config quoting: escape backslash and double quote.
cfg_escape() { sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
if ! kc "$KEYCHAIN_USER_SERVICE" >/dev/null || ! kc "$KEYCHAIN_SERVICE" >/dev/null; then
  echo "Keychain items '$KEYCHAIN_USER_SERVICE' / '$KEYCHAIN_SERVICE' not found; see plan §2.2." >&2; exit 3
fi

umask 077
OUT="${EVIDENCE_ROOT}/probe-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT/raw" "$OUT/redacted"
chmod 700 "$EVIDENCE_ROOT" "$OUT" "$OUT/raw" "$OUT/redacted"
REDACT="$(cd "$(dirname "$0")" && pwd)/magrathea-redact.py"

for entry in "${ALLOWLIST[@]}"; do
  id="${entry%% *}"; path="${entry#* }"
  code="$(
    { printf 'user = "%s:%s"\n' \
        "$(kc "$KEYCHAIN_USER_SERVICE" | tr -d '\n' | cfg_escape)" \
        "$(kc "$KEYCHAIN_SERVICE" | tr -d '\n' | cfg_escape)"
    } | curl -sS -K - -X GET --max-time 20 \
          -H 'Accept: application/json' \
          -o "$OUT/raw/${id}.json" -w '%{http_code}' "${API}${path}"
  )" || code="curl-error"
  printf '%s\t%s\tGET %s\n' "$(date -u +%FT%TZ)" "$code" "$path" >> "$OUT/index.tsv"
  python3 -I "$REDACT" "$OUT/raw/${id}.json" > "$OUT/redacted/${id}.json" 2>/dev/null \
    || echo '{"_redaction":"failed; raw not shown"}' > "$OUT/redacted/${id}.json"
  echo "$id GET $path -> HTTP $code"
  # Never retry or continue on an authentication failure (Magrathea misuse clause:
  # do not guess credentials).
  if [[ "$code" == "401" || "$code" == "403" ]]; then
    echo "STOP: authentication refused on $id; no further requests made." >&2; exit 4
  fi
  # Any other non-200 is unexpected: stop rather than carry on blind.
  if [[ "$code" != "200" ]]; then
    echo "STOP: unexpected HTTP $code on $id; no further requests made." >&2; exit 5
  fi
done

echo "Done. Raw: $OUT/raw (private). Redacted: $OUT/redacted. Never copy raw into the repo or chat."
