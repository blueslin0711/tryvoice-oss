#!/usr/bin/env bash
#
# TryVoice 开发辅助脚本
#
# 功能：
#   - 启动服务（前端 + 后端开发模式）
#   - 停止服务
#   - 日志监测（实时查看、按模块/级别过滤）
#   - 状态检查
#
# 使用：
#   bash scripts/dev.sh start       # 启动前后端
#   bash scripts/dev.sh stop        # 停止服务
#   bash scripts/dev.sh logs        # 查看所有日志
#   bash scripts/dev.sh logs backend # 仅后端日志
#   bash scripts/dev.sh logs client  # 仅前端日志
#   bash scripts/dev.sh logs crash   # 仅崩溃日志
#   bash scripts/dev.sh watch [module] [level] # 实时日志监测
#   bash scripts/dev.sh status      # 检查服务状态
#   bash scripts/dev.sh help        # 显示帮助
#
# 日志监测参数：
#   module: adapter, session, voice, ws, config, mirror, history, all
#   level: DEBUG, INFO, WARNING, ERROR
#
# 示例：
#   bash scripts/dev.sh watch adapter INFO    # 监测 adapter 模块 INFO 及以上
#   bash scripts/dev.sh watch session DEBUG   # 监测 session 模块所有日志
#   bash scripts/dev.sh watch all ERROR       # 监测所有 ERROR 日志

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ── 颜色定义 ──────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
BOLD='\033[1m'
RESET='\033[0m'

# ── 路径定义 ──────────────────────────────────────────────────────────────────────

USER_DATA_DIR="${TRYVOICE_USER_DATA_DIR:-$HOME/.tryvoice}"
if [ ! -d "$USER_DATA_DIR" ]; then
    USER_DATA_DIR="$HOME/.tryclaw-chat"
fi
LOG_DIR="$USER_DATA_DIR/logs"
SERVER_LOG="$LOG_DIR/server.log"
CLIENT_LOG="$LOG_DIR/client.log"
CRASH_LOG="$LOG_DIR/crash.log"

VENV_DIR="$REPO_ROOT/.venv"
FRONTEND_DIR="$REPO_ROOT/apps/client-web/frontend"

PID_FILE="$USER_DATA_DIR/.dev.pid"
TMUX_SESSION="tryvoice-dev"

# ── 辅助函数 ──────────────────────────────────────────────────────────────────────

print_header() {
    echo ""
    echo "${BOLD}${CYAN}╔════════════════════════════════════════════════════════════╗${RESET}"
    echo "${BOLD}${CYAN}║                    TryVoice Dev Helper                     ║${RESET}"
    echo "${BOLD}${CYAN}╚════════════════════════════════════════════════════════════╝${RESET}"
    echo ""
}

print_section() {
    echo ""
    echo "${BOLD}${BLUE}── $1 ──${RESET}"
}

log_info() {
    echo "${GREEN}✓${RESET} $1"
}

log_warn() {
    echo "${YELLOW}!${RESET} $1"
}

log_error() {
    echo "${RED}✗${RESET} $1"
}

check_venv() {
    if [ ! -d "$VENV_DIR" ]; then
        log_error "虚拟环境不存在，请先运行: bash scripts/setup.sh"
        exit 1
    fi
}

check_logs_dir() {
    if [ ! -d "$LOG_DIR" ]; then
        mkdir -p "$LOG_DIR"
        log_info "创建日志目录: $LOG_DIR"
    fi
}

# ── 启动服务 ──────────────────────────────────────────────────────────────────────

