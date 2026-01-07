#!/bin/bash

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Wegent One-Click Startup Script (Local Development)
# Start all services: Backend, Frontend, Chat Shell, Executor Manager

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Default configuration
DEFAULT_FRONTEND_PORT=3000
DEFAULT_EXECUTOR_IMAGE="ghcr.io/wecode-ai/wegent-executor:1.0.29"

FRONTEND_PORT=$DEFAULT_FRONTEND_PORT
EXECUTOR_IMAGE=$DEFAULT_EXECUTOR_IMAGE

# PID file directory
PID_DIR="$SCRIPT_DIR/.pids"

show_help() {
    cat << EOF
Wegent One-Click Startup Script (Local Development Mode)

Usage: $0 [options]

Options:
  -p, --port PORT           Frontend port (default: $DEFAULT_FRONTEND_PORT)
  -e, --executor-image IMG  Executor image (default: $DEFAULT_EXECUTOR_IMAGE)
  --stop                    Stop all services
  --status                  Check service status
  -h, --help                Show help information

Examples:
  $0                                    # Start with default configuration
  $0 -p 8080                            # Specify frontend port as 8080
  $0 -e my-executor:latest              # Specify custom executor image
  $0 --stop                             # Stop all services

EOF
}

# Parse arguments
ACTION="start"

while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--port)
            FRONTEND_PORT="$2"
            shift 2
            ;;
        -e|--executor-image)
            EXECUTOR_IMAGE="$2"
            shift 2
            ;;
        --stop)
            ACTION="stop"
            shift
            ;;
        --status)
            ACTION="status"
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown parameter: $1${NC}"
            show_help
            exit 1
            ;;
    esac
done

# Create PID directory
mkdir -p "$PID_DIR"

# Check if port is in use
check_port() {
    local port=$1
    local service=$2
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 1
    fi
    return 0
}

