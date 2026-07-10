#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$ROOT_DIR/.." && pwd)"
PID_DIR="$ROOT_DIR/.pids"
PID_FILE="$PID_DIR/wegent-executor.pid"
RUN_LOG="$PID_DIR/wegent-executor.log"
BUILD_LOG="$PID_DIR/wegent-executor-build.log"
BINARY_PATH="${WEGENT_EXECUTOR_BINARY:-$ROOT_DIR/dist/wegent-executor}"

# shellcheck source=../scripts/lib/cargo-cache.sh
source "$PROJECT_DIR/scripts/lib/cargo-cache.sh"

DEFAULT_FILE_EDIT_HOOK_COMMAND='tee -a /tmp/hook-debug.log | curl -sS -X POST http://127.0.0.1:3456/api/file-edit-log -H "Content-Type: application/json" -H "wecode-source: wegent-device" --data-binary @-'

usage() {
    cat <<EOF
Usage: ./local.sh [command] [version]

Commands:
  all [version]    Build the local binary, then restart it
  build [version]  Build the Rust local binary
  start            Start dist/wegent-executor in the background
  stop             Stop the background executor process
  restart          Stop, then start the executor process
  status           Show whether the executor process is running
  logs             Tail the executor log

If [version] is provided for 'build' or 'all', local.sh verifies the built
binary with WEGENT_EXECUTOR_VERSION set to that value.

Environment:
  WEGENT_AUTH_TOKEN              Optional; overrides device-config.json
  WEGENT_BACKEND_URL             Optional; overrides device-config.json
  WEGENT_FILE_EDIT_HOOK_COMMAND  Default: local file edit hook collector
  WEGENT_EXECUTOR_BINARY         Default: dist/wegent-executor
  CARGO_TARGET_DIR               Explicit Cargo target directory. Overrides auto cache.
  WEGENT_CARGO_TARGET_ROOT       Root containing worktree-isolated Cargo targets.
  WEGENT_DISABLE_SHARED_CARGO_TARGET
                                  Set to 1 to keep Cargo's default per-worktree target.
  WEGENT_DISABLE_SCCACHE         Set to 1 to disable automatic sccache detection.

Examples:
  ./local.sh all
  ./local.sh restart
  ./local.sh build 1.2.3
  ./local.sh all 1.2.3
EOF
}

ensure_pid_dir() {
    mkdir -p "$PID_DIR"
}

is_running() {
    if [[ ! -f "$PID_FILE" ]]; then
        return 1
    fi

    local pid
    pid="$(cat "$PID_FILE")"
    [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

build_executor() {
    local version_arg="${1:-}"
    ensure_pid_dir
    configure_wegent_cargo_target_dir "$PROJECT_DIR" "executor"
    echo "Building local executor. Log: $BUILD_LOG"
    echo "Cargo target dir: ${CARGO_TARGET_DIR:-$ROOT_DIR/target}"
    (
        cd "$ROOT_DIR"
        cargo build --release --locked
        mkdir -p dist
        cp "$(cargo_target_binary_path "$ROOT_DIR" release wegent-executor)" dist/wegent-executor
        chmod 0755 dist/wegent-executor
        if [[ "$(uname -s)" == "Darwin" ]]; then
            codesign --force --sign - --options runtime dist/wegent-executor >/dev/null 2>&1 || true
        fi
        if [[ -n "$version_arg" ]]; then
            echo "Building with version: $version_arg"
            WEGENT_EXECUTOR_VERSION="$version_arg" dist/wegent-executor --version
        fi
    ) 2>&1 | tee "$BUILD_LOG"
}

start_executor() {
    ensure_pid_dir

    if is_running; then
        echo "Executor is already running with PID $(cat "$PID_FILE")."
        echo "Log: $RUN_LOG"
        return 0
    fi

    if [[ ! -x "$BINARY_PATH" ]]; then
        echo "Executor binary is missing or not executable: $BINARY_PATH"
        echo "Run ./local.sh build first."
        exit 1
    fi

    echo "Starting local executor. Log: $RUN_LOG"
    (
        cd "$ROOT_DIR"
        export WEGENT_FILE_EDIT_HOOK_COMMAND="${WEGENT_FILE_EDIT_HOOK_COMMAND:-$DEFAULT_FILE_EDIT_HOOK_COMMAND}"
        export WEGENT_EXECUTOR_LOG_DIR="$PID_DIR"
        export WEGENT_EXECUTOR_LOG_FILE="$(basename "$RUN_LOG")"
        nohup "$BINARY_PATH" >/dev/null 2>&1 &
        echo $! > "$PID_FILE"
    )

    sleep 1

    if is_running; then
        echo "Executor started with PID $(cat "$PID_FILE")."
    else
        echo "Executor failed to start. Recent log:"
        tail -n 80 "$RUN_LOG" || true
        exit 1
    fi
}

stop_executor() {
    if ! is_running; then
        rm -f "$PID_FILE"
        echo "Executor is not running."
        return 0
    fi

    local pid
    pid="$(cat "$PID_FILE")"
    echo "Stopping executor with PID $pid."
    kill "$pid" >/dev/null 2>&1 || true

    for _ in {1..20}; do
        if ! kill -0 "$pid" >/dev/null 2>&1; then
            rm -f "$PID_FILE"
            echo "Executor stopped."
            return 0
        fi
        sleep 0.5
    done

    echo "Executor did not stop gracefully; killing PID $pid."
    kill -9 "$pid" >/dev/null 2>&1 || true
    rm -f "$PID_FILE"
}

status_executor() {
    if is_running; then
        echo "Executor is running with PID $(cat "$PID_FILE")."
        echo "Log: $RUN_LOG"
    else
        rm -f "$PID_FILE"
        echo "Executor is not running."
    fi
}

tail_logs() {
    ensure_pid_dir
    touch "$RUN_LOG"
    tail -f "$RUN_LOG"
}

command="${1:-restart}"
version="${2:-}"

case "$command" in
    all)
        build_executor "$version"
        stop_executor
        start_executor
        ;;
    build)
        build_executor "$version"
        ;;
    start)
        start_executor
        ;;
    stop)
        stop_executor
        ;;
    restart)
        stop_executor
        start_executor
        ;;
    status)
        status_executor
        ;;
    logs)
        tail_logs
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        echo "Unknown command: $command"
        echo ""
        usage
        exit 1
        ;;
esac
