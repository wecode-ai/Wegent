#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

PUBLIC_HOST=${WEGENT_RS_LISTEN_HOST:-0.0.0.0}
PUBLIC_PORT=${PORT:-8000}
PYTHON_HOST=127.0.0.1
PYTHON_PORT=${WEGENT_PYTHON_UPSTREAM_PORT:-8004}
PYTHON_READY_TIMEOUT=${WEGENT_PYTHON_READY_TIMEOUT:-180}
ROUTES_FILE=${WEGENT_RS_ROUTES_FILE:-/app/backend-rs-intra/config/routes.toml}
RUST_BINARY=/usr/local/bin/wegent-backend-rs
LOG_DIR=${LOG_DIR:-/data1/weibo/logs}
BREEZE_LOG_DIR=${BREEZE_LOG_DIR:-$LOG_DIR/rust}
BREEZE_PROFILE_LOG_PATH=${BREEZE_PROFILE_LOG_PATH:-$BREEZE_LOG_DIR/profile.log}

PYTHON_PID=""
RUST_PID=""
SIGNAL_STATUS=0

validate_port() {
    local value=$1
    local label=$2
    if ! [[ "$value" =~ ^[0-9]+$ ]] || ((value < 1 || value > 65535)); then
        echo "Error: $label must be between 1 and 65535" >&2
        exit 2
    fi
}

validate_port "$PUBLIC_PORT" "public gateway port"
validate_port "$PYTHON_PORT" "Python upstream port"
if [[ "$PUBLIC_PORT" == "$PYTHON_PORT" ]]; then
    echo "Error: public gateway and Python upstream ports must differ" >&2
    exit 2
fi
if ! [[ "$PYTHON_READY_TIMEOUT" =~ ^[0-9]+$ ]] || ((PYTHON_READY_TIMEOUT < 1)); then
    echo "Error: WEGENT_PYTHON_READY_TIMEOUT must be a positive integer" >&2
    exit 2
fi
if [[ ! -x "$RUST_BINARY" ]]; then
    echo "Error: Rust Backend binary is missing: $RUST_BINARY" >&2
    exit 1
fi
if [[ ! -f "$ROUTES_FILE" ]]; then
    echo "Error: Rust route configuration is missing: $ROUTES_FILE" >&2
    exit 1
fi

terminate_children() {
    local child_pid
    for child_pid in "$RUST_PID" "$PYTHON_PID"; do
        if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
            kill -TERM "$child_pid" 2>/dev/null || true
        fi
    done
}

cleanup() {
    local exit_status=$?
    local child_pid
    trap - EXIT INT TERM
    terminate_children
    for child_pid in "$RUST_PID" "$PYTHON_PID"; do
        if [[ -n "$child_pid" ]]; then
            wait "$child_pid" 2>/dev/null || true
        fi
    done
    exit "$exit_status"
}

handle_signal() {
    SIGNAL_STATUS=$1
    terminate_children
}

wait_for_python() {
    local deadline=$((SECONDS + PYTHON_READY_TIMEOUT))
    while kill -0 "$PYTHON_PID" 2>/dev/null; do
        if (exec 3<>"/dev/tcp/$PYTHON_HOST/$PYTHON_PORT") 2>/dev/null; then
            return 0
        fi
        if ((SECONDS >= deadline)); then
            echo "Error: Python Backend did not become ready within ${PYTHON_READY_TIMEOUT}s" >&2
            return 1
        fi
        sleep 3
    done
    wait "$PYTHON_PID" 2>/dev/null || true
    echo "Error: Python Backend exited before becoming ready" >&2
    return 1
}

trap cleanup EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

mkdir -p "$LOG_DIR" "$BREEZE_LOG_DIR" "$(dirname "$BREEZE_PROFILE_LOG_PATH")"

echo "Starting Python Backend upstream on http://$PYTHON_HOST:$PYTHON_PORT"
python -m uvicorn app.main:app \
    --host "$PYTHON_HOST" \
    --port "$PYTHON_PORT" \
    --workers 1 \
    --timeout-graceful-shutdown "${GRACEFUL_SHUTDOWN_TIMEOUT:-600}" &
PYTHON_PID=$!

wait_for_python

echo "Starting Rust gateway on http://$PUBLIC_HOST:$PUBLIC_PORT"
WEGENT_RS_LISTEN_HOST="$PUBLIC_HOST" \
WEGENT_RS_LISTEN_PORT="$PUBLIC_PORT" \
WEGENT_PYTHON_UPSTREAM_URL="http://$PYTHON_HOST:$PYTHON_PORT" \
WEGENT_RS_ROUTES_FILE="$ROUTES_FILE" \
BREEZE_LOG_DIR="$BREEZE_LOG_DIR" \
BREEZE_PROFILE_LOG_PATH="$BREEZE_PROFILE_LOG_PATH" \
"$RUST_BINARY" &
RUST_PID=$!

wait_for_rust() {
    local deadline=$((SECONDS + PYTHON_READY_TIMEOUT))
    while kill -0 "$RUST_PID" 2>/dev/null; do
        if (exec 3<>"/dev/tcp/127.0.0.1/$PUBLIC_PORT") 2>/dev/null; then
            return 0
        fi
        if ((SECONDS >= deadline)); then
            echo "Error: Rust gateway did not become ready within ${PYTHON_READY_TIMEOUT}s" >&2
            return 1
        fi
        sleep 3
    done
    wait "$RUST_PID" 2>/dev/null || true
    echo "Error: Rust gateway exited before becoming ready" >&2
    return 1
}

wait_for_rust

set +e
wait -n "$PYTHON_PID" "$RUST_PID"
exit_status=$?
set -e

if ((SIGNAL_STATUS != 0)); then
    exit_status=$SIGNAL_STATUS
elif kill -0 "$PYTHON_PID" 2>/dev/null; then
    echo "Rust gateway exited; stopping the Python Backend" >&2
else
    echo "Python Backend exited; stopping the Rust gateway" >&2
fi

if ((SIGNAL_STATUS == 0 && exit_status == 0)); then
    exit_status=1
fi
exit "$exit_status"
