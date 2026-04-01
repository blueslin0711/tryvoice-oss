#!/usr/bin/env bash
# TryVoice 开发环境启停脚本
#
# Usage:
#   bash scripts/dev.sh start    # 启动前后端开发环境
#   bash scripts/dev.sh stop     # 停止前后端
#   bash scripts/dev.sh status   # 查看运行状态
#   bash scripts/dev.sh restart  # 重启前后端
#
# 前端: https://localhost:5170 (Vite dev server)
# 后端: http://localhost:7860  (FastAPI)

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/apps/client-web/frontend"
BACKEND_PORT=7860
FRONTEND_PORT=5170

# ── 辅助函数 ──────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info() { echo "${BLUE}[INFO]${NC} $1"; }
ok()   { echo "${GREEN}[OK]${NC} $1"; }
warn() { echo "${YELLOW}[WARN]${NC} $1"; }
err()  { echo "${RED}[ERR]${NC} $1"; }

# 检查端口是否有进程
check_port() {
    local port=$1
    if lsof -i :$port -t >/dev/null 2>&1; then
        return 0  # 有进程
    else
        return 1  # 无进程
    fi
}

# 获取端口进程信息
get_port_process() {
    local port=$1
    lsof -i :$port 2>/dev/null | grep LISTEN | head -1 || echo "none"
}

# ── 启动 ──────────────────────────────────────────────────────────────────

start_backend() {
    info "启动后端..."

    if check_port $BACKEND_PORT; then
        warn "后端已在运行 (端口 $BACKEND_PORT)"
        return 0
    fi

    cd "$REPO_ROOT"
    source .venv/bin/activate

    # 后台启动后端
    nohup python -m backend.cli --no-browser > /tmp/tryvoice-backend.log 2>&1 &
    BACKEND_PID=$!
    echo $BACKEND_PID > /tmp/tryvoice-backend.pid

    # 等待后端启动
    for i in {1..10}; do
        if curl -s http://localhost:$BACKEND_PORT/health >/dev/null 2>&1; then
            ok "后端已启动 (PID: $BACKEND_PID, 端口: $BACKEND_PORT)"
            return 0
        fi
        sleep 0.5
    done

    err "后端启动失败，查看日志: /tmp/tryvoice-backend.log"
    return 1
}

start_frontend() {
    info "启动前端..."

    if check_port $FRONTEND_PORT; then
        warn "前端已在运行 (端口 $FRONTEND_PORT)"
        return 0
    fi

    cd "$FRONTEND_DIR"

    # 设置后端代理目标为 HTTP
    export VITE_BACKEND_TARGET="http://localhost:$BACKEND_PORT"

    # 后台启动前端
    nohup npm run dev > /tmp/tryvoice-frontend.log 2>&1 &
    FRONTEND_PID=$!
    echo $FRONTEND_PID > /tmp/tryvoice-frontend.pid

    # 等待前端启动
    for i in {1..10}; do
        if curl -sk https://localhost:$FRONTEND_PORT >/dev/null 2>&1; then
            ok "前端已启动 (PID: $FRONTEND_PID, 端口: $FRONTEND_PORT)"
            return 0
        fi
        sleep 0.5
    done

    err "前端启动失败，查看日志: /tmp/tryvoice-frontend.log"
    return 1
}

do_start() {
    echo ""
    echo "============================================"
    echo "  TryVoice 开发环境启动"
    echo "============================================"
    echo ""

    start_backend
    start_frontend

    echo ""
    echo "============================================"
    echo "  开发环境已就绪"
    echo "============================================"
    echo ""
    echo "  前端:  https://localhost:$FRONTEND_PORT"
    echo "  后端:  http://localhost:$BACKEND_PORT"
    echo ""
    echo "  日志位置:"
    echo "    前端: /tmp/tryvoice-frontend.log"
    echo "    后端: /tmp/tryvoice-backend.log"
    echo ""
    echo "  停止:  bash scripts/dev.sh stop"
    echo ""
}

# ── 停止 ──────────────────────────────────────────────────────────────────

stop_backend() {
    info "停止后端..."

    if [ -f /tmp/tryvoice-backend.pid ]; then
        PID=$(cat /tmp/tryvoice-backend.pid)
        if kill -0 $PID 2>/dev/null; then
            kill $PID 2>/dev/null || true
            rm /tmp/tryvoice-backend.pid
            ok "后端已停止 (PID: $PID)"
        else
            rm /tmp/tryvoice-backend.pid
            warn "后端 PID 文件存在但进程已不存在"
        fi
    fi

    # 确保端口上没有残留进程
    if check_port $BACKEND_PORT; then
        info "清理端口 $BACKEND_PORT 上的进程..."
        lsof -i :$BACKEND_PORT -t | xargs kill 2>/dev/null || true
        ok "端口 $BACKEND_PORT 已清理"
    else
        info "后端未运行"
    fi
}

stop_frontend() {
    info "停止前端..."

    if [ -f /tmp/tryvoice-frontend.pid ]; then
        PID=$(cat /tmp/tryvoice-frontend.pid)
        if kill -0 $PID 2>/dev/null; then
            kill $PID 2>/dev/null || true
            rm /tmp/tryvoice-frontend.pid
            ok "前端已停止 (PID: $PID)"
        else
            rm /tmp/tryvoice-frontend.pid
            warn "前端 PID 文件存在但进程已不存在"
        fi
    fi

    # 确保端口上没有残留进程
    if check_port $FRONTEND_PORT; then
        info "清理端口 $FRONTEND_PORT 上的进程..."
        lsof -i :$FRONTEND_PORT -t | xargs kill 2>/dev/null || true
        ok "端口 $FRONTEND_PORT 已清理"
    else
        info "前端未运行"
    fi
}

