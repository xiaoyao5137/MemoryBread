#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"

cleanup() {
    local status=$?
    trap - EXIT
    rm -rf "$TEST_ROOT"
    exit "$status"
}
trap cleanup EXIT

export MEMORYBREAD_MB_ALL_CHILD=1

# shellcheck source=../start.sh
source "$PROJECT_ROOT/start.sh"

TEST_MEMORY_HOME="$TEST_ROOT/home"
LOG_DIR="$TEST_MEMORY_HOME/.memory-bread/logs"
STATE_DIR="$TEST_MEMORY_HOME/.memory-bread/state"
UI_APP_PID_FILE="$LOG_DIR/ui_app.pid"
SUPERVISOR_SHUTDOWN_MARKER="$STATE_DIR/supervisor-shutdown-in-progress"
mkdir -p "$LOG_DIR" "$STATE_DIR"

STOP_CALLED="$TEST_ROOT/stop-called"
stop_all() {
    touch "$STOP_CALLED"
}

printf '888888\n' > "$UI_APP_PID_FILE"
(stop_after_app 999999)
if [ -f "$STOP_CALLED" ]; then
    echo "stale desktop cleanup stopped the replacement process" >&2
    exit 1
fi

printf '999999\n' > "$UI_APP_PID_FILE"
touch "$SUPERVISOR_SHUTDOWN_MARKER"
(stop_after_app 999999)
if [ -f "$STOP_CALLED" ]; then
    echo "supervisor marker did not suppress duplicate cleanup" >&2
    exit 1
fi

rm -f "$SUPERVISOR_SHUTDOWN_MARKER"
(stop_after_app 999999)
if [ ! -f "$STOP_CALLED" ]; then
    echo "current desktop quit did not stop managed services" >&2
    exit 1
fi

RESTART_MARKER_SEEN="$TEST_ROOT/restart-marker-seen"
parse_start_options() { return 0; }
warn_if_multiple_desktop_apps() { return 0; }
sleep() { return 0; }
check_path_leaks() { return 0; }
check_dependencies() { return 0; }
ensure_ollama_running() { return 0; }
start_sidecar() { return 0; }
start_creation_service() { return 0; }
start_core() { return 0; }
show_status() { return 0; }
stop_all() { touch "$SUPERVISOR_SHUTDOWN_MARKER"; }
start_ui() {
    [ -f "$SUPERVISOR_SHUTDOWN_MARKER" ]
    touch "$RESTART_MARKER_SEEN"
}

(main restart >/dev/null)
if [ ! -f "$RESTART_MARKER_SEEN" ] || [ -f "$SUPERVISOR_SHUTDOWN_MARKER" ]; then
    echo "restart marker did not cover the complete replacement window" >&2
    exit 1
fi

ensure_ollama_running() { exit 7; }
if (main restart >/dev/null 2>&1); then
    echo "mocked restart failure unexpectedly succeeded" >&2
    exit 1
fi
if [ -f "$SUPERVISOR_SHUTDOWN_MARKER" ]; then
    echo "failed restart left a stale supervisor marker" >&2
    exit 1
fi

echo "restart shutdown race checks passed"
