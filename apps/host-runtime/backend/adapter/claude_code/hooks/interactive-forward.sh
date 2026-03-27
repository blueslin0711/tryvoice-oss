#!/usr/bin/env bash
# interactive-forward.sh — Forward Claude Code interactive prompts to TryVoice
#
# Called by Claude Code as a PermissionRequest or Elicitation hook.
# Reads hook event JSON from stdin, POSTs to TryVoice backend,
# blocks until user responds in web UI, then exits with appropriate code.
#
# Resilience: if the backend is unreachable (e.g. restarting), the script
# retries every 5 seconds instead of falling through to the TUI. This keeps
# control in the web frontend across backend restarts.
#
# Fallback: after MAX_RETRIES consecutive curl failures (~30s), sends Escape
# to the tmux pane to cancel the current prompt and exits 0 (allow).

set -euo pipefail

TMUX_NAME="${TRYVOICE_TMUX_NAME:-}"
PORT="${TRYVOICE_HOOK_PORT:-7860}"
SCHEME="${TRYVOICE_HOOK_SCHEME:-https}"
ENDPOINT="${SCHEME}://localhost:${PORT}/api/hooks/interactive"
# Each curl attempt waits up to 600s for the user to respond.
# On connection failure, retry every 5s. The overall hook timeout (3600s)
# is the hard ceiling — Claude Code kills this script after that.
CURL_TIMEOUT=600
RETRY_INTERVAL=5
MAX_RETRIES="${TRYVOICE_HOOK_MAX_RETRIES:-6}"
LOG="$HOME/.tryvoice/logs/hook-interactive.log"
mkdir -p "$(dirname "$LOG")"

_log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$TMUX_NAME] $*" >> "$LOG"; }

# Read hook input from stdin
INPUT=$(cat)

# Inject tmux_name into the JSON payload
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

# POST to TryVoice backend with retry on connection failure.
# Blocks until user responds or the hook timeout (3600s) kills us.
# After MAX_RETRIES consecutive failures (~30s), sends Esc to tmux and exits.
RESPONSE=""
RETRIES=0
while true; do
    RESPONSE=$(curl -sk --max-time "$CURL_TIMEOUT" \
        -X POST "$ENDPOINT" \
        -H "Content-Type: application/json" \
        -d "$PAYLOAD" 2>&1) && break
    # curl failed (backend unreachable) — increment counter and retry
    RETRIES=$((RETRIES + 1))
    _log "WARN: curl attempt $RETRIES/$MAX_RETRIES failed. endpoint=$ENDPOINT"
    if [ "$RETRIES" -ge "$MAX_RETRIES" ]; then
        _log "ERROR: max retries reached, sending Escape to $TMUX_NAME"
        if [ -n "$TMUX_NAME" ]; then
            tmux send-keys -t "$TMUX_NAME" Escape 2>/dev/null || true
        fi
        exit 0
    fi
    sleep "$RETRY_INTERVAL"
done

# Parse decision
DECISION=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.loads(sys.stdin.read())
    print(data.get('decision', 'allow'))
except:
    print('allow')
" 2>/dev/null)

_log "OK: decision=$DECISION"

if [ "$DECISION" = "deny" ]; then
    echo "Action denied by user via TryVoice web UI" >&2
    exit 2
fi

# For PermissionRequest, output hookSpecificOutput JSON on stdout
HOOK_EVENT=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    print(json.loads(sys.stdin.read()).get('hook_event_name', ''))
except:
    print('')
" 2>/dev/null)

if [ "$HOOK_EVENT" = "PermissionRequest" ]; then
    echo "$RESPONSE"
fi

exit 0
