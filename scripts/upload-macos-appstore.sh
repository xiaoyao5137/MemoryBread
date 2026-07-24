#!/bin/bash

set -euo pipefail

PKG_PATH="${1:-}"

fail() {
  echo "[App Store upload] $*" >&2
  exit 1
}

[ -f "$PKG_PATH" ] || fail "用法: $0 /path/to/记忆面包.pkg"
[ -n "${APPLE_API_KEY_ID:-}" ] || fail "缺少 APPLE_API_KEY_ID"
[ -n "${APPLE_API_ISSUER:-}" ] || fail "缺少 APPLE_API_ISSUER"
command -v xcrun >/dev/null 2>&1 || fail "缺少 Xcode xcrun"

echo "[App Store upload] 先校验 PKG..."
xcrun altool \
  --validate-app \
  --type macos \
  --file "$PKG_PATH" \
  --apiKey "$APPLE_API_KEY_ID" \
  --apiIssuer "$APPLE_API_ISSUER"

echo "[App Store upload] 校验通过，开始上传..."
xcrun altool \
  --upload-app \
  --type macos \
  --file "$PKG_PATH" \
  --apiKey "$APPLE_API_KEY_ID" \
  --apiIssuer "$APPLE_API_ISSUER"
