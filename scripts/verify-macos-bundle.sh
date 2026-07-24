#!/bin/bash

set -euo pipefail

APP_PATH="${1:-}"
MODE="${2:-dmg}"

fail() {
  echo "[macOS verify] $*" >&2
  exit 1
}

[ -d "$APP_PATH" ] || fail "用法: $0 /path/to/记忆面包.app [dmg|appstore]"
[ "$MODE" = "dmg" ] || [ "$MODE" = "appstore" ] \
  || fail "校验模式必须是 dmg 或 appstore"

INFO_PLIST="$APP_PATH/Contents/Info.plist"
MAIN_BIN="$APP_PATH/Contents/MacOS/memory-bread-desktop"
CORE_BIN="$APP_PATH/Contents/MacOS/memory-bread-core"
AI_APP="$APP_PATH/Contents/Helpers/memory-bread-ai.app"
AI_BIN="$AI_APP/Contents/MacOS/memory-bread-ai"

for path in "$INFO_PLIST" "$MAIN_BIN" "$CORE_BIN" "$AI_APP" "$AI_BIN"; do
  [ -e "$path" ] || fail "App Bundle 缺少: $path"
done

IDENTIFIER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO_PLIST")"
[ "$IDENTIFIER" = "com.memory-bread.app" ] || fail "Bundle ID 错误: $IDENTIFIER"
MINIMUM_SYSTEM="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$INFO_PLIST")"
[ "${MINIMUM_SYSTEM%%.*}" -ge 12 ] || fail "最低系统版本必须不低于 macOS 12: $MINIMUM_SYSTEM"

for binary in "$MAIN_BIN" "$CORE_BIN" "$AI_BIN"; do
  file "$binary" | grep -q 'Mach-O' || fail "不是 Mach-O: $binary"
done

codesign --verify --deep --strict "$APP_PATH"

if [ "$MODE" = "appstore" ]; then
  [ -f "$APP_PATH/Contents/embedded.provisionprofile" ] \
    || fail "App Store 包缺少 embedded.provisionprofile"
  MAIN_ENTITLEMENTS="$(codesign -d --entitlements :- "$APP_PATH" 2>/dev/null)"
  CHILD_ENTITLEMENTS="$(codesign -d --entitlements :- "$CORE_BIN" 2>/dev/null)"
  AI_ENTITLEMENTS="$(codesign -d --entitlements :- "$AI_APP" 2>/dev/null)"
  printf '%s' "$MAIN_ENTITLEMENTS" | grep -q 'com.apple.security.app-sandbox' \
    || fail "主 App 缺少 App Sandbox entitlement"
  printf '%s' "$MAIN_ENTITLEMENTS" | grep -q 'com.apple.security.network.client' \
    || fail "主 App 缺少 network.client entitlement"
  printf '%s' "$MAIN_ENTITLEMENTS" | grep -q 'com.apple.security.network.server' \
    || fail "主 App 缺少 network.server entitlement"
  printf '%s' "$CHILD_ENTITLEMENTS" | grep -q 'com.apple.security.inherit' \
    || fail "helper 缺少 sandbox inherit entitlement"
  printf '%s' "$AI_ENTITLEMENTS" | grep -q 'com.apple.security.inherit' \
    || fail "AI helper 缺少 sandbox inherit entitlement"
fi

echo "[macOS verify] 通过: $APP_PATH ($MODE)"