start_services() {
    print_section "启动开发服务"

    # 检查是否已运行
    if [ -f "$PID_FILE" ]; then
        log_warn "服务可能已在运行 (PID文件存在: $PID_FILE)"
        read -p "是否强制重启? [y/N]: " confirm
        if [[ "$confirm" =~ ^[Yy]$ ]]; then
            stop_services
        else
            echo "取消启动"
            exit 0
        fi
    fi

    check_venv

    # 设置开发环境变量
    export SERVER_LOG_LEVEL=DEBUG
    export SERVER_LOG_FORMAT=text  # 开发模式用文本格式，方便阅读
    export TRYVOICE_DEV_MODE=1

    # 启动后端 (tmux)
    log_info "启动后端服务..."
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    tmux new-session -d -s "$TMUX_SESSION" -x 200 -y 50

    # 后端窗口
    tmux rename-window -t "$TMUX_SESSION:0" "backend"
    tmux send-keys -t "$TMUX_SESSION:backend" "cd $REPO_ROOT" Enter
    tmux send-keys -t "$TMUX_SESSION:backend" "source $VENV_DIR/bin/activate" Enter
    tmux send-keys -t "$TMUX_SESSION:backend" "python -m backend.cli --no-browser --port 7860" Enter

    # 前端窗口
    tmux new-window -t "$TMUX_SESSION" -n "frontend"
    tmux send-keys -t "$TMUX_SESSION:frontend" "cd $FRONTEND_DIR" Enter
    tmux send-keys -t "$TMUX_SESSION:frontend" "npm run dev" Enter

    # 日志窗口
    tmux new-window -t "$TMUX_SESSION" -n "logs"
    tmux send-keys -t "$TMUX_SESSION:logs" "cd $REPO_ROOT" Enter
    tmux send-keys -t "$TMUX_SESSION:logs" "tail -f $SERVER_LOG" Enter

    # 保存 PID
    echo "tmux: $TMUX_SESSION" > "$PID_FILE"
    tmux_pid=$(pgrep -f "tmux.*$TMUX_SESSION" | head -1)
    echo "tmux_pid: $tmux_pid" >> "$PID_FILE"

    log_info "服务已启动"
    echo ""
    echo "${CYAN}访问地址:${RESET}"
    echo "  后端:  http://localhost:7860"
    echo "  前端:  http://localhost:5173 (Vite dev server)"
    echo ""
    echo "${CYAN}tmux 会话:${RESET}"
    echo "  查看所有窗口:  tmux attach -t $TMUX_SESSION"
    echo "  仅查看后端:   tmux attach -t $TMUX_SESSION:backend"
    echo "  仅查看前端:   tmux attach -t $TMUX_SESSION:frontend"
    echo "  仅查看日志:   tmux attach -t $TMUX_SESSION:logs"
    echo "  退出 tmux:    Ctrl+B 然后按 D"
    echo ""
}

# ── 停止服务 ──────────────────────────────────────────────────────────────────────

stop_services() {
    print_section "停止开发服务"

    # 停止 tmux 会话
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        log_info "停止 tmux 会话: $TMUX_SESSION"
        tmux kill-session -t "$TMUX_SESSION"
    else
        log_warn "tmux 会话不存在"
    fi

    # 额外清理可能残留的进程
    pkill -f "python.*backend.cli" 2>/dev/null || true
    pkill -f "vite.*7860" 2>/dev/null || true

    # 清理 PID 文件
    rm -f "$PID_FILE"

    log_info "服务已停止"
}

# ── 查看日志 ──────────────────────────────────────────────────────────────────────

