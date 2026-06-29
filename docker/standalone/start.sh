#!/bin/bash
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Standalone startup script - starts Redis, Backend, Frontend, Nginx, Executor, and terminal services in a single container

set -e

echo "=========================================="
echo "  Starting Wegent Standalone"
echo "=========================================="
echo ""

# Create persistent data and workspace directories.
mkdir -p /app/data
export CODEX_HOME="${CODEX_HOME:-/app/data/codex}"
mkdir -p "$CODEX_HOME"
mkdir -p /app/data/redis
mkdir -p /workspace/projects
mkdir -p /workspace/chats
mkdir -p /workspace/worktrees

# Set absolute path for SQLite database.
# Note: SQLite absolute path requires 4 slashes: sqlite:////path/to/db
export DATABASE_URL="sqlite:////app/data/wegent.db"

# Set default ports if not specified.
BACKEND_PORT=${BACKEND_PORT:-8000}
FRONTEND_PORT=${FRONTEND_PORT:-3002}
STANDALONE_EXECUTOR_ENABLED="${STANDALONE_EXECUTOR_ENABLED:-true}"
STANDALONE_EXECUTOR_DEVICE_ID="${STANDALONE_EXECUTOR_DEVICE_ID:-standalone-admin-device}"

# Set Redis URL to localhost (embedded Redis).
export REDIS_URL="${REDIS_URL:-redis://localhost:6379/0}"
export WEGENT_WORKSPACE_ROOT="${WEGENT_WORKSPACE_ROOT:-/workspace}"

generate_internal_service_token() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
        return
    fi

    python3 - << 'PY'
import secrets

print(secrets.token_hex(32))
PY
}

ensure_internal_service_token() {
    if [ -n "${INTERNAL_SERVICE_TOKEN:-}" ]; then
        return
    fi

    local token_file="/app/data/internal_service_token"
    if [ -s "$token_file" ]; then
        local token_value
        token_value=$(tr -d '[:space:]' < "$token_file")
        if [ -n "$token_value" ]; then
            export INTERNAL_SERVICE_TOKEN="$token_value"
            return
        fi
    fi

    export INTERNAL_SERVICE_TOKEN
    INTERNAL_SERVICE_TOKEN=$(generate_internal_service_token)
    if [ -z "$INTERNAL_SERVICE_TOKEN" ]; then
        echo "      ERROR: Failed to generate INTERNAL_SERVICE_TOKEN"
        exit 1
    fi
    umask 077
    printf '%s\n' "$INTERNAL_SERVICE_TOKEN" > "$token_file"
    echo "      Generated internal service token for standalone mode"
}

ensure_standalone_executor_token() {
    echo "      Ensuring standalone executor API key..."
    cd /app/backend

    export WEGENT_AUTH_TOKEN
    WEGENT_AUTH_TOKEN=$(python -m app.scripts.ensure_standalone_executor_token)
    if [ -z "$WEGENT_AUTH_TOKEN" ]; then
        echo "      ERROR: Failed to resolve standalone executor API key"
        exit 1
    fi
}

wait_for_http() {
    local service_name="$1"
    local url="$2"
    local retries="$3"
    local pid="$4"
    local fatal="${5:-true}"
    local credentials="${6:-}"

    echo "      Waiting for ${service_name} to be ready..."
    for i in $(seq 1 "$retries"); do
        if [ -n "$credentials" ]; then
            if curl -fsS --connect-timeout 2 --max-time 5 -u "$credentials" "$url" > /dev/null 2>&1; then
                echo "      ${service_name} is ready (PID: ${pid})"
                return
            fi
        else
            if curl -fsS --connect-timeout 2 --max-time 5 "$url" > /dev/null 2>&1; then
                echo "      ${service_name} is ready (PID: ${pid})"
                return
            fi
        fi
        if [ "$i" -eq "$retries" ]; then
            if [ "$fatal" = "true" ]; then
                echo "      ERROR: ${service_name} failed to start within ${retries} seconds"
                kill "$pid" 2>/dev/null || true
                exit 1
            fi
            echo "      WARNING: ${service_name} may not be fully ready, continuing anyway..."
            return
        fi
        sleep 1
    done
}

