#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Runs the Backend behind the Rust migration gateway. This script intentionally
# owns only the two Backend processes; repository-level dependency and service
# setup remains in start.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT=${WEGENT_REPOSITORY_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}
BACKEND_DIR="$REPOSITORY_ROOT/backend"
BACKEND_RS_DIR=${WEGENT_RS_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}
RS_BINARY_NAME=${WEGENT_RS_BINARY_NAME:-wegent-backend-rs}

PUBLIC_HOST=${WEGENT_RS_LISTEN_HOST:-0.0.0.0}
PUBLIC_PORT=${WEGENT_RS_LISTEN_PORT:-8000}
PYTHON_UPSTREAM_PORT=${WEGENT_PYTHON_UPSTREAM_PORT:-8004}
RS_TARGET_DIR=${WEGENT_RS_TARGET_DIR:-$BACKEND_RS_DIR/target}
ROUTES_FILE=${WEGENT_RS_ROUTES_FILE:-$BACKEND_RS_DIR/config/routes.toml}
PYTHON_UVICORN=${WEGENT_PYTHON_UVICORN:-$BACKEND_DIR/.venv/bin/uvicorn}
STATE_FILE=${WEGENT_HYBRID_STATE_FILE:-}
# Dotenv file the Rust gateway reads. An explicit value is respected as given;
# otherwise prefer the Backend's real configuration, falling back to the
# checked-in example. The path must be absolute because the gateway resolves a
# relative path against its own working directory.
RS_ENV_FILE=${WEGENT_BACKEND_RS_ENV_FILE:-}
if [ -z "$RS_ENV_FILE" ]; then
    if [ -f "$BACKEND_DIR/.env" ]; then
        RS_ENV_FILE="$BACKEND_DIR/.env"
    else
        RS_ENV_FILE="$BACKEND_DIR/.env.example"
    fi
fi
# start.sh already exports LOG_DIR for the Backend. Reuse it for Rust so both
# processes are discoverable in the same service log directory. These may be
# overridden directly without adding any new .env contract.
BREEZE_LOG_DIR=${BREEZE_LOG_DIR:-${LOG_DIR:-$REPOSITORY_ROOT/logs/backend}}
BREEZE_PROFILE_LOG_PATH=${BREEZE_PROFILE_LOG_PATH:-$BREEZE_LOG_DIR/profile.log}

show_help() {
    cat <<EOF
Usage: $0 [OPTIONS]

Options:
  --host HOST          Public Rust gateway host (default: 0.0.0.0)
  --port PORT          Public Rust gateway port (default: 8000)
  -h, --help           Show this help message

Environment:
  WEGENT_REPOSITORY_ROOT       Wegent repository containing the Python Backend
  WEGENT_PYTHON_UPSTREAM_PORT  Loopback Python port (default: 8004)
  WEGENT_RS_ROUTES_FILE        TOML route selection file
  WEGENT_RS_PROJECT_DIR        Rust Backend project directory
  WEGENT_RS_BINARY_NAME        Rust Backend binary name
  WEGENT_RS_TARGET_DIR         Cargo target directory
  WEGENT_BACKEND_RS_ENV_FILE   Dotenv file for the Rust gateway
                               (default: the Backend's .env, else .env.example)
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --host)
            if [ "$#" -lt 2 ]; then
                echo "Error: --host requires a value" >&2
                exit 2
            fi
            PUBLIC_HOST=$2
            shift 2
            ;;
        --port)
            if [ "$#" -lt 2 ]; then
                echo "Error: --port requires a value" >&2
                exit 2
            fi
            PUBLIC_PORT=$2
            shift 2
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo "Error: unknown option $1" >&2
            show_help >&2
            exit 2
            ;;
    esac
done

validate_port() {
    local value=$1
    local label=$2
    if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
        echo "Error: $label must be between 1 and 65535" >&2
        exit 2
    fi
}

validate_port "$PUBLIC_PORT" "public gateway port"
validate_port "$PYTHON_UPSTREAM_PORT" "Python upstream port"
if [ "$PUBLIC_PORT" = "$PYTHON_UPSTREAM_PORT" ]; then
    echo "Error: public gateway and Python upstream ports must differ" >&2
    exit 2
fi

if ! command -v cargo >/dev/null 2>&1; then
    echo "Error: cargo is required for hybrid Backend mode" >&2
    exit 1
fi
if [ ! -x "$PYTHON_UVICORN" ]; then
    echo "Error: Backend uvicorn executable not found: $PYTHON_UVICORN" >&2
    exit 1
fi
if [ ! -f "$ROUTES_FILE" ]; then
    echo "Error: Rust route config not found: $ROUTES_FILE" >&2
    exit 1
fi

port_is_listening() {
    local port=$1
    if command -v lsof >/dev/null 2>&1; then
        lsof -Pi :"$port" -sTCP:LISTEN -t >/dev/null 2>&1
        return
    fi
    if command -v ss >/dev/null 2>&1; then
        ss -H -lnt "sport = :$port" 2>/dev/null | grep -q .
        return
    fi
    return 1
}

