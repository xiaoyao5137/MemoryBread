#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

export HOME="$TEST_ROOT/home"
mkdir -p "$HOME"

# shellcheck source=../start.sh
source "$PROJECT_ROOT/start.sh"

MARKER="$TEST_ROOT/process.pid"
SOURCE_FILE="$TEST_ROOT/service.py"
SOURCE_DIR="$TEST_ROOT/service"
mkdir -p "$SOURCE_DIR"

touch "$SOURCE_FILE"
touch "$SOURCE_DIR/module.py"
sleep 1
touch "$MARKER"

if any_file_newer_than "$MARKER" "$SOURCE_FILE" "$SOURCE_DIR"; then
    echo "older source was incorrectly treated as newer" >&2
    exit 1
fi

sleep 1
touch "$SOURCE_FILE"
if ! any_file_newer_than "$MARKER" "$SOURCE_FILE"; then
    echo "newer source file was not detected" >&2
    exit 1
fi

sleep 1
touch "$SOURCE_DIR/module.py"
if ! any_file_newer_than "$MARKER" "$SOURCE_DIR"; then
    echo "newer source inside directory was not detected" >&2
    exit 1
fi

rm -f "$MARKER"
if ! any_file_newer_than "$MARKER" "$SOURCE_FILE"; then
    echo "missing process marker should require a restart" >&2
    exit 1
fi

echo "startup freshness checks passed"