write_wework_runtime_config() {
    local app_base_path="${WEWORK_PUBLIC_APP_BASE_PATH:-/wework}"
    local public_backend_url="${WEWORK_PUBLIC_BACKEND_URL:-}"

    export WEWORK_PUBLIC_APP_BASE_PATH="$app_base_path"
    export WEWORK_PUBLIC_BACKEND_URL="$public_backend_url"
    if [ -n "${WEWORK_PUBLIC_API_URL:-}" ]; then
        export WEWORK_PUBLIC_API_URL
    elif [ -n "$public_backend_url" ]; then
        export WEWORK_PUBLIC_API_URL="${public_backend_url%/}/api"
    else
        export WEWORK_PUBLIC_API_URL="${app_base_path}/api"
    fi
    export WEWORK_PUBLIC_SOCKET_URL="${WEWORK_PUBLIC_SOCKET_URL:-${public_backend_url%/}}"
    export WEWORK_PUBLIC_SOCKET_PATH="${WEWORK_PUBLIC_SOCKET_PATH:-${app_base_path}/socket.io}"

    python3 - << 'PY'
import json
import os
from pathlib import Path

config = {
    "appBasePath": os.environ["WEWORK_PUBLIC_APP_BASE_PATH"],
    "apiBaseUrl": os.environ["WEWORK_PUBLIC_API_URL"].rstrip("/"),
    "socketBaseUrl": os.environ["WEWORK_PUBLIC_SOCKET_URL"].rstrip("/"),
    "socketPath": os.environ["WEWORK_PUBLIC_SOCKET_PATH"],
}

target = Path("/app/wework/dist/runtime-config.js")
target.write_text(
    "window.__WEWORK_RUNTIME_CONFIG__ = "
    + json.dumps(config, ensure_ascii=True)
    + "\n",
    encoding="utf-8",
)
PY
}

stop_pid() {
    local service_name="$1"
    local pid="${2:-}"

    if [ -n "$pid" ]; then
        echo "  Stopping ${service_name} (PID: ${pid})..."
        kill -TERM "$pid" 2>/dev/null || true
    fi
}

report_process() {
    local service_name="$1"
    local pid="$2"

    if kill -0 "$pid" 2>/dev/null; then
        echo "  ${service_name} is still running"
    else
        echo "  ${service_name} has stopped"
    fi
}

ensure_internal_service_token

# ========================================
# Step 1: Start Redis
# ========================================
echo "[1/8] Starting Redis..."

# Create Redis configuration for persistence.
cat > /tmp/redis.conf <<EOF
# Redis configuration for standalone mode
bind 127.0.0.1
port 6379
daemonize no
dir /app/data/redis
dbfilename dump.rdb
appendonly yes
appendfilename "appendonly.aof"
# Memory management
maxmemory 256mb
maxmemory-policy allkeys-lru
# Logging
loglevel notice
logfile ""
EOF

redis-server /tmp/redis.conf &
REDIS_PID=$!

echo "      Waiting for Redis to be ready..."
for i in {1..30}; do
    if redis-cli ping > /dev/null 2>&1; then
        echo "      Redis is ready (PID: ${REDIS_PID})"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "      ERROR: Redis failed to start within 30 seconds"
        kill "$REDIS_PID" 2>/dev/null || true
        exit 1
    fi
    sleep 1
done

# ========================================
# Step 2: Initialize Database
# ========================================
cd /app/backend

if [ ! -f /app/data/wegent.db ]; then
    echo "[2/8] Initializing SQLite database..."
    # env.py will detect fresh database and use Base.metadata.create_all()
    # then stamp to head, bypassing old MySQL-specific migrations.
    alembic upgrade head
    echo "      Database initialized successfully"
else
    echo "[2/8] Database exists, checking for migrations..."
    alembic upgrade head
    echo "      Database migrations applied"
fi

# ========================================
# Step 3: Start Backend
# ========================================
echo "[3/8] Starting Backend (port ${BACKEND_PORT})..."
cd /app/backend
uvicorn app.main:app \
    --host 0.0.0.0 \
    --port ${BACKEND_PORT} \
    --workers 1 \
    --timeout-graceful-shutdown ${GRACEFUL_SHUTDOWN_TIMEOUT:-600} &
BACKEND_PID=$!

wait_for_http "Backend" "http://localhost:${BACKEND_PORT}/health" 60 "$BACKEND_PID" true

# Host executor setup reads this token even when the in-container executor is disabled.
ensure_standalone_executor_token

# ========================================
# Step 4: Start Standalone Executor
# ========================================
start_executor() {
    echo "[4/8] Starting Standalone Executor..."

    export DEVICE_TYPE=cloud
    export DEVICE_ID="$STANDALONE_EXECUTOR_DEVICE_ID"
    export DEVICE_NAME="${STANDALONE_DEVICE_NAME:-Standalone Device}"
    export WEGENT_BACKEND_URL=http://127.0.0.1:${BACKEND_PORT}
    export WORKSPACE_ROOT=/workspace
    export LOCAL_WORKSPACE_ROOT=/workspace
    export WEGENT_EXECUTOR_PROJECTS_DIR=/workspace/projects
    export WEGENT_EXECUTOR_CHATS_DIR=/workspace/chats
    export WEGENT_EXECUTOR_HOME=/app/data/standalone-executor
    export EXECUTOR_STARTUP_MODE=socket
    export DEVICE_SESSION_GATEWAY_ENABLED=false

    mkdir -p "$WEGENT_EXECUTOR_PROJECTS_DIR" "$WEGENT_EXECUTOR_CHATS_DIR" "$WEGENT_EXECUTOR_HOME"

    /app/wegent-executor &
    EXECUTOR_PID=$!
    echo "      Standalone Executor started (PID: ${EXECUTOR_PID})"
}

if [ "$STANDALONE_EXECUTOR_ENABLED" != "false" ]; then
    start_executor
