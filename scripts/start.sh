#!/usr/bin/env bash
#
# Singularity Voyage 一键启动脚本
#
# 用法:
#   ./scripts/start.sh start     # 安装依赖、构建、初始化 profile，然后后台启动服务
#   ./scripts/start.sh dev       # 前台运行 pnpm dev（改代码调试用，Ctrl+C 停止）
#   ./scripts/start.sh stop      # 停止后台服务
#   ./scripts/start.sh restart   # 重启
#   ./scripts/start.sh status    # 查看运行状态
#   ./scripts/start.sh logs      # 跟踪日志
#
# 默认 dsh harness 源码位置：../deepseek-harness-dsh-v0.2.1-rc.2
# 可用环境变量 DSH_SRC 覆盖。
set -euo pipefail

# ── 路径与常量 ───────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$REPO_ROOT/.pids"
LOG_DIR="$REPO_ROOT/logs"
PID_FILE="$PID_DIR/sv.pid"
# 进程控制台输出（追加写入，重启不丢）；结构化运行日志由 sv-app 按天写入 logs/sv-YYYY-MM-DD.log
LOG_FILE="$LOG_DIR/stdout.log"
DSH_SRC="${DSH_SRC:-$REPO_ROOT/../deepseek-harness-dsh-v0.2.1-rc.2}"
DSH_BIN="$DSH_SRC/apps/cli/lib/bin.js"
PORT="${PORT:-7000}"
HEALTH_URL="http://127.0.0.1:${PORT}/sv/api/state"
HEALTH_TIMEOUT=30

# ── 工具函数 ─────────────────────────────────────────────────────────────
log()  { printf '\033[1;36m[sv]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[sv]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[sv]\033[0m %s\n' "$*" >&2; exit 1; }

ensure_dirs() {
  mkdir -p "$PID_DIR" "$LOG_DIR"
}

# 检查前置命令是否存在
require() {
  command -v "$1" >/dev/null 2>&1 || die "缺少依赖: $1（请先安装）"
}

# 加载 .env（若存在），但不覆盖已导出的变量
load_env() {
  [[ -f "$REPO_ROOT/.env" ]] || return 0
  log "加载 .env 环境变量"
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
}

# PID 文件里的进程号（不校验存活）
pid_from_file() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] && printf '%s' "$pid"
}

# 判断进程是否为我们的 dsh 服务，避免 PID 被系统复用时误杀无关进程
is_sv_process() {
  local pid="${1:-}" cmd
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  [[ "$cmd" == *"--profile sv"* ]]
}

# 监听端口的进程号（一行一个，可能为空）
port_pids() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

# 真实运行中的服务 PID：以端口实际监听者为准，PID 文件仅用于交叉印证
running_pid() {
  local pid owners
  owners="$(port_pids)"
  if [[ -n "$owners" ]]; then
    if pid="$(pid_from_file)" && [[ $'\n'"$owners"$'\n' == *$'\n'"$pid"$'\n'* ]]; then
      printf '%s' "$pid"
      return 0
    fi
    for pid in $owners; do
      if is_sv_process "$pid"; then
        printf '%s' "$pid"
        return 0
      fi
    done
    return 1
  fi
  # 缺少 lsof 时退回 PID 文件判断
  if ! command -v lsof >/dev/null 2>&1; then
    if pid="$(pid_from_file)" && is_sv_process "$pid"; then
      printf '%s' "$pid"
      return 0
    fi
  fi
  return 1
}

# 端口被占用但不是 sv 服务时给出明确提示，避免 EADDRINUSE 被健康检查掩盖
assert_port_free() {
  local pid
  for pid in $(port_pids); do
    if ! is_sv_process "$pid"; then
      die "端口 $PORT 已被其他进程占用 (PID $pid: $(ps -o command= -p "$pid" 2>/dev/null | cut -c1-80))；请先释放端口或调整 PORT"
    fi
  done
  return 0
}

# ── 依赖安装与构建 ───────────────────────────────────────────────────────
prepare() {
  require node
  require pnpm

  cd "$REPO_ROOT"

  # Node 依赖
  if [[ ! -d node_modules ]]; then
    log "安装 Node 依赖 (pnpm install)…"
    pnpm install
  else
    log "node_modules 已存在，跳过 pnpm install"
  fi

  # 构建插件
  log "构建 sv-app (pnpm build)…"
  pnpm build

  # 初始化 dsh profile
  log "初始化 dsh profile (pnpm setup)…"
  pnpm setup
}

# ── 健康检查 ─────────────────────────────────────────────────────────────
# 只认「新进程仍存活 + 健康响应来自该进程」，避免旧进程应答造成假成功
wait_healthy() {
  local pid="$1"
  log "等待服务就绪 (${HEALTH_URL}，PID ${pid})…"
  local elapsed=0 owner
  while (( elapsed < HEALTH_TIMEOUT )); do
    if ! kill -0 "$pid" 2>/dev/null; then
      warn "新进程 (PID $pid) 已退出"
      return 1
    fi
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      owner="$(port_pids)"
      owner="${owner%%$'\n'*}"
      if [[ -n "$owner" && "$owner" != "$pid" ]]; then
        warn "端口 $PORT 由 PID $owner 应答，新进程 $pid 并未接管"
        return 1
      fi
      log "服务已就绪 ✔ (PID $pid)"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  warn "健康检查超时（${HEALTH_TIMEOUT}s）；请检查日志: $LOG_FILE"
  return 1
}

