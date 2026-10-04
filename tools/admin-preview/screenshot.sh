#!/usr/bin/env bash
# Capture SYNTHETIC preview screenshots of the Admin Control Centre with
# headless Chrome (admin redesign, 2026-10-04). Starts tools/admin-preview/
# serve.js on 127.0.0.1, captures each tab at laptop width and the Overview
# at phone width, trims trailing blank space, then stops the server.
#
#   tools/admin-preview/screenshot.sh <out-dir> [path/to/admin-business.html]
set -euo pipefail
OUT="${1:?usage: screenshot.sh <out-dir> [html]}"
HTML="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${PREVIEW_PORT:-4777}"
CHROME="${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | tail -1)}"
mkdir -p "$OUT"

node "$HERE/serve.js" --port "$PORT" ${HTML:+--html "$HTML"} >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/admin/business" && break; sleep 0.1; done

INCIDENT="00000000-0000-4000-8000-000000000003"
shot() { # name width height url-suffix
  "$CHROME" --disable-gpu --hide-scrollbars --no-first-run \
    --user-data-dir="$(mktemp -d)" --window-size="$2,$3" --virtual-time-budget=6000 \
    --screenshot="$OUT/$1.png" "http://127.0.0.1:$PORT/admin/business$4" >/dev/null 2>&1 &
  local pid=$!
  # Watchdog: a capture never blocks the run for more than 30 s.
  for _ in $(seq 1 300); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill "$pid" 2>/dev/null || true
}
shot 1-overview 1440 2200 "#overview"
shot 2-customers 1440 1700 "#customers"
shot 3-customer-detail 1440 2300 "?open=$INCIDENT#customers"
shot 4-money 1440 3000 "#money"
shot 5-numbers 1440 2600 "#numbers"
shot 6-operations 1440 4200 "#operations"
shot 7-mobile-overview 390 2600 "#overview"
shot 8-mobile-customers 390 2600 "#customers"
shot 9-mobile-money 390 2400 "#money"
shot 10-mobile-operations 390 2600 "#operations"

python3 "$HERE/trim.py" "$OUT"/*.png
ls -1 "$OUT"