view_logs() {
    local log_type="${1:-all}"
    check_logs_dir

    print_section "查看日志 [$log_type]"

    case "$log_type" in
        backend|server)
            if [ -f "$SERVER_LOG" ]; then
                echo "${GRAY}── server.log (最近100行) ──${RESET}"
                tail -100 "$SERVER_LOG"
            else
                log_warn "后端日志不存在: $SERVER_LOG"
            fi
            ;;
        client)
            if [ -f "$CLIENT_LOG" ]; then
                echo "${GRAY}── client.log (最近100行) ──${RESET}"
                tail -100 "$CLIENT_LOG"
            else
                log_warn "客户端日志不存在: $CLIENT_LOG"
            fi
            ;;
        crash)
            if [ -f "$CRASH_LOG" ]; then
                echo "${GRAY}── crash.log (全部) ──${RESET}"
                cat "$CRASH_LOG"
            else
                log_warn "崩溃日志不存在: $CRASH_LOG"
            fi
            ;;
        all)
            echo "${GRAY}── server.log (最近50行) ──${RESET}"
            [ -f "$SERVER_LOG" ] && tail -50 "$SERVER_LOG" || echo "(无日志)"
            echo ""
            echo "${GRAY}── client.log (最近30行) ──${RESET}"
            [ -f "$CLIENT_LOG" ] && tail -30 "$CLIENT_LOG" || echo "(无日志)"
            echo ""
            echo "${GRAY}── crash.log (最近20行) ──${RESET}"
            [ -f "$CRASH_LOG" ] && tail -20 "$CRASH_LOG" || echo "(无日志)"
            ;;
        *)
            log_error "未知日志类型: $log_type"
            echo "可用: backend, client, crash, all"
            exit 1
            ;;
    esac
}

# ── 实时日志监测 ──────────────────────────────────────────────────────────────────────

# JSON 日志解析函数 (用于 jq 不存在时的 fallback)
parse_json_log() {
    # 简单的 JSON 解析，提取关键字段
    local line="$1"
    # 提取时间、级别、消息、模块
    local timestamp=$(echo "$line" | grep -o '"timestamp":"[^"]*"' | sed 's/"timestamp":"//;s/"$//' | head -1)
    local level=$(echo "$line" | grep -o '"level":"[^"]*"' | sed 's/"level":"//;s/"$//' | head -1)
    local message=$(echo "$line" | grep -o '"message":"[^"]*"' | sed 's/"message":"//;s/"$//' | head -1)
    local module=$(echo "$line" | grep -o '"module":"[^"]*"' | sed 's/"module":"//;s/"$//' | head -1)

    if [ -n "$timestamp" ]; then
        printf "${GRAY}%s${RESET} [${level_color}] ${CYAN}%s${RESET} %s\n" "$timestamp" "$level" "$module" "$message"
    else
        echo "$line"
    fi
}

get_level_color() {
    case "$1" in
        DEBUG)   echo "$GRAY" ;;
        INFO)    echo "$GREEN" ;;
        WARNING) echo "$YELLOW" ;;
        SUCCESS) echo "$GREEN" ;;
        ERROR)   echo "$RED" ;;
        CRITICAL) echo "$RED$BOLD" ;;
        *)       echo "$RESET" ;;
    esac
}

