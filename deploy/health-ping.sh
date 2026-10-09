#!/usr/bin/env bash
# Cron health ping for vps-dashboard. Logs failures to journald (tag: vps-dashboard-health).
# Read with: journalctl -t vps-dashboard-health
# Does NOT restart anything. Restart is a human call.
set -u

URL="${HEALTH_URL:-http://127.0.0.1/api/health}"

if curl -fsS -m 5 "$URL" 2>/dev/null | grep -q '"status":"ok"'; then
  exit 0
fi

logger -t vps-dashboard-health -p user.err "health check failed: $URL"
exit 1
