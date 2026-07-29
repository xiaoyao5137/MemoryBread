#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR_ROOT="$PROJECT_ROOT/ai-sidecar"
PYTHON_BIN="${MEMORY_BREAD_TEST_PYTHON:-$SIDECAR_ROOT/.venv/bin/python}"

if [ ! -x "$PYTHON_BIN" ]; then
    echo "未找到 sidecar 测试环境: $PYTHON_BIN" >&2
    exit 1
fi

cd "$SIDECAR_ROOT"

case "${1:-}" in
    "")
        exec "$PYTHON_BIN" -m pytest --noconftest \
            tests/test_initialization_manager.py \
            tests/test_initialization_cold_sandbox.py \
            -q
        ;;
    --live)
        CARGO_BIN="${MEMORY_BREAD_TEST_CARGO:-}"
        if [ -z "$CARGO_BIN" ]; then
            CARGO_BIN="$(command -v cargo || true)"
        fi
        if [ -z "$CARGO_BIN" ] && [ -x "$HOME/.cargo/bin/cargo" ]; then
            CARGO_BIN="$HOME/.cargo/bin/cargo"
        fi
        if [ -z "$CARGO_BIN" ] || [ ! -x "$CARGO_BIN" ]; then
            echo "真实初始化验收需要 Cargo 构建当前 Core Engine，未找到可执行的 cargo。" >&2
            exit 1
        fi
        (
            cd "$PROJECT_ROOT/core-engine"
            "$CARGO_BIN" build --release
        )
        export MEMORY_BREAD_RUN_LIVE_INITIALIZATION_E2E=1
        exec "$PYTHON_BIN" -m pytest --noconftest \
            tests/test_initialization_live_e2e.py \
            -m live_initialization \
            -vv
        ;;
    *)
        echo "用法: $0 [--live]" >&2
        echo "  默认：使用轻量假运行时连续验证两轮冷初始化，不下载真实模型" >&2
        echo "  --live：通过 7071 下载真实运行时和模型，完成后自动恢复并清理沙箱" >&2
        exit 2
        ;;
esac
