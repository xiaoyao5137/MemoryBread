#!/bin/bash
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

DEBUG_MODE=false
case "${MEMORYBREAD_DEBUG_MODE:-}" in
  1|true|TRUE|yes|YES|on|ON|debug|DEBUG)
    DEBUG_MODE=true
    ;;
esac

case "${1:-}" in
  "")
    ;;
  debug|--debug|--debug-mode|--debug=true|--debug-mode=true)
    DEBUG_MODE=true
    ;;
  normal|release|nodebug|no-debug|--no-debug|--debug=false|--debug-mode=false)
    DEBUG_MODE=false
    ;;
  *)
    echo "Usage: $0 [--debug|--no-debug]"
    exit 1
    ;;
esac

VITE_MEMORYBREAD_DEBUG_MODE="$DEBUG_MODE" npm run tauri dev
