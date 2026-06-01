#!/bin/bash

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
STUB_DIR="$TMP_DIR/bin"
mkdir -p "$STUB_DIR"

ROOT_ENV="$REPO_ROOT/.env"
BACKEND_ENV="$REPO_ROOT/backend/.env"
ROOT_ENV_BACKUP="$TMP_DIR/root.env.backup"
BACKEND_ENV_BACKUP="$TMP_DIR/backend.env.backup"
ROOT_ENV_EXISTED=false
BACKEND_ENV_EXISTED=false

cleanup() {
    if [ -d "$REPO_ROOT/.pids" ]; then
        for pid_file in "$REPO_ROOT"/.pids/*.pid; do
            [ -f "$pid_file" ] || continue
            local pid
            pid="$(cat "$pid_file" 2>/dev/null || true)"
            if [ -n "$pid" ]; then
                kill "$pid" 2>/dev/null || true
            fi
        done
        rm -rf "$REPO_ROOT/.pids"
    fi

    if [ "$ROOT_ENV_EXISTED" = true ]; then
        mv "$ROOT_ENV_BACKUP" "$ROOT_ENV"
    else
        rm -f "$ROOT_ENV"
    fi

    if [ "$BACKEND_ENV_EXISTED" = true ]; then
        mv "$BACKEND_ENV_BACKUP" "$BACKEND_ENV"
    else
        rm -f "$BACKEND_ENV"
    fi

    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [ -f "$ROOT_ENV" ]; then
    ROOT_ENV_EXISTED=true
    cp "$ROOT_ENV" "$ROOT_ENV_BACKUP"
fi

if [ -f "$BACKEND_ENV" ]; then
    BACKEND_ENV_EXISTED=true
    cp "$BACKEND_ENV" "$BACKEND_ENV_BACKUP"
fi

cat > "$ROOT_ENV" <<'EOF'
BACKEND_PORT=8000
CHAT_SHELL_PORT=8100
EXECUTOR_MANAGER_PORT=8001
KNOWLEDGE_RUNTIME_PORT=8200
WEGENT_FRONTEND_PORT=3000
WEWORK_PORT=1420
EXECUTOR_IMAGE=test-executor:latest
WEGENT_SOCKET_URL=http://localhost:8000
EOF

cat > "$BACKEND_ENV" <<'EOF'
DATABASE_URL=mysql+pymysql://root:123456@localhost:3306/wegent
REDIS_URL=redis://localhost:6379/0
EOF

cat > "$STUB_DIR/lsof" <<'EOF'
#!/bin/bash
for arg in "$@"; do
    case "$arg" in
        :8000|:3000)
            echo 99999
            exit 0
            ;;
    esac
done
exit 1
EOF

cat > "$STUB_DIR/route" <<'EOF'
#!/bin/bash
if [ "$1" = "-n" ] && [ "$2" = "get" ] && [ "$3" = "default" ]; then
    echo "   route to: default"
    echo "interface: en0"
fi
EOF

cat > "$STUB_DIR/ifconfig" <<'EOF'
#!/bin/bash
if [ "$1" = "en0" ] || [ $# -eq 0 ]; then
    echo "en0: flags=8863<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST> mtu 1500"
    echo "        inet 192.0.2.10 netmask 0xffffff00 broadcast 192.0.2.255"
fi
EOF

cat > "$STUB_DIR/docker" <<'EOF'
#!/bin/bash
case "$1" in
    --version)
        echo "Docker version 27.0.0, build test"
        ;;
    ps)
        echo "wegent-mysql"
        echo "wegent-redis"
        ;;
    inspect)
        echo "healthy"
        ;;
    compose)
        exit 0
        ;;
    *)
        exit 0
        ;;
esac
EOF

cat > "$STUB_DIR/uv" <<'EOF'
#!/bin/bash
if [ "$1" = "--version" ]; then
    echo "uv 0.5.0"
fi
exit 0
EOF

cat > "$STUB_DIR/node" <<'EOF'
#!/bin/bash
echo "v20.0.0"
EOF

cat > "$STUB_DIR/npm" <<'EOF'
#!/bin/bash
if [ "$1" = "--version" ]; then
    echo "10.0.0"
fi
exit 0
EOF

cat > "$STUB_DIR/curl" <<'EOF'
#!/bin/bash
exit 0
EOF

cat > "$STUB_DIR/nc" <<'EOF'
#!/bin/bash
exit 0
EOF

cat > "$STUB_DIR/file" <<'EOF'
#!/bin/bash
if [ "$1" = "--version" ]; then
    echo "file-5.45"
fi
exit 0
EOF

cat > "$STUB_DIR/bash" <<'EOF'
#!/bin/bash
if [ "$1" = "-c" ]; then
    sleep 60
    exit 0
fi
exec /bin/bash "$@"
EOF

chmod +x "$STUB_DIR"/*

run_start_with_stubs() {
    local input="${1:-}"
    shift || true

    set +e
    if [ -n "$input" ]; then
        output="$(
            cd "$REPO_ROOT"
            printf "%b" "$input" | PATH="$STUB_DIR:$PATH" /bin/bash "$REPO_ROOT/start.sh" "$@" 2>&1
        )"
    else
        output="$(
            cd "$REPO_ROOT"
            PATH="$STUB_DIR:$PATH" /bin/bash "$REPO_ROOT/start.sh" "$@" 2>&1
        )"
    fi
    status=$?
    set -e
}

reset_runtime_files() {
    if [ -d "$REPO_ROOT/.pids" ]; then
        for pid_file in "$REPO_ROOT"/.pids/*.pid; do
            [ -f "$pid_file" ] || continue
            local pid
            pid="$(cat "$pid_file" 2>/dev/null || true)"
            if [ -n "$pid" ]; then
                kill "$pid" 2>/dev/null || true
            fi
        done
        rm -rf "$REPO_ROOT/.pids"
    fi
}

output=""
status=0

set +e
run_start_with_stubs "" backend frontend
set -e

if [ "$status" -ne 0 ]; then
    echo "Expected start.sh backend frontend to succeed"
    echo "$output"
    exit 1
fi

if ! grep -q "Port 8000 (Backend) is already in use; using 8002" <<< "$output"; then
    echo "Expected backend port auto-selection message"
    echo "$output"
    exit 1
fi

if ! grep -q "Port 3000 (Frontend) is already in use; using 3001" <<< "$output"; then
    echo "Expected frontend port auto-selection message"
    echo "$output"
    exit 1
fi

if ! grep -q "Services started: backend frontend" <<< "$output"; then
    echo "Expected only backend and frontend to start"
    echo "$output"
    exit 1
fi

for unexpected in chat_shell executor_manager knowledge_runtime wework; do
    if grep -q "Starting .*${unexpected}" <<< "$output"; then
        echo "Unexpected service started: $unexpected"
        echo "$output"
        exit 1
    fi
done

if [ "$(cat "$REPO_ROOT/.pids/backend.port")" != "8002" ]; then
    echo "Expected backend runtime port file to contain 8002"
    exit 1
fi

if [ "$(cat "$REPO_ROOT/.pids/frontend.port")" != "3001" ]; then
    echo "Expected frontend runtime port file to contain 3001"
    exit 1
fi

echo "start.sh service selection and auto port test passed"

reset_runtime_files
cat > "$ROOT_ENV" <<'EOF'
BACKEND_PORT=8000
CHAT_SHELL_PORT=8100
EXECUTOR_MANAGER_PORT=8001
KNOWLEDGE_RUNTIME_PORT=8200
WEGENT_FRONTEND_PORT=3000
WEWORK_PORT=1420
EXECUTOR_IMAGE=test-executor:latest
WEGENT_SOCKET_URL=http://10.0.0.99:8000
EOF

run_start_with_stubs "y\n" be fe

if [ "$status" -ne 0 ]; then
    echo "Expected start.sh be fe with stale socket IP to succeed"
    echo "$output"
    exit 1
fi

if grep -q "IP Address Mismatch Warning" <<< "$output"; then
    echo "Expected stale socket IP to auto-refresh without warning"
    echo "$output"
    exit 1
fi

if ! grep -q "Socket URL:          http://192.0.2.10:8002" <<< "$output"; then
    echo "Expected Socket URL to use current machine IP and resolved backend port"
    echo "$output"
    exit 1
fi

echo "start.sh stale socket IP auto-refresh test passed"

reset_runtime_files
rm -f "$ROOT_ENV"

run_start_with_stubs "\n\n\n\n" be fe

if [ "$status" -ne 0 ]; then
    echo "Expected first-run start.sh be fe to succeed"
    echo "$output"
    exit 1
fi

if grep -q "2. Chat Shell Port" <<< "$output"; then
    echo "Expected first-run be fe setup to skip Chat Shell prompt"
    echo "$output"
    exit 1
fi

if grep -q "3. Executor Manager Port" <<< "$output"; then
    echo "Expected first-run be fe setup to skip Executor Manager prompt"
    echo "$output"
    exit 1
fi

if grep -q "4. Knowledge Runtime Port" <<< "$output"; then
    echo "Expected first-run be fe setup to skip Knowledge Runtime prompt"
    echo "$output"
    exit 1
fi

if grep -q "6. WeWork Port" <<< "$output"; then
    echo "Expected first-run be fe setup to skip WeWork prompt"
    echo "$output"
    exit 1
fi

if ! grep -q "1. Backend Port" <<< "$output"; then
    echo "Expected first-run be fe setup to ask for Backend port"
    echo "$output"
    exit 1
fi

if ! grep -q "2. Frontend Port" <<< "$output"; then
    echo "Expected first-run be fe setup to ask for Frontend port"
    echo "$output"
    exit 1
fi

echo "start.sh scoped first-run setup test passed"

reset_runtime_files
mkdir -p "$REPO_ROOT/.pids"
echo "999998" > "$REPO_ROOT/.pids/backend.pid"
echo "999997" > "$REPO_ROOT/.pids/frontend.pid"
echo "8002" > "$REPO_ROOT/.pids/backend.port"
echo "3001" > "$REPO_ROOT/.pids/frontend.port"

run_start_with_stubs "" --stop

if [ "$status" -ne 0 ]; then
    echo "Expected start.sh --stop to stop tracked services"
    echo "$output"
    exit 1
fi

if ! grep -q "Stopping services: backend frontend" <<< "$output"; then
    echo "Expected stop without service args to target only tracked backend/frontend"
    echo "$output"
    exit 1
fi

for unexpected in chat_shell executor_manager knowledge_runtime wework; do
    if grep -q "Stopping services: .*${unexpected}" <<< "$output"; then
        echo "Unexpected service targeted by default stop: $unexpected"
        echo "$output"
        exit 1
    fi
done

echo "start.sh default stop tracked services test passed"