# Check all required ports
check_all_ports() {
    local ports=("8000:Backend" "8100:Chat Shell" "8001:Executor Manager" "$FRONTEND_PORT:Frontend")
    local conflicts=()

    for item in "${ports[@]}"; do
        local port="${item%%:*}"
        local service="${item##*:}"
        if ! check_port "$port" "$service"; then
            conflicts+=("$port ($service)")
        fi
    done

    if [ ${#conflicts[@]} -gt 0 ]; then
        echo -e "${RED}Port conflict! The following ports are already in use:${NC}"
        for conflict in "${conflicts[@]}"; do
            echo -e "  ${RED}●${NC} $conflict"
        done
        echo ""
        echo -e "${YELLOW}Solutions:${NC}"
        echo -e "  1. Stop the process occupying the port:"
        echo -e "     ${BLUE}lsof -i :PORT${NC}  # View occupying process"
        echo -e "     ${BLUE}kill -9 PID${NC}    # Stop process"
        echo ""
        echo -e "  2. Or run ${BLUE}$0 --stop${NC} to stop previously started services"
        echo ""
        echo -e "  3. If frontend port conflicts, specify another port:"
        echo -e "     ${BLUE}$0 -p 3001${NC}"
        return 1
    fi
    return 0
}

# Stop all services
stop_services() {
    echo -e "${YELLOW}Stopping all Wegent services...${NC}"

    local services=("backend" "frontend" "chat_shell" "executor_manager")

    for service in "${services[@]}"; do
        local pid_file="$PID_DIR/${service}.pid"
        if [ -f "$pid_file" ]; then
            local pid=$(cat "$pid_file")
            if kill -0 "$pid" 2>/dev/null; then
                echo -e "  Stopping $service (PID: $pid)..."
                kill "$pid" 2>/dev/null || true
                # Wait for process to exit
                for i in {1..10}; do
                    if ! kill -0 "$pid" 2>/dev/null; then
                        break
                    fi
                    sleep 0.5
                done
                # Force terminate
                if kill -0 "$pid" 2>/dev/null; then
                    kill -9 "$pid" 2>/dev/null || true
                fi
            fi
            rm -f "$pid_file"
        fi
    done

    # Clean up potentially remaining processes
    pkill -f "uvicorn app.main:app" 2>/dev/null || true
    pkill -f "uvicorn main:app.*8001" 2>/dev/null || true
    pkill -f "uvicorn chat_shell.main:app" 2>/dev/null || true
    pkill -f "npm run dev.*$FRONTEND_PORT" 2>/dev/null || true

    echo -e "${GREEN}All services stopped${NC}"
}

# Show service status
show_status() {
    echo -e "${BLUE}Wegent Service Status:${NC}"
    echo ""

    local services=("backend:8000" "frontend:3000" "chat_shell:8100" "executor_manager:8001")

    for item in "${services[@]}"; do
        local service="${item%%:*}"
        local port="${item##*:}"
        local pid_file="$PID_DIR/${service}.pid"

        if [ -f "$pid_file" ]; then
            local pid=$(cat "$pid_file")
            if kill -0 "$pid" 2>/dev/null; then
                echo -e "  ${GREEN}●${NC} $service (PID: $pid, Port: $port)"
            else
                echo -e "  ${RED}●${NC} $service (exited)"
                rm -f "$pid_file"
            fi
        else
            # Check if port is in use
            if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
                echo -e "  ${YELLOW}●${NC} $service (port $port in use)"
            else
                echo -e "  ${RED}●${NC} $service (not running)"
            fi
        fi
    done
}

# Start a single service
start_service() {
    local name=$1
    local dir=$2
    local cmd=$3
    local log_file="$PID_DIR/${name}.log"

    echo -e "  Starting ${BLUE}$name${NC}..."

    cd "$SCRIPT_DIR/$dir"

    # Run in background and save PID
    nohup bash -c "$cmd" > "$log_file" 2>&1 &
    local pid=$!
    echo $pid > "$PID_DIR/${name}.pid"

    # Wait for service to start
    sleep 2

    if kill -0 "$pid" 2>/dev/null; then
        echo -e "    ${GREEN}✓${NC} $name started (PID: $pid)"
    else
        echo -e "    ${RED}✗${NC} $name failed to start, check log: $log_file"
        return 1
    fi

    cd "$SCRIPT_DIR"
}

# Start all services
start_services() {
    echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║      Wegent One-Click Startup Script (Local Dev)      ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${GREEN}Configuration:${NC}"
    echo -e "  Frontend Port:    $FRONTEND_PORT"
    echo -e "  Executor Image:   $EXECUTOR_IMAGE"
    echo ""

    # Check port conflicts
    echo -e "${BLUE}Checking port usage...${NC}"
    if ! check_all_ports; then
        exit 1
    fi
    echo -e "${GREEN}✓ All ports available${NC}"
    echo ""

    echo -e "${BLUE}Starting services...${NC}"

    # 1. Start Backend
    start_service "backend" "backend" \
        "source .venv/bin/activate 2>/dev/null || uv sync; uvicorn app.main:app --host 0.0.0.0 --port 8000"

    # 2. Start Chat Shell
    start_service "chat_shell" "chat_shell" \
        "export CHAT_SHELL_MODE=http && export CHAT_SHELL_STORAGE_TYPE=remote && export CHAT_SHELL_REMOTE_STORAGE_URL=http://localhost:8000/api/internal && source .venv/bin/activate 2>/dev/null || uv sync; .venv/bin/python -m uvicorn chat_shell.main:app --host 0.0.0.0 --port 8100"

    # 3. Start Executor Manager
    start_service "executor_manager" "executor_manager" \
        "export EXECUTOR_IMAGE=$EXECUTOR_IMAGE && export TASK_API_DOMAIN=http://localhost:8000 && export NETWORK=wegent-network && source .venv/bin/activate 2>/dev/null || uv sync; uvicorn main:app --host 0.0.0.0 --port 8001"

    # 4. Start Frontend (run in background)
    echo -e "  Starting ${BLUE}frontend${NC}..."
    cd "$SCRIPT_DIR/frontend"

    # Set environment variables
    export RUNTIME_INTERNAL_API_URL="http://localhost:8000"
    export RUNTIME_SOCKET_DIRECT_URL="http://localhost:8000"

    # Start frontend in background
    nohup bash -c "PORT=$FRONTEND_PORT npm run dev" > "$PID_DIR/frontend.log" 2>&1 &
    local frontend_pid=$!
    echo $frontend_pid > "$PID_DIR/frontend.pid"

    sleep 3

    if kill -0 "$frontend_pid" 2>/dev/null; then
        echo -e "    ${GREEN}✓${NC} frontend started (PID: $frontend_pid)"
    else
        echo -e "    ${RED}✗${NC} frontend failed to start, check log: $PID_DIR/frontend.log"
    fi

    cd "$SCRIPT_DIR"

    echo ""
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}All services started!${NC}"
    echo ""
    echo -e "  Frontend URL: ${BLUE}http://localhost:$FRONTEND_PORT${NC}"
    echo ""
    echo -e "${YELLOW}Common Commands:${NC}"
    echo -e "  $0 --status    Check service status"
    echo -e "  $0 --stop      Stop all services"
    echo ""
    echo -e "${YELLOW}Log Files:${NC}"
    echo -e "  Backend:          $PID_DIR/backend.log"
    echo -e "  Frontend:         $PID_DIR/frontend.log"
    echo -e "  Chat Shell:       $PID_DIR/chat_shell.log"
    echo -e "  Executor Manager: $PID_DIR/executor_manager.log"
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
}

# Execute action
case $ACTION in
    start)
        start_services
        ;;
    stop)
        stop_services
        ;;
    status)
        show_status
        ;;
esac