watch_logs() {
    local module="${1:-all}"
    local level="${2:-DEBUG}"
    check_logs_dir

    print_section "实时日志监测 [模块: $module, 级别: $level+]"

    if [ ! -f "$SERVER_LOG" ]; then
        log_warn "日志文件不存在: $SERVER_LOG"
        log_info "请先启动服务: bash scripts/dev.sh start"
        exit 1
    fi

    # 构建过滤条件
    local filter_cmd="cat"

    if [ "$module" != "all" ]; then
        # 模块过滤
        filter_cmd="grep -i \"$module\""
    fi

    # 级别过滤 (DEBUG=10, INFO=20, WARNING=30, ERROR=40)
    local level_num=0
    case "$level" in
        DEBUG)   level_num=10 ;;
        INFO)    level_num=20 ;;
        WARNING) level_num=30 ;;
        ERROR)   level_num=40 ;;
        *)       level_num=10 ;;
    esac

    # 检查是否有 jq
    if command -v jq &>/dev/null; then
        # 使用 jq 进行 JSON 解析和过滤
        echo "${CYAN}使用 jq 解析 JSON 日志${RESET}"
        echo "${GRAY}按 Ctrl+C 退出${RESET}"
        echo ""

        tail -f "$SERVER_LOG" | while read -r line; do
            if [ -z "$line" ]; then continue; fi

            # 解析 JSON
            local lvl=$(echo "$line" | jq -r '.level // "INFO"' 2>/dev/null)
            local lvl_num=$(echo "$line" | jq -r '.level_no // 20' 2>/dev/null)
            local mod=$(echo "$line" | jq -r '.module // "unknown"' 2>/dev/null)
            local msg=$(echo "$line" | jq -r '.message // ""' 2>/dev/null)
            local ts=$(echo "$line" | jq -r '.timestamp // ""' 2>/dev/null)
            local func=$(echo "$line" | jq -r '.function // ""' 2>/dev/null)

            # 级别过滤
            if [ "$lvl_num" -lt "$level_num" ]; then continue; fi

            # 模块过滤
            if [ "$module" != "all" ]; then
                if ! echo "$mod" | grep -qi "$module"; then continue; fi
            fi

            # 颜色
            local lvl_color=$(get_level_color "$lvl")

            # 格式化输出
            printf "${GRAY}%s${RESET} [%s%s%s] ${CYAN}%s${RESET}.${BLUE}%s${RESET} %s\n" \
                "$ts" "$lvl_color" "$lvl" "$RESET" "$mod" "$func" "$msg"
        done
    else
        # 无 jq，使用简单过滤
        log_warn "未安装 jq，使用简单过滤"
        echo "${CYAN}安装 jq 可获得更好的日志格式: brew install jq${RESET}"
        echo "${GRAY}按 Ctrl+C 退出${RESET}"
        echo ""

        # 文本格式的简单过滤
        if [ "$module" = "all" ] && [ "$level" = "DEBUG" ]; then
            tail -f "$SERVER_LOG"
        else
            # 级别关键词过滤
            local level_keywords=""
            case "$level" in
                INFO)    level_keywords="INFO|WARNING|ERROR|CRITICAL|SUCCESS" ;;
                WARNING) level_keywords="WARNING|ERROR|CRITICAL" ;;
                ERROR)   level_keywords="ERROR|CRITICAL" ;;
            esac

            if [ "$module" = "all" ]; then
                tail -f "$SERVER_LOG" | grep -E "$level_keywords"
            else
                tail -f "$SERVER_LOG" | grep -i "$module" | grep -E "$level_keywords"
            fi
        fi
    fi
}

# ── 状态检查 ──────────────────────────────────────────────────────────────────────

check_status() {
    print_section "服务状态"

    # tmux 会话
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        log_info "tmux 会话运行中: $TMUX_SESSION"
        echo ""
        echo "${CYAN}tmux 窗口:${RESET}"
        tmux list-windows -t "$TMUX_SESSION" 2>/dev/null | while read -r win; do
            echo "  $win"
        done
    else
        log_warn "tmux 会话未运行"
    fi

    # 后端进程
    echo ""
    echo "${CYAN}后端进程:${RESET}"
    backend_pids=$(pgrep -f "python.*backend.cli" 2>/dev/null)
    if [ -n "$backend_pids" ]; then
        echo "$backend_pids" | while read -r pid; do
            ps -p "$pid" -o pid,etime,args 2>/dev/null | tail -1
        done
        log_info "后端运行中"
    else
        log_warn "后端未运行"
    fi

    # 前端进程
    echo ""
    echo "${CYAN}前端进程:${RESET}"
    frontend_pids=$(pgrep -f "vite" 2>/dev/null)
    if [ -n "$frontend_pids" ]; then
        echo "$frontend_pids" | while read -r pid; do
            ps -p "$pid" -o pid,etime,args 2>/dev/null | tail -1
        done
        log_info "前端运行中"
    else
        log_warn "前端未运行"
    fi

    # 端口检查
    echo ""
    echo "${CYAN}端口检查:${RESET}"
    if lsof -i :7860 &>/dev/null; then
        lsof -i :7860 2>/dev/null | head -5
        log_info "端口 7860 已占用"
    else
        log_warn "端口 7860 未占用"
    fi

    if lsof -i :5173 &>/dev/null; then
        lsof -i :5173 2>/dev/null | head -3
        log_info "端口 5173 已占用 (Vite)"
    else
        log_warn "端口 5173 未占用"
    fi

    # 日志状态
    echo ""
    echo "${CYAN}日志文件:${RESET}"
    for log_file in "$SERVER_LOG" "$CLIENT_LOG" "$CRASH_LOG"; do
        if [ -f "$log_file" ]; then
            size=$(ls -lh "$log_file" | awk '{print $5}')
            lines=$(wc -l < "$log_file")
            echo "  $log_file: ${size}, ${lines} 行"
        else
            echo "  $log_file: ${GRAY}(不存在)${RESET}"
        fi
    done

    # PID 文件
    echo ""
    echo "${CYAN}PID 文件:${RESET}"
    if [ -f "$PID_FILE" ]; then
        cat "$PID_FILE"
    else
        echo "  ${GRAY}(不存在)${RESET}"
    fi
}

