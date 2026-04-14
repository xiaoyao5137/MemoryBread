#!/bin/bash
#
# 记忆面包 启动脚本
#
# 按顺序启动三个组件：
# 1. AI Sidecar (Python，含 7072 内部检索服务)
# 2. Model API / RAG API (Python，7071，提供 /api/models + /query)
# 3. Core Engine (Rust)
# 4. Desktop UI (Tauri)
#

set -e  # 遇到错误立即退出

# 添加 Rust 和 Homebrew Node 到 PATH（nohup 启动时不继承用户 PATH）
if [ -d "$HOME/.cargo/bin" ]; then
    export PATH="$HOME/.cargo/bin:$PATH"
fi
if [ -d "/opt/homebrew/bin" ]; then
    export PATH="/opt/homebrew/bin:$PATH"
fi

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 项目根目录
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

check_path_leaks() {
    local leaked_paths=()
    local candidates=(
        "$PROJECT_ROOT/ai-sidecar/~/.workbuddy"
        "$PROJECT_ROOT/ai-sidecar/~/.qdrant"
        "$PROJECT_ROOT/~/.workbuddy"
        "$PROJECT_ROOT/~/.qdrant"
    )

    for path in "${candidates[@]}"; do
        if [ -e "$path" ]; then
            leaked_paths+=("$path")
        fi
    done

    if [ ${#leaked_paths[@]} -gt 0 ]; then
        log_error "检测到仓库内存在未展开的 home 路径残留："
        for path in "${leaked_paths[@]}"; do
            log_error "  - $path"
        done
        log_error "请先清理这些目录，再重新启动，避免模型和向量数据继续写入仓库目录。"
        exit 1
    fi
}

# 日志目录
LOG_DIR="$HOME/.memory-bread/logs"
mkdir -p "$LOG_DIR"

# PID 文件
SIDECAR_PID_FILE="$LOG_DIR/sidecar.pid"
MODEL_API_PID_FILE="$LOG_DIR/model_api.pid"
CORE_PID_FILE="$LOG_DIR/core.pid"
UI_PID_FILE="$LOG_DIR/ui.pid"
UI_APP_PID_FILE="$LOG_DIR/ui_app.pid"

# 日志文件
SIDECAR_LOG="$LOG_DIR/sidecar.log"
MODEL_API_LOG="$LOG_DIR/model_api.log"
CORE_LOG="$LOG_DIR/core.log"
UI_LOG="$LOG_DIR/ui.log"

CORE_PORT=7070
MODEL_API_PORT=7071
UI_PORT=1420

# 打印带颜色的消息
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查进程是否运行
is_running() {
    local pid_file=$1
    if [ -f "$pid_file" ]; then
        local pid=$(cat "$pid_file")
        if ps -p "$pid" > /dev/null 2>&1; then
            return 0
        fi
    fi
    return 1
}

cleanup_port() {
    local port=$1
    local label=$2
    local pids=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        log_info "清理占用 ${port} 端口的进程（${label}）: $pids"
        echo "$pids" | xargs kill 2>/dev/null || true
        sleep 1
        pids=$(lsof -ti :"$port" 2>/dev/null || true)
        if [ -n "$pids" ]; then
            echo "$pids" | xargs kill -9 2>/dev/null || true
        fi
    fi
}

cleanup_desktop_app() {
    local pids=$(pgrep -f "/target/debug/memory-bread-desktop|target/debug/memory-bread-desktop" || true)
    if [ -n "$pids" ]; then
        log_info "清理残留 Desktop UI 窗口进程: $pids"
        echo "$pids" | xargs kill 2>/dev/null || true
        sleep 1
        pids=$(pgrep -f "/target/debug/memory-bread-desktop|target/debug/memory-bread-desktop" || true)
        if [ -n "$pids" ]; then
            echo "$pids" | xargs kill -9 2>/dev/null || true
        fi
    fi
    rm -f "$UI_APP_PID_FILE"
}

find_desktop_app_pids() {
    pgrep -f "/target/debug/memory-bread-desktop|target/debug/memory-bread-desktop" || true
}

warn_if_multiple_desktop_apps() {
    local pids=$(find_desktop_app_pids)
    if [ -z "$pids" ]; then
        return 0
    fi

    local count=$(echo "$pids" | wc -l | tr -d '[:space:]')
    if [ "$count" -gt 1 ]; then
        log_warn "检测到 ${count} 个 Desktop UI 历史残留窗口进程，restart 将先自动清理: $(echo "$pids" | tr '\n' ' ' | xargs)"
    fi
}

record_desktop_app_pid() {
    local retries=${1:-20}
    local delay=${2:-1}

    for ((i=1; i<=retries; i++)); do
        local pids=$(find_desktop_app_pids)
        if [ -n "$pids" ]; then
            local pid=$(echo "$pids" | tail -n 1 | tr -d '[:space:]')
            if [ -n "$pid" ]; then
                echo "$pid" > "$UI_APP_PID_FILE"
                return 0
            fi
        fi
        sleep "$delay"
    done

    return 1
}

wait_for_http() {
    local url=$1
    local label=$2
    local retries=${3:-20}
    local delay=${4:-1}

    for ((i=1; i<=retries; i++)); do
        if curl -fsS "$url" > /dev/null 2>&1; then
            log_success "${label} 健康检查通过"
            return 0
        fi
        sleep "$delay"
    done

    log_warn "${label} 健康检查失败，请查看日志"
    return 1
}

show_status() {
    echo ""
    if is_running "$SIDECAR_PID_FILE"; then
        log_success "AI Sidecar: 运行中 (PID: $(cat "$SIDECAR_PID_FILE"))"
    else
        log_error "AI Sidecar: 未运行"
    fi

    if is_running "$MODEL_API_PID_FILE"; then
        log_success "Model API / RAG API: 运行中 (PID: $(cat "$MODEL_API_PID_FILE"), Port: ${MODEL_API_PORT})"
    else
        log_error "Model API / RAG API: 未运行"
    fi

    if is_running "$CORE_PID_FILE"; then
        log_success "Core Engine: 运行中 (PID: $(cat "$CORE_PID_FILE"), Port: ${CORE_PORT})"
    else
        log_error "Core Engine: 未运行"
    fi

    if is_running "$UI_PID_FILE"; then
        local ui_msg="Desktop UI: 运行中 (启动器 PID: $(cat "$UI_PID_FILE"), Port: ${UI_PORT}"
        if is_running "$UI_APP_PID_FILE"; then
            ui_msg+="，窗口 PID: $(cat "$UI_APP_PID_FILE")"
        fi
        ui_msg+=")"
        log_success "$ui_msg"
    else
        log_error "Desktop UI: 未运行"
    fi

    local desktop_pids=$(find_desktop_app_pids)
    if [ -n "$desktop_pids" ]; then
        local desktop_count=$(echo "$desktop_pids" | wc -l | tr -d '[:space:]')
        log_info "Desktop UI 窗口进程数: ${desktop_count} (PID: $(echo "$desktop_pids" | tr '\n' ' ' | xargs))"
    else
        log_info "Desktop UI 窗口进程数: 0"
    fi
    echo ""
}

# 停止所有服务
stop_all() {
    log_info "停止所有服务..."

    # 停止 Desktop UI（包括子进程）
    if is_running "$UI_PID_FILE"; then
        local pid=$(cat "$UI_PID_FILE")
        log_info "停止 Desktop UI (启动器 PID: $pid)"
        # 先尝试优雅关闭
        pkill -P "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null || true
        sleep 1
        # 如果还在运行，强制杀掉
        if ps -p "$pid" > /dev/null 2>&1; then
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$UI_PID_FILE"
    fi

    if is_running "$UI_APP_PID_FILE"; then
        local app_pid=$(cat "$UI_APP_PID_FILE")
        log_info "停止 Desktop UI 窗口进程 (PID: $app_pid)"
        kill "$app_pid" 2>/dev/null || true
        sleep 1
        if ps -p "$app_pid" > /dev/null 2>&1; then
            kill -9 "$app_pid" 2>/dev/null || true
        fi
        rm -f "$UI_APP_PID_FILE"
    fi

    cleanup_port "$UI_PORT" "Desktop UI / Vite"
    cleanup_desktop_app

    # 停止 Core Engine
    if is_running "$CORE_PID_FILE"; then
        local pid=$(cat "$CORE_PID_FILE")
        log_info "停止 Core Engine (PID: $pid)"
        kill "$pid" 2>/dev/null || true
        sleep 1
        if ps -p "$pid" > /dev/null 2>&1; then
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$CORE_PID_FILE"
    fi

    cleanup_port "$CORE_PORT" "Core Engine"

    # 停止 AI Sidecar
    if is_running "$SIDECAR_PID_FILE"; then
        local pid=$(cat "$SIDECAR_PID_FILE")
        log_info "停止 AI Sidecar (PID: $pid)"
        kill "$pid" 2>/dev/null || true
        sleep 1
        if ps -p "$pid" > /dev/null 2>&1; then
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$SIDECAR_PID_FILE"
    fi

    # 停止 Model API Server
    if is_running "$MODEL_API_PID_FILE"; then
        local pid=$(cat "$MODEL_API_PID_FILE")
        log_info "停止 Model API Server (PID: $pid)"
        kill "$pid" 2>/dev/null || true
        sleep 1
        if ps -p "$pid" > /dev/null 2>&1; then
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$MODEL_API_PID_FILE"
    fi

    cleanup_port "$MODEL_API_PORT" "Model API / RAG API"

    log_success "所有服务已停止"
}

# 检查依赖
check_dependencies() {
    log_info "检查依赖..."

    # 检查 Python
    if ! command -v python3 &> /dev/null; then
        log_error "未找到 python3，请先安装 Python 3.11+"
        exit 1
    fi

    # 检查 Rust
    if ! command -v cargo &> /dev/null; then
        log_error "未找到 cargo，请先安装 Rust"
        exit 1
    fi

    # 检查 Node.js
    if ! command -v node &> /dev/null; then
        log_error "未找到 node，请先安装 Node.js 18+"
        exit 1
    fi

    log_success "依赖检查通过"
}

# 启动 AI Sidecar
start_sidecar() {
    if is_running "$SIDECAR_PID_FILE" && is_running "$MODEL_API_PID_FILE"; then
        log_info "AI Sidecar 与 Model API 已在运行，复用现有进程"
        return 0
    fi

    if is_running "$SIDECAR_PID_FILE" && ! is_running "$MODEL_API_PID_FILE"; then
        log_warn "检测到 Model API 未运行，先停止现有 AI Sidecar 后整体拉起"
        local pid=$(cat "$SIDECAR_PID_FILE")
        kill "$pid" 2>/dev/null || true
        sleep 1
        if ps -p "$pid" > /dev/null 2>&1; then
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$SIDECAR_PID_FILE"
    fi

    if ! is_running "$SIDECAR_PID_FILE" && is_running "$MODEL_API_PID_FILE"; then
        log_warn "检测到 AI Sidecar 未运行，先停止现有 Model API 后整体拉起"
        local pid=$(cat "$MODEL_API_PID_FILE")
        kill "$pid" 2>/dev/null || true
        sleep 1
        if ps -p "$pid" > /dev/null 2>&1; then
            kill -9 "$pid" 2>/dev/null || true
        fi
        rm -f "$MODEL_API_PID_FILE"
    fi

    log_info "启动 AI Sidecar..."

    cd "$PROJECT_ROOT/ai-sidecar"

    # 检查虚拟环境
    if [ ! -d ".venv" ]; then
        log_warn "虚拟环境不存在，正在创建..."
        python3 -m venv .venv
        source .venv/bin/activate
        pip install -r requirements.txt
    else
        source .venv/bin/activate
    fi

    cleanup_port "$MODEL_API_PORT" "Model API / RAG API"

    # 启动 Sidecar（后台运行）
    nohup python main.py > "$SIDECAR_LOG" 2>&1 &
    echo $! > "$SIDECAR_PID_FILE"

    # 启动 Model API / RAG API Server（后台运行）
    nohup python model_api_server.py > "$MODEL_API_LOG" 2>&1 &
    echo $! > "$MODEL_API_PID_FILE"

    log_success "AI Sidecar 已启动 (PID: $(cat "$SIDECAR_PID_FILE"))"
    log_success "Model API / RAG API 已启动 (PID: $(cat "$MODEL_API_PID_FILE"))"
    log_info "Sidecar 日志文件: $SIDECAR_LOG"
    log_info "Model API / RAG API 日志文件: $MODEL_API_LOG"

    # 等待 Sidecar 与 7071 API 启动
    log_info "等待 AI Sidecar 初始化..."
    sleep 3
    wait_for_http "http://localhost:${MODEL_API_PORT}/health" "Model API / RAG API" 40 2 || {
        log_warn "Model API / RAG API 未就绪，可查看日志: $MODEL_API_LOG"
    }
}

# 启动 Core Engine
start_core() {
    if is_running "$CORE_PID_FILE"; then
        log_info "Core Engine 已在运行，复用现有进程"
        return 0
    fi

    log_info "启动 Core Engine..."

    cd "$PROJECT_ROOT/core-engine"

    # 构建最新 Core Engine
    log_info "构建最新 Core Engine..."
    cargo build --release

    cleanup_port "$CORE_PORT" "Core Engine"

    # 启动 Core Engine（后台运行）
    nohup ./target/release/memory-bread > "$CORE_LOG" 2>&1 &
    echo $! > "$CORE_PID_FILE"

    log_success "Core Engine 已启动 (PID: $(cat "$CORE_PID_FILE"))"
    log_info "日志文件: $CORE_LOG"

    # 等待 Core Engine 启动
    log_info "等待 Core Engine 初始化..."
    sleep 3

    wait_for_http "http://localhost:${CORE_PORT}/health" "Core Engine"
}

# 启动 Desktop UI
start_ui() {
    if is_running "$UI_PID_FILE"; then
        log_info "Desktop UI 已在运行，复用现有进程"
        return 0
    fi

    log_info "启动 Desktop UI..."

    cd "$PROJECT_ROOT/desktop-ui"

    # 检查 node_modules
    if [ ! -d "node_modules" ]; then
        log_warn "node_modules 不存在，正在安装依赖..."
        npm install
    fi

    # 确保 Rust 在 PATH 中
    export PATH="$HOME/.cargo/bin:$PATH"

    cleanup_port "$UI_PORT" "Desktop UI / Vite"
    cleanup_desktop_app

    # 启动 Tauri 开发服务器（后台运行）
    log_info "启动 Tauri 开发服务器..."
    nohup npm run tauri:dev > "$UI_LOG" 2>&1 &
    echo $! > "$UI_PID_FILE"

    log_success "Desktop UI 已启动 (启动器 PID: $(cat "$UI_PID_FILE"))"
    log_info "日志文件: $UI_LOG"
    log_info "等待 Desktop UI 初始化..."
    sleep 5

    if record_desktop_app_pid 20 1; then
        log_success "Desktop UI 窗口进程已记录 (PID: $(cat "$UI_APP_PID_FILE"))"
    else
        log_warn "未能记录 Desktop UI 窗口进程 PID，后续将依赖残留扫描兜底"
    fi

    if curl -fsS "http://localhost:${UI_PORT}" > /dev/null 2>&1; then
        log_success "Desktop UI / Vite 健康检查通过"
    else
        log_warn "Desktop UI / Vite 健康检查失败，请查看日志"
    fi
}

# 主函数
main() {
    echo ""
    echo "╔════════════════════════════════════════╗"
    echo "║     记忆面包 启动脚本 v1.0           ║"
    echo "╚════════════════════════════════════════╝"
    echo ""

    # 解析命令行参数
    case "${1:-start}" in
        start)
            check_path_leaks
            check_dependencies
            start_sidecar
            start_core
            start_ui
            show_status
            ;;
        stop)
            stop_all
            ;;
        restart)
            log_info "执行全组件 restart（AI Sidecar → Core Engine → Desktop UI）..."
            warn_if_multiple_desktop_apps
            stop_all
            sleep 2
            check_path_leaks
            check_dependencies
            start_sidecar
            start_core
            start_ui
            show_status
            log_info "联调测试前请优先使用 ./start.sh restart，7071 由 model_api_server.py 统一提供 /api/models + /query，避免旧进程状态污染测试结果"
            ;;
        status)
            show_status
            ;;
        logs)
            log_info "查看日志 (Ctrl+C 退出)..."
            tail -f "$SIDECAR_LOG" "$CORE_LOG" "$UI_LOG" 2>/dev/null
            ;;
        *)
            echo "用法: $0 {start|stop|restart|status|logs}"
            echo ""
            echo "命令说明:"
            echo "  start   - 启动所有服务"
            echo "  stop    - 停止所有服务"
            echo "  restart - 重启所有服务"
            echo "  status  - 查看服务状态"
            echo "  logs    - 查看实时日志"
            exit 1
            ;;
    esac
}

# 捕获 Ctrl+C 信号
trap 'echo ""; log_info "收到中断信号，正在停止服务..."; stop_all; exit 0' INT TERM

# 执行主函数
main "$@"