do_stop() {
    echo ""
    echo "============================================"
    echo "  TryVoice 开发环境停止"
    echo "============================================"
    echo ""

    stop_frontend
    stop_backend

    echo ""
    ok "开发环境已停止"
    echo ""
}

# ── 状态 ──────────────────────────────────────────────────────────────────

do_status() {
    echo ""
    echo "============================================"
    echo "  TryVoice 开发环境状态"
    echo "============================================"
    echo ""

    # 后端状态
    if check_port $BACKEND_PORT; then
        PROCESS=$(get_port_process $BACKEND_PORT)
        HEALTH=$(curl -s http://localhost:$BACKEND_PORT/health 2>/dev/null | head -c 50 || echo "N/A")
        echo "  后端: ${GREEN}运行中${NC}"
        echo "    端口:  $BACKEND_PORT"
        echo "    进程:  $PROCESS"
        echo "    健康:  $HEALTH..."
    else
        echo "  后端: ${RED}未运行${NC}"
    fi

    echo ""

    # 前端状态
    if check_port $FRONTEND_PORT; then
        PROCESS=$(get_port_process $FRONTEND_PORT)
        echo "  前端: ${GREEN}运行中${NC}"
        echo "    端口:  $FRONTEND_PORT"
        echo "    进程:  $PROCESS"
        echo "    URL:   https://localhost:$FRONTEND_PORT"
    else
        echo "  前端: ${RED}未运行${NC}"
    fi

    echo ""

    # PID 文件状态
    if [ -f /tmp/tryvoice-backend.pid ]; then
        echo "  后端 PID: $(cat /tmp/tryvoice-backend.pid)"
    fi
    if [ -f /tmp/tryvoice-frontend.pid ]; then
        echo "  前端 PID: $(cat /tmp/tryvoice-frontend.pid)"
    fi

    echo ""
}

# ── 重启 ──────────────────────────────────────────────────────────────────

do_restart() {
    do_stop
    sleep 1
    do_start
}

# ── 日志 ──────────────────────────────────────────────────────────────────

do_logs() {
    echo ""
    echo "============================================"
    echo "  TryVoice 开发环境日志"
    echo "============================================"
    echo ""

    echo "后端日志 (最近 30 行):"
    echo "---"
    # 尝试提取 JSON 日志中的关键信息
    if [ -f /tmp/tryvoice-backend.log ]; then
        tail -30 /tmp/tryvoice-backend.log | while read -r line; do
            # 如果是 JSON 格式，提取 text 字段
            if echo "$line" | jq -e '.text' >/dev/null 2>&1; then
                echo "$line" | jq -r '.text' 2>/dev/null || echo "$line"
            else
                echo "$line"
            fi
        done
    else
        echo "无日志文件"
    fi
    echo ""

    echo "前端日志 (最近 20 行):"
    echo "---"
    tail -20 /tmp/tryvoice-frontend.log 2>/dev/null || echo "无日志文件"
    echo ""
}

# ── 实时日志追踪 ──────────────────────────────────────────────────────────

do_follow() {
    echo ""
    echo "============================================"
    echo "  TryVoice 实时日志追踪 (Ctrl+C 退出)"
    echo "============================================"
    echo ""

    # 创建临时文件用于合并日志
    echo "追踪后端和前端日志..."
    echo ""

    # 使用 tail -f 同时追踪两个日志
    tail -f /tmp/tryvoice-backend.log 2>/dev/null | while read -r line; do
        # 如果是 JSON 格式，提取 text 字段
        if echo "$line" | jq -e '.text' >/dev/null 2>&1; then
            echo "[后端] $(echo "$line" | jq -r '.text' 2>/dev/null)"
        else
            echo "[后端] $line"
        fi
    done &
    BACKEND_TAIL_PID=$!

    tail -f /tmp/tryvoice-frontend.log 2>/dev/null | while read -r line; do
        echo "[前端] $line"
    done &
    FRONTEND_TAIL_PID=$!

    # 等待用户按 Ctrl+C
    trap "kill $BACKEND_TAIL_PID $FRONTEND_TAIL_PID 2>/dev/null; echo ''; echo '已停止追踪'; exit 0" INT
    wait
}

# ── 主入口 ────────────────────────────────────────────────────────────────

case "${1:-}" in
    start)
        do_start
        ;;
    stop)
        do_stop
        ;;
    status)
        do_status
        ;;
    restart)
        do_restart
        ;;
    logs)
        do_logs
        ;;
    follow|tail)
        do_follow
        ;;
    *)
        echo ""
        echo "TryVoice 开发环境管理脚本"
        echo ""
        echo "用法:"
        echo "  bash scripts/dev.sh start    启动前后端"
        echo "  bash scripts/dev.sh stop     停止前后端"
        echo "  bash scripts/dev.sh status   查看运行状态"
        echo "  bash scripts/dev.sh restart  重启前后端"
        echo "  bash scripts/dev.sh logs     查看日志"
        echo "  bash scripts/dev.sh follow   实时追踪日志"
        echo ""
        exit 1
        ;;
esac