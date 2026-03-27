#!/usr/bin/env bash
# tmux-watchdog.sh — Monitor tmux-server process for crashes
#
# Runs independently of TryVoice. Watches the tmux-server process and
# logs diagnostics when it dies: exit code, signal, memory usage before
# death, open file descriptors, and system memory pressure.
#
# Usage:
#   ./scripts/tmux-watchdog.sh &          # background
#   ./scripts/tmux-watchdog.sh --once     # single check and exit
#
# Log: ~/.tryvoice/logs/tmux-watchdog.log

set -euo pipefail

LOG="$HOME/.tryvoice/logs/tmux-watchdog.log"
POLL_INTERVAL=3  # seconds
mkdir -p "$(dirname "$LOG")"

_log() {
    local ts
    ts=$(date '+%Y-%m-%d %H:%M:%S')
    echo "$ts  $*" >> "$LOG"
    echo "$ts  $*"
}

_snapshot_process() {
    # Capture process state for a given PID
    local pid=$1
    _log "  PID=$pid"
    _log "  RSS=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')KB"
    _log "  VSZ=$(ps -o vsz= -p "$pid" 2>/dev/null | tr -d ' ')KB"
    _log "  OPEN_FDS=$(lsof -p "$pid" 2>/dev/null | wc -l | tr -d ' ')"
    _log "  THREADS=$(ps -M -p "$pid" 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')"
    _log "  SESSIONS=$(tmux list-sessions 2>/dev/null | wc -l | tr -d ' ')"
    _log "  PANES=$(tmux list-panes -a 2>/dev/null | wc -l | tr -d ' ')"
    _log "  UPTIME=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')"
}

_snapshot_system() {
    _log "  SYSTEM_MEMORY=$(vm_stat 2>/dev/null | awk '/Pages free/ {free=$3} /Pages active/ {active=$3} /Pages speculative/ {spec=$3} END {printf "free=%d active=%d spec=%d (pages)", free, active, spec}')"
    _log "  MEMORY_PRESSURE=$(memory_pressure 2>/dev/null | tail -1 || echo 'N/A')"
    _log "  LOAD=$(sysctl -n vm.loadavg 2>/dev/null || uptime | awk -F'load averages:' '{print $2}')"
}

_find_tmux_server_pid() {
    # On macOS, tmux server process name is "tmux" (not "tmux-server").
    # The server is the one with ppid=1 (daemonized) or the one that
    # owns the socket. Use `tmux display -p '#{pid}'` for reliability.
    tmux display-message -p '#{pid}' 2>/dev/null || echo ""
}

_on_death() {
    local old_pid=$1
    local exit_info=$2
    _log "========================================"
    _log "TMUX-SERVER DIED"
    _log "  DEAD_PID=$old_pid"
    _log "  EXIT_INFO=$exit_info"
    _log "  SOCKET_EXISTS=$(test -S /private/tmp/tmux-$(id -u)/default && echo true || echo false)"

    # Check macOS unified log for any related entries in last 30 seconds
    _log "  SYSTEM_LOG_LAST_30s:"
    log show --predicate "process == 'tmux-server' OR (eventMessage CONTAINS 'tmux' AND eventMessage CONTAINS[c] 'kill')" \
        --last 30s --style compact 2>/dev/null | while read -r logline; do
        _log "    $logline"
    done

    # Check for jetsam (OOM kill) events
    log show --predicate "eventMessage CONTAINS 'jetsam' OR eventMessage CONTAINS 'memorystatus'" \
        --last 60s --style compact 2>/dev/null | head -5 | while read -r logline; do
        _log "    JETSAM: $logline"
    done

    _snapshot_system
    _log "========================================"
}

# --- Main loop ---

_log "tmux-watchdog started (poll=${POLL_INTERVAL}s)"

TRACKED_PID=""
SNAPSHOT_COUNTER=0

while true; do
    CURRENT_PID=$(_find_tmux_server_pid)

    if [ -z "$CURRENT_PID" ]; then
        # No tmux-server running
        if [ -n "$TRACKED_PID" ]; then
            # Was tracking one — it died
            # Try to get exit info from wait (won't work for non-child, but try)
            _on_death "$TRACKED_PID" "process_gone"
            TRACKED_PID=""
        fi
        # else: no server, nothing to track
    else
        if [ "$CURRENT_PID" != "$TRACKED_PID" ]; then
            if [ -n "$TRACKED_PID" ]; then
                # PID changed — old one died, new one appeared
                _on_death "$TRACKED_PID" "pid_changed_to=$CURRENT_PID"
            fi
            TRACKED_PID="$CURRENT_PID"
            _log "Tracking tmux-server PID=$TRACKED_PID"
            _snapshot_process "$TRACKED_PID"
            SNAPSHOT_COUNTER=0
        fi

        # Periodic snapshot every 60 polls (~3 minutes)
        SNAPSHOT_COUNTER=$((SNAPSHOT_COUNTER + 1))
        if [ $((SNAPSHOT_COUNTER % 60)) -eq 0 ]; then
            _log "Periodic snapshot PID=$TRACKED_PID"
            _snapshot_process "$TRACKED_PID"
        fi
    fi

    [ "${1:-}" = "--once" ] && exit 0
    sleep "$POLL_INTERVAL"
done
