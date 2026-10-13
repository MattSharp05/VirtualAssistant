#!/usr/bin/env bash
# Sends a JARVIS report from a cloud session, with a metrics footer, to every destination the
# cloud environment configures:
#   Telegram:  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   (api.telegram.org on the network allowlist)
#   Dashboard: JARVIS_REPORT_URL + JARVIS_REPORT_SECRET (JARVIS's public URL on the allowlist)
# Usage: scripts/report.sh <job-id> <sent-at ISO time from the message> "<message>"
set -euo pipefail

job="$1" sent_at="$2" message="$3"
metrics="$(python3 "$(dirname "$0")/session_metrics.py" --since "$sent_at" 2>/dev/null || true)"

text="$message"
[ -n "$metrics" ] && text="$text

$metrics"

sent=0 configured=0
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  configured=$((configured + 1))
  # Telegram caps a message at 4096 characters.
  full="[$job] $text"
  curl -sS --fail-with-body -o /dev/null -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="$TELEGRAM_CHAT_ID" --data-urlencode text="${full:0:4000}" && sent=$((sent + 1)) && echo "reported to Telegram"
fi
if [ -n "${JARVIS_REPORT_URL:-}" ] && [ -n "${JARVIS_REPORT_SECRET:-}" ]; then
  configured=$((configured + 1))
  body="$(python3 -c 'import json,sys; print(json.dumps({"job": sys.argv[1], "text": sys.argv[2]}))' "$job" "$text")"
  curl -sS --fail-with-body -o /dev/null -X POST "${JARVIS_REPORT_URL%/}/api/reports" \
    -H "Authorization: Bearer ${JARVIS_REPORT_SECRET}" -H "Content-Type: application/json" -d "$body" \
    && sent=$((sent + 1)) && echo "reported to the JARVIS dashboard"
fi
# Nothing configured isn't a failure: the work still happened and is visible in the session itself.
# Something configured that didn't deliver is one, so the session can say so.
if [ "$configured" -eq 0 ]; then
  echo "Note: no report destination is configured in this cloud environment, so this report stays in the session (see README)."
elif [ "$sent" -eq 0 ]; then
  echo "Report NOT delivered: every configured destination failed (see the errors above)." >&2
  exit 1
fi