# ── 子命令 ───────────────────────────────────────────────────────────────
cmd_start() {
  ensure_dirs
  local pid
  if pid="$(running_pid)"; then
    # PID 文件丢失时补写，避免后续 stop 找不到真实进程
    echo "$pid" > "$PID_FILE"
    warn "服务已在运行 (PID $pid)，未做任何改动；如需生效请先 restart"
    return 0
  fi

  # 端口被其他程序占用时直接失败，而不是启动一个必然 EADDRINUSE 的进程
  assert_port_free

  load_env
  # dsh 数据目录默认放在仓库内，便于隔离与迁移（可用 DSH_HOME 覆盖）
  export DSH_HOME="${DSH_HOME:-$REPO_ROOT/.dsh}"
  prepare

  log "启动 dsh CLI（profile: sv, 端口: ${PORT}）…"
  cd "$REPO_ROOT"
  # nohup 后台运行，stdout/stderr 追加到日志（>> 避免重启清空历史）；stdin 接 /dev/null 避免终端关闭后进程退出
  nohup node "$DSH_BIN" --profile sv --port "$PORT" --no-open \
    < /dev/null >> "$LOG_FILE" 2>&1 &
  pid=$!
  echo "$pid" > "$PID_FILE"
  log "进程 PID: ${pid}，日志: $LOG_FILE"

  if ! wait_healthy "$pid"; then
    # 启动失败时不留下误导性的 PID 文件和“就绪”提示
    rm -f "$PID_FILE"
    die "启动失败，最近日志：$(printf '\n%s' "$(tail -n 20 "$LOG_FILE" 2>/dev/null || true)")"
  fi
  log "Singularity Voyage: http://127.0.0.1:${PORT}/"
}

cmd_stop() {
  ensure_dirs
  # 与 running_pid 口径一致：以端口监听者为准，PID 文件作为兜底
  local pids="" pid owners
  owners="$(port_pids)"
  for pid in $owners; do
    is_sv_process "$pid" || continue
    case " $pids " in
      *" $pid "*) ;;
      *) pids="${pids:+$pids }$pid" ;;
    esac
  done
  if [[ -z "$pids" ]] && pid="$(pid_from_file)" && is_sv_process "$pid"; then
    pids="$pid"
  fi

  if [[ -z "$pids" ]]; then
    warn "服务未运行"
    rm -f "$PID_FILE"
    return 0
  fi

  log "停止服务 (PID ${pids// /, })…"
  local alive
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 15); do
    alive=0
    for pid in $pids; do
      kill -0 "$pid" 2>/dev/null && alive=1
    done
    (( alive == 0 )) && break
    sleep 1
  done
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
      warn "PID $pid 优雅停止超时，强制结束"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  rm -f "$PID_FILE"
  log "已停止"
}

cmd_status() {
  local pid
  if pid="$(running_pid)"; then
    echo "$pid" > "$PID_FILE"
    log "运行中 — PID: $pid"
    log "日志: $LOG_FILE"
    log "页面: http://127.0.0.1:${PORT}/"
    return 0
  fi
  local others
  others="$(port_pids)"
  if [[ -n "$others" ]]; then
    warn "sv 服务未运行，但端口 $PORT 被其他进程占用 (PID ${others//$'\n'/, })"
  else
    log "未运行"
  fi
}

cmd_logs() {
  [[ -f "$LOG_FILE" ]] || die "暂无日志文件: $LOG_FILE"
  tail -f "$LOG_FILE"
}

cmd_restart() {
  cmd_stop
  cmd_start
}

# 前台运行 package.json 的 dev 脚本：与直接敲 pnpm dev 完全等价。
# 不 build、不 setup，适合改代码时调试；需要独占端口，且必须 Ctrl+C 结束。
cmd_dev() {
  ensure_dirs
  local pid
  if pid="$(running_pid)"; then
    warn "服务已在运行 (PID $pid)；pnpm dev 需要独占端口 ${PORT}，请先 ./scripts/start.sh stop"
    return 1
  fi
  # 端口被其他程序占用时直接失败，避免 pnpm dev 报 EADDRINUSE
  assert_port_free

  load_env
  log "前台运行 pnpm dev（端口见 package.json 的 dev 脚本，默认 ${PORT}）…"
  log "注意：dev 不会执行 build / setup；改过 src 请先 pnpm build，改过插件版本请先 pnpm setup"
  cd "$REPO_ROOT"
  exec pnpm dev
}

# ── 入口 ─────────────────────────────────────────────────────────────────
case "${1:-start}" in
  start)   cmd_start ;;
  dev)     cmd_dev ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  *)
    cat <<EOF
用法: $(basename "$0") {start|dev|stop|restart|status|logs}

  start    安装依赖 → 构建 → 初始化 profile → 后台启动服务
  dev      前台运行 pnpm dev（不 build / 不 setup，Ctrl+C 停止）
  stop     停止后台服务
  restart  重启服务
  status   查看运行状态
  logs     跟踪服务日志（tail -f）

环境变量:
  DSH_SRC  dsh harness 源码目录（默认: ../deepseek-harness-dsh-v0.2.1-rc.2）
  PORT     服务端口（默认 7000；dev 的端口由 package.json 的 dev 脚本决定）
EOF
    exit 1
    ;;
esac
