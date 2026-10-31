#!/bin/bash
# One-call Kahoot join: one shell command -> one model turn.
# Usage: scripts/kahoot-join.sh <GAME_PIN> [NICKNAME]
# Env: IW_URL (default http://chrome-inkwork:8787), IW_TOKEN, DRY_RUN=1
set -euo pipefail

PIN="${1:?usage: kahoot-join.sh <GAME_PIN> [NICKNAME]}"
NAME="${2:-Agent}"
BASE="${IW_URL:-http://chrome-inkwork:8787}"
TOKEN="${IW_TOKEN:-$(grep -m1 '^IW_TOKEN=' /workspace/chrome/deploy/secrets.env | cut -d= -f2-)}"

H=(-H "Authorization: Bearer $TOKEN" -H 'content-type: application/json')

SID=$(curl -sS -X POST "$BASE/api/sessions" "${H[@]}" \
  -d "{\"name\":\"kahoot-$PIN\",\"url\":\"https://kahoot.it\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["session"]["id"])')

if [ "${DRY_RUN:-0}" = "1" ]; then
  BODY=$(printf '{"pin":"%s","name":"%s","dry_run":true}' "$PIN" "$NAME")
else
  BODY=$(printf '{"pin":"%s","name":"%s"}' "$PIN" "$NAME")
fi

curl -sS -X POST "$BASE/api/s/$SID/recipe/kahoot.join" "${H[@]}" -d "$BODY" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(json.dumps({"ok":d.get("ok"),"phase":d.get("phase"),"session":d.get("session"),"title":d.get("title"),"url":d.get("url"),"detail":d.get("detail")},indent=1))'

echo "session: $SID"
echo "watch:   https://chrome.inkwork.studio/google?session=$SID"

if [ "${DRY_RUN:-0}" = "1" ]; then
  curl -sS -X POST "$BASE/api/s/$SID/close" "${H[@]}" -d '{}' >/dev/null || true
fi
