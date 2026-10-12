#!/usr/bin/env bash
# Sends a JARVIS report from a cloud session to Matthew's Telegram, with a metrics footer.
# Usage: scripts/report.sh <job-id> <sent-at ISO time from the message> "<message>"
# Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the cloud environment, and api.telegram.org
# on its network allowlist (see README).
set -euo pipefail

job="$1" sent_at="$2" message="$3"
metrics="$(python3 "$(dirname "$0")/session_metrics.py" --since "$sent_at" 2>/dev/null || true)"

text="[$job] $message"
[ -n "$metrics" ] && text="$text

$metrics"

# Telegram caps a message at 4096 characters.
curl -sS --fail-with-body -o /dev/null -X POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN not set in the cloud environment}/sendMessage" \
  -d chat_id="${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID not set in the cloud environment}" \
  --data-urlencode text="${text:0:4000}"
echo "reported to Telegram"
