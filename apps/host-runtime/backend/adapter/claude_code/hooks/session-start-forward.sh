#!/usr/bin/env bash
# session-start-forward.sh — Notify TryVoice when Claude Code starts/switches sessions
#
# Fires on: startup, resume, /clear, compaction, context overflow
# POSTs session_id + tmux_name to TryVoice backend so the SessionWatcher
# can immediately switch to the new JSONL file.

set -euo pipefail

TMUX_NAME="${TRYVOICE_TMUX_NAME:-}"
PORT="${TRYVOICE_HOOK_PORT:-7860}"
SCHEME="${TRYVOICE_HOOK_SCHEME:-https}"
ENDPOINT="${SCHEME}://localhost:${PORT}/api/hooks/session-start"
LOG="$HOME/.tryvoice/logs/hook-session-start.log"
mkdir -p "$(dirname "$LOG")"

_log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$TMUX_NAME] $*" >> "$LOG"; }

# Read hook input from stdin
INPUT=$(cat)

# Inject tmux_name
PAYLOAD=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.loads(sys.stdin.read())
data['tmux_name'] = '$TMUX_NAME'
print(json.dumps(data))
" 2>/dev/null)

if [ -z "$PAYLOAD" ]; then
    _log "ERROR: payload empty (python3 parse failed). input=${INPUT:0:200}"
    exit 0
fi

# Non-blocking POST — don't delay Claude startup
RESPONSE=$(curl -sk --max-time 5 \
    -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>&1) || {
    _log "ERROR: curl failed (exit=$?). endpoint=$ENDPOINT response=$RESPONSE"
    exit 0
}

# Check response for errors
case "$RESPONSE" in
    *'"ok":true'*|*'"ok": true'*)
        _log "OK: session_id=$(echo "$PAYLOAD" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('session_id','?')[:8])" 2>/dev/null)"
        ;;
    *)
        _log "WARN: unexpected response=$RESPONSE"
        ;;
esac

exit 0