for port_spec in \
    "$PUBLIC_PORT:public gateway" \
    "$PYTHON_UPSTREAM_PORT:Python upstream"; do
    port=${port_spec%%:*}
    label=${port_spec#*:}
    if port_is_listening "$port"; then
        echo "Error: $label port $port is already in use" >&2
        exit 1
    fi
done

BUILD_PID=""
PYTHON_PID=""
RUST_PID=""

write_state() {
    if [ -z "$STATE_FILE" ]; then
        return
    fi
    mkdir -p "$(dirname "$STATE_FILE")"
    local temporary_state="$STATE_FILE.$$"
    {
        echo "parent=$$"
        echo "build=$BUILD_PID"
        echo "python=$PYTHON_PID"
        echo "rust=$RUST_PID"
        echo "python_port=$PYTHON_UPSTREAM_PORT"
    } > "$temporary_state"
    mv "$temporary_state" "$STATE_FILE"
}

cleanup() {
    trap - EXIT INT TERM
    for child_pid in "$RUST_PID" "$PYTHON_PID" "$BUILD_PID"; do
        if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
            kill -TERM "$child_pid" 2>/dev/null || true
        fi
    done
    for child_pid in "$RUST_PID" "$PYTHON_PID" "$BUILD_PID"; do
        if [ -n "$child_pid" ]; then
            wait "$child_pid" 2>/dev/null || true
        fi
    done
    if [ -n "$STATE_FILE" ]; then
        rm -f "$STATE_FILE" "$STATE_FILE.$$"
    fi
}

trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT

write_state

RS_BINARY="$RS_TARGET_DIR/release/$RS_BINARY_NAME"
echo "Building Wegent Rust gateway (release)..."
# Keep inherited compiler flags and stripping from breaking macOS proc-macro loading.
env -u RUSTFLAGS -u CARGO_ENCODED_RUSTFLAGS \
    CARGO_PROFILE_RELEASE_STRIP=false \
    CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP=false \
    CARGO_TARGET_DIR="$RS_TARGET_DIR" cargo build \
    --release \
    --manifest-path "$BACKEND_RS_DIR/Cargo.toml" \
    --bin "$RS_BINARY_NAME" &
BUILD_PID=$!
write_state
if wait "$BUILD_PID"; then
    BUILD_PID=""
    write_state
else
    BUILD_STATUS=$?
    BUILD_PID=""
    write_state
    exit "$BUILD_STATUS"
fi

echo "Starting Python Backend upstream on http://127.0.0.1:$PYTHON_UPSTREAM_PORT"
(
    cd "$BACKEND_DIR"
    exec "$PYTHON_UVICORN" app.main:app \
        --reload \
        --reload-dir . \
        --reload-dir ../shared \
        --reload-exclude '.venv/*' \
        --reload-exclude '__pycache__/*' \
        --reload-exclude '*.pyc' \
        --reload-exclude '.git/*' \
        --host 127.0.0.1 \
        --port "$PYTHON_UPSTREAM_PORT" \
        --log-level debug
) &
PYTHON_PID=$!
write_state

wait_for_python() {
    local timeout=${WEGENT_PYTHON_READY_TIMEOUT:-180}
    local deadline=$((SECONDS + timeout))
    while kill -0 "$PYTHON_PID" 2>/dev/null; do
        if (exec 3<>"/dev/tcp/127.0.0.1/$PYTHON_UPSTREAM_PORT") 2>/dev/null; then
            return 0
        fi
        if [ "$SECONDS" -ge "$deadline" ]; then
            echo "Error: Python upstream did not become ready within ${timeout}s" >&2
            return 1
        fi
        sleep 3
    done
    wait "$PYTHON_PID" || true
    echo "Error: Python upstream exited before becoming ready" >&2
    return 1
}

wait_for_python

echo "Starting Rust gateway on http://$PUBLIC_HOST:$PUBLIC_PORT"
echo "Fallback upstream: http://127.0.0.1:$PYTHON_UPSTREAM_PORT"
echo "Route config: $ROUTES_FILE"
echo "Dotenv file: $RS_ENV_FILE"
(
    # Rust resolves its default config/example.env relative to the current
    # working directory. Run it from the Rust project root so the default and
    # any relative `--env-file` stay consistent.
    cd "$BACKEND_RS_DIR"
    export WEGENT_RS_LISTEN_HOST="$PUBLIC_HOST"
    export WEGENT_RS_LISTEN_PORT="$PUBLIC_PORT"
    export WEGENT_PYTHON_UPSTREAM_URL="http://127.0.0.1:$PYTHON_UPSTREAM_PORT"
    export WEGENT_RS_ROUTES_FILE="$ROUTES_FILE"
    export WEGENT_BACKEND_RS_ENV_FILE="$RS_ENV_FILE"
    export BREEZE_LOG_DIR="$BREEZE_LOG_DIR"
    export BREEZE_PROFILE_LOG_PATH="$BREEZE_PROFILE_LOG_PATH"
    exec "$RS_BINARY"
) &
RUST_PID=$!
write_state

wait_for_rust() {
    local timeout=${WEGENT_PYTHON_READY_TIMEOUT:-180}
    local deadline=$((SECONDS + timeout))
    while kill -0 "$RUST_PID" 2>/dev/null; do
        if (exec 3<>"/dev/tcp/127.0.0.1/$PUBLIC_PORT") 2>/dev/null; then
            return 0
        fi
        if [ "$SECONDS" -ge "$deadline" ]; then
            echo "Error: Rust gateway did not become ready within ${timeout}s" >&2
            return 1
        fi
        sleep 3
    done
    wait "$RUST_PID" || true
    echo "Error: Rust gateway exited before becoming ready" >&2
    return 1
}

wait_for_rust

while kill -0 "$PYTHON_PID" 2>/dev/null && kill -0 "$RUST_PID" 2>/dev/null; do
    sleep 1
done

set +e
if ! kill -0 "$PYTHON_PID" 2>/dev/null; then
    wait "$PYTHON_PID"
    EXIT_STATUS=$?
    echo "Python upstream exited; stopping the Rust gateway" >&2
else
    wait "$RUST_PID"
    EXIT_STATUS=$?
    echo "Rust gateway exited; stopping the Python upstream" >&2
fi
set -e
exit "$EXIT_STATUS"