else
    echo "[4/8] Skipping Standalone Executor (STANDALONE_EXECUTOR_ENABLED=false)"
fi

# ========================================
# Step 5: Start Frontend
# ========================================
echo "[5/8] Starting Frontend (port ${FRONTEND_PORT})..."
cd /app/frontend

# Set runtime environment variables for Frontend.
# RUNTIME_INTERNAL_API_URL is always localhost (internal container communication).
export RUNTIME_INTERNAL_API_URL=http://localhost:${BACKEND_PORT}
# RUNTIME_PUBLIC_API_URL is used in generated external API examples.
export RUNTIME_PUBLIC_API_URL=${RUNTIME_PUBLIC_API_URL:-/api}
# RUNTIME_SOCKET_DIRECT_URL can be overridden for remote access; empty means same-origin proxy mode.
export RUNTIME_SOCKET_DIRECT_URL=${RUNTIME_SOCKET_DIRECT_URL:-}
# Point frontend coding entry points at bundled Wework by default.
export RUNTIME_WEWORK_CODE_URL="${RUNTIME_WEWORK_CODE_URL:-/wework}"
export NODE_ENV=production
export PORT=${FRONTEND_PORT}
export HOSTNAME="0.0.0.0"

# Limit Node.js memory to reduce overall container memory usage.
# Default: 96MB max old space, can be overridden via FRONTEND_MAX_MEMORY.
export NODE_OPTIONS="--max-old-space-size=${FRONTEND_MAX_MEMORY:-96}"

node server.js &
FRONTEND_PID=$!

wait_for_http "Frontend" "http://localhost:${FRONTEND_PORT}" 30 "$FRONTEND_PID" false

# ========================================
# Step 6: Start Nginx
# ========================================
start_nginx() {
    echo "[6/8] Starting Nginx reverse proxy (port 3000)..."
    write_wework_runtime_config

    nginx -t
    nginx -g "daemon off;" &
    NGINX_PID=$!

    wait_for_http "Nginx" "http://localhost:3000/health" 30 "$NGINX_PID" true
    wait_for_http "Wework" "http://localhost:3000/wework/" 30 "$NGINX_PID" false
}

start_nginx

# ========================================
# Step 7: All Services Started
# ========================================
echo "[7/8] All services started!"
echo ""
echo "=========================================="
echo "  Wegent Standalone is running!"
echo "=========================================="
echo ""
echo "  Frontend:        http://localhost:3000"
echo "  Wework:          http://localhost:3000/wework"
echo "  Backend:         http://localhost:3000/api"
echo "  Workspace shell: Wework uses Backend Socket.IO terminal relay"
echo "  Redis:           localhost:6379 (embedded)"
echo ""
echo "  Data directory:      /app/data"
echo "  Workspace directory: /workspace"
echo "  Database:            /app/data/wegent.db"
echo "  Redis data:          /app/data/redis"
echo ""
echo "=========================================="
echo ""

# ========================================
# Signal Handling for Graceful Shutdown
# ========================================
shutdown() {
    local exit_code="${1:-0}"

    echo ""
    echo "Received shutdown signal, stopping services..."

    stop_pid "Nginx" "${NGINX_PID:-}"
    stop_pid "Frontend" "${FRONTEND_PID:-}"
    stop_pid "Standalone Executor" "${EXECUTOR_PID:-}"
    stop_pid "Backend" "${BACKEND_PID:-}"

    if [ -n "${REDIS_PID:-}" ]; then
        echo "  Stopping Redis (PID: ${REDIS_PID})..."
        redis-cli shutdown nosave 2>/dev/null || kill -TERM "$REDIS_PID" 2>/dev/null || true
    fi

    echo "  Waiting for services to stop..."
    wait "${NGINX_PID:-}" 2>/dev/null || true
    wait "${FRONTEND_PID:-}" 2>/dev/null || true
    wait "${EXECUTOR_PID:-}" 2>/dev/null || true
    wait "${BACKEND_PID:-}" 2>/dev/null || true
    wait "${REDIS_PID:-}" 2>/dev/null || true

    echo "  All services stopped"
    exit "$exit_code"
}

trap shutdown SIGTERM SIGINT SIGQUIT

# ========================================
# Keep Container Running
# ========================================
set +e
WAIT_PIDS=("$REDIS_PID" "$BACKEND_PID" "$FRONTEND_PID" "$NGINX_PID")
if [ -n "${EXECUTOR_PID:-}" ]; then
    WAIT_PIDS+=("$EXECUTOR_PID")
fi
wait -n "${WAIT_PIDS[@]}"
EXIT_CODE=$?
set -e

echo ""
echo "WARNING: A service has exited unexpectedly (exit code: ${EXIT_CODE})"

report_process "Redis" "$REDIS_PID"
report_process "Backend" "$BACKEND_PID"
report_process "Standalone Executor" "$EXECUTOR_PID"
report_process "Frontend" "$FRONTEND_PID"
report_process "Nginx" "$NGINX_PID"
shutdown "$EXIT_CODE"