# ── 清理日志 ──────────────────────────────────────────────────────────────────────

clear_logs() {
    print_section "清理日志"

    check_logs_dir

    read -p "确认清理所有日志? [y/N]: " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "取消清理"
        exit 0
    fi

    for log_file in "$SERVER_LOG" "$CLIENT_LOG" "$CRASH_LOG"; do
        if [ -f "$log_file" ]; then
            rm -f "$log_file"
            log_info "已删除: $log_file"
        fi
    done

    # 清理轮转日志
    for rotated in "$LOG_DIR"/*.log.*; do
        if [ -f "$rotated" ]; then
            rm -f "$rotated"
            log_info "已删除: $rotated"
        fi
    done 2>/dev/null || true

    log_info "日志已清理"
}

# ── 快速诊断 ──────────────────────────────────────────────────────────────────────

diagnose() {
    print_section "快速诊断"

    echo "${CYAN}1. Python 环境${RESET}"
    check_venv
    source "$VENV_DIR/bin/activate"
    python_version=$(python --version 2>&1)
    log_info "Python: $python_version"
    log_info "路径: $(which python)"

    echo ""
    echo "${CYAN}2. Node.js 环境${RESET}"
    if command -v node &>/dev/null; then
        node_version=$(node --version)
        log_info "Node.js: $node_version"
    else
        log_warn "Node.js 未安装"
    fi

    echo ""
    echo "${CYAN}3. 配置文件${RESET}"
    if [ -f "$REPO_ROOT/.env" ]; then
        log_info ".env 存在"
        adapter=$(grep "TRYVOICE_ACTIVE_ADAPTER" "$REPO_ROOT/.env" 2>/dev/null | cut -d= -f2)
        echo "  当前 adapter: $adapter"
    else
        log_warn ".env 不存在"
    fi

    echo ""
    echo "${CYAN}4. 前端构建${RESET}"
    static_dir="$REPO_ROOT/apps/host-runtime/backend/static-dist"
    if [ -d "$static_dir" ] && [ -f "$static_dir/index.html" ]; then
        log_info "前端已构建"
    else
        log_warn "前端未构建，请运行: bash scripts/setup.sh"
    fi

    echo ""
    echo "${CYAN}5. 最近错误 (crash.log)${RESET}"
    if [ -f "$CRASH_LOG" ]; then
        tail -10 "$CRASH_LOG" 2>/dev/null || echo "(无错误)"
    else
        echo "(无崩溃日志)"
    fi
}

# ── 帮助信息 ──────────────────────────────────────────────────────────────────────

show_help() {
    print_header

    echo "${BOLD}用法:${RESET}"
    echo "  bash scripts/dev.sh <command> [options]"
    echo ""

    echo "${BOLD}命令:${RESET}"
    echo ""
    echo "  ${GREEN}start${RESET}              启动前后端开发服务 (tmux)"
    echo "  ${GREEN}stop${RESET}               停止所有服务"
    echo "  ${GREEN}restart${RESET}            重启服务"
    echo "  ${GREEN}status${RESET}             检查服务运行状态"
    echo ""
    echo "  ${CYAN}logs${RESET} [type]         查看日志"
    echo "                     type: backend, client, crash, all (默认)"
    echo ""
    echo "  ${CYAN}watch${RESET} [module] [level]  实时日志监测"
    echo "                     module: adapter, session, voice, ws, config,"
    echo "                             mirror, history, all (默认)"
    echo "                     level: DEBUG (默认), INFO, WARNING, ERROR"
    echo ""
    echo "  ${YELLOW}clear${RESET}              清理所有日志文件"
    echo "  ${YELLOW}diagnose${RESET}           快速诊断环境问题"
    echo ""
    echo "  ${MAGENTA}attach${RESET}             进入 tmux 会话"
    echo "  ${MAGENTA}attach backend${RESET}    进入后端窗口"
    echo "  ${MAGENTA}attach frontend${RESET}   进入前端窗口"
    echo "  ${MAGENTA}attach logs${RESET}       进入日志窗口"
    echo ""

    echo "${BOLD}日志监测示例:${RESET}"
    echo "  bash scripts/dev.sh watch                  # 监测所有 DEBUG 日志"
    echo "  bash scripts/dev.sh watch adapter INFO     # 监测 adapter INFO+"
    echo "  bash scripts/dev.sh watch session DEBUG    # 监测 session 详细日志"
    echo "  bash scripts/dev.sh watch voice WARNING    # 监测 voice 警告和错误"
    echo "  bash scripts/dev.sh watch ws ERROR         # 仅监测 WebSocket 错误"
    echo ""

    echo "${BOLD}日志模块:${RESET}"
    echo "  adapter     - 适配器 (Claude Code, OpenClaw)"
    echo "  session     - 会话管理 (turn_fsm, orchestrator)"
    echo "  voice       - STT/TTS/VAD"
    echo "  ws          - WebSocket 处理"
    echo "  config      - 配置管理"
    echo "  mirror      - Telegram/飞书镜像"
    echo "  history     - 历史记录同步"
    echo "  canonical   - 规范化存储"
    echo "  all         - 所有模块"
    echo ""

    echo "${BOLD}日志路径:${RESET}"
    echo "  服务端: $USER_DATA_DIR/logs/server.log"
    echo "  客户端: $USER_DATA_DIR/logs/client.log"
    echo "  崩溃:   $USER_DATA_DIR/logs/crash.log"
    echo ""

    echo "${BOLD}环境变量 (开发模式自动设置):${RESET}"
    echo "  SERVER_LOG_LEVEL=DEBUG"
    echo "  SERVER_LOG_FORMAT=text"
    echo "  TRYVOICE_DEV_MODE=1"
    echo ""

    echo "${BOLD}提示:${RESET}"
    echo "  - 安装 jq 可获得更好的日志格式: ${CYAN}brew install jq${RESET}"
    echo "  - 退出 tmux 不停止服务: Ctrl+B 然后按 D"
    echo "  - 完全停止服务: bash scripts/dev.sh stop"
}

# ── 进入 tmux ──────────────────────────────────────────────────────────────────────

attach_tmux() {
    local window="${1:-}"

    if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        log_error "tmux 会话不存在，请先启动: bash scripts/dev.sh start"
        exit 1
    fi

    if [ -n "$window" ]; then
        tmux attach -t "$TMUX_SESSION:$window"
    else
        tmux attach -t "$TMUX_SESSION"
    fi
}

# ── 主入口 ──────────────────────────────────────────────────────────────────────

main() {
    local command="${1:-help}"

    case "$command" in
        start)
            start_services
            ;;
        stop)
            stop_services
            ;;
        restart)
            stop_services
            sleep 2
            start_services
            ;;
        status)
            check_status
            ;;
        logs)
            view_logs "${2:-all}"
            ;;
        watch)
            watch_logs "${2:-all}" "${3:-DEBUG}"
            ;;
        clear)
            clear_logs
            ;;
        diagnose)
            diagnose
            ;;
        attach)
            attach_tmux "${2:-}"
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            log_error "未知命令: $command"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

main "$@"