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

# Detect Python command and version
detect_python() {
    local python_cmd=""
    local python_version=""

    # Check python3 first
    if command -v python3 &> /dev/null; then
        python_cmd="python3"
        python_version=$(python3 --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
    elif command -v python &> /dev/null; then
        # Check if it's Python 2 or 3
        local ver=$(python --version 2>&1 | grep -oE '[0-9]+' | head -1)
        if [ "$ver" = "3" ]; then
            python_cmd="python"
            python_version=$(python --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
        elif [ "$ver" = "2" ]; then
            echo -e "${RED}Error: Only Python 2.x is detected, but Python 3.x is required.${NC}"
            echo ""
            echo -e "${YELLOW}Please install Python 3:${NC}"
            echo -e "  ${BLUE}macOS:${NC}    brew install python3"
            echo -e "  ${BLUE}Ubuntu:${NC}   sudo apt install python3"
            echo -e "  ${BLUE}CentOS:${NC}   sudo yum install python3"
            exit 1
        fi
    else
        echo -e "${RED}Error: Python is not installed.${NC}"
        echo ""
        echo -e "${YELLOW}Please install Python 3:${NC}"
        echo -e "  ${BLUE}macOS:${NC}    brew install python3"
        echo -e "  ${BLUE}Ubuntu:${NC}   sudo apt install python3"
        echo -e "  ${BLUE}CentOS:${NC}   sudo yum install python3"
        exit 1
    fi

    echo "$python_cmd"
}

# Check if uv is installed
check_uv_installed() {
    if command -v uv &> /dev/null; then
        return 0
    fi
    return 1
}

# Show uv installation instructions
show_uv_install_instructions() {
    echo -e "${RED}Error: uv is not installed.${NC}"
    echo ""
    echo -e "${YELLOW}uv is a fast Python package manager required by Wegent.${NC}"
    echo -e "${YELLOW}Please install uv using one of the following methods:${NC}"
    echo ""
    echo -e "  ${GREEN}Method 1: Official install script (Recommended)${NC}"
    echo -e "    ${BLUE}curl -LsSf https://astral.sh/uv/install.sh | sh${NC}"
    echo ""
    echo -e "  ${GREEN}Method 2: Using Homebrew (macOS/Linux)${NC}"
    echo -e "    ${BLUE}brew install uv${NC}"
    echo ""
    echo -e "  ${GREEN}Method 3: Using pip${NC}"
    # Check which pip command to recommend
    if command -v pip3 &> /dev/null; then
        echo -e "    ${BLUE}pip3 install uv${NC}"
    elif command -v pip &> /dev/null; then
        # Check if pip is Python 3
        local pip_python_ver=$(pip --version 2>&1 | grep -oE 'python [0-9]+' | grep -oE '[0-9]+')
        if [ "$pip_python_ver" = "3" ]; then
            echo -e "    ${BLUE}pip install uv${NC}"
        else
            echo -e "    ${BLUE}pip3 install uv${NC}  ${YELLOW}(requires pip for Python 3)${NC}"
        fi
    else
        echo -e "    ${BLUE}pip3 install uv${NC}  ${YELLOW}(requires pip for Python 3)${NC}"
    fi
    echo ""
    echo -e "${YELLOW}After installation, please restart your terminal or run:${NC}"
    echo -e "    ${BLUE}source ~/.bashrc${NC}  or  ${BLUE}source ~/.zshrc${NC}"
    echo ""
    exit 1
}

# Check if docker is installed
check_docker_installed() {
    if command -v docker &> /dev/null; then
        return 0
    fi
    return 1
}
# Show docker installation instructions
show_docker_install_instructions() {
    echo -e "${RED}Error: Docker is not installed or not running.${NC}"
    echo ""
    echo -e "${YELLOW}Docker is required by Wegent to run backend/executor services in containers.${NC}"
    echo -e "${YELLOW}Please install Docker using one of the following methods:${NC}"
    echo ""

    echo -e "  ${GREEN}Method 1: Docker Desktop (macOS / Windows)${NC}"
    echo -e "    ${BLUE}https://www.docker.com/products/docker-desktop/${NC}"
    echo ""

    echo -e "  ${GREEN}Method 2: Linux package manager${NC}"
    echo -e "    ${BLUE}Ubuntu / Debian:${NC}"
    echo -e "      sudo apt update"
    echo -e "      sudo apt install -y docker.io"
    echo ""
    echo -e "    ${BLUE}CentOS / RHEL / Alma / Rocky:${NC}"
    echo -e "      sudo dnf install -y docker-ce docker-ce-cli containerd.io"
    echo ""

    echo -e "  ${GREEN}Method 3: Official Docker convenience script${NC}"
    echo -e "    ${BLUE}curl -fsSL https://get.docker.com | sh${NC}"
    echo ""

    echo -e "${YELLOW}After installation, please ensure the Docker daemon is running, e.g.:${NC}"
    echo -e "    ${BLUE}sudo systemctl enable --now docker${NC}"
    echo ""
    echo -e "${YELLOW}Then re-run this script.${NC}"
    echo ""
    exit 1
}

# Check if MySQL and Redis are running
check_mysql_redis() {
    local mysql_running=false
    local redis_running=false

    # Check if MySQL container is running
    if docker ps --format '{{.Names}}' | grep -q "^wegent-mysql$"; then
        mysql_running=true
    fi

    # Check if Redis container is running
    if docker ps --format '{{.Names}}' | grep -q "^wegent-redis$"; then
        redis_running=true
    fi

    if [ "$mysql_running" = true ] && [ "$redis_running" = true ]; then
        echo -e "${GREEN}✓ MySQL and Redis are already running${NC}"
        return 0
    fi

    # Start MySQL and Redis if not running
    echo -e "${YELLOW}MySQL or Redis is not running. Starting them with docker-compose...${NC}"
    
    if ! docker compose up -d mysql redis; then
        echo -e "${RED}Error: Failed to start MySQL and Redis${NC}"
        echo -e "${YELLOW}Please check docker-compose.yml and ensure Docker is running${NC}"
        exit 1
    fi

    # Wait for services to be healthy
    echo -e "${YELLOW}Waiting for MySQL and Redis to be ready...${NC}"
    local max_wait=60
    local waited=0
    
    while [ $waited -lt $max_wait ]; do
        local mysql_healthy=false
        local redis_healthy=false
        
        # Check MySQL health
        if docker inspect wegent-mysql --format='{{.State.Health.Status}}' 2>/dev/null | grep -q "healthy"; then
            mysql_healthy=true
        fi
        
        # Check Redis health
        if docker inspect wegent-redis --format='{{.State.Health.Status}}' 2>/dev/null | grep -q "healthy"; then
            redis_healthy=true
        fi
        
        if [ "$mysql_healthy" = true ] && [ "$redis_healthy" = true ]; then
            echo -e "${GREEN}✓ MySQL and Redis are ready${NC}"
            return 0
        fi
        
        sleep 2
        waited=$((waited + 2))
        echo -e "  Waiting... (${waited}s/${max_wait}s)"
    done
    
    echo -e "${RED}Error: MySQL or Redis failed to become healthy within ${max_wait}s${NC}"
    echo -e "${YELLOW}You can check the logs with:${NC}"
    echo -e "  ${BLUE}docker logs wegent-mysql${NC}"
    echo -e "  ${BLUE}docker logs wegent-redis${NC}"
    exit 1
}

# Check if Node.js and npm are installed
check_node_installed() {
    if ! command -v node &> /dev/null; then
        echo -e "${RED}Error: Node.js is not installed.${NC}"
        echo ""
        echo -e "${YELLOW}Please install Node.js:${NC}"
        echo -e "  ${BLUE}macOS:${NC}    brew install node"
        echo -e "  ${BLUE}Ubuntu:${NC}   sudo apt install nodejs npm"
        echo -e "  ${BLUE}Or:${NC}       https://nodejs.org/"
        exit 1
    fi
    if ! command -v npm &> /dev/null; then
        echo -e "${RED}Error: npm is not installed.${NC}"
        echo ""
        echo -e "${YELLOW}Please install npm:${NC}"
        echo -e "  ${BLUE}macOS:${NC}    brew install npm"
        echo -e "  ${BLUE}Ubuntu:${NC}   sudo apt install npm"
        exit 1
    fi
    # Check Node.js version (require >= 20)
    NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -lt 20 ]; then
        echo -e "${RED}Error: Node.js v20 or higher is required (found $(node -v)).${NC}"
        echo -e "${YELLOW}Please upgrade Node.js:${NC}"
        echo -e "  ${BLUE}macOS:${NC}    brew install node@20"
        echo -e "  ${BLUE}Ubuntu:${NC}   use NodeSource or nvm to install Node 20"
        exit 1
    fi
}

# Check if libmagic is installed
check_libmagic_installed() {
    # Try to find libmagic library
    local found=false

    # Check common library paths
    if [ -f "/usr/local/lib/libmagic.dylib" ] || \
       [ -f "/opt/homebrew/lib/libmagic.dylib" ] || \
       [ -f "/usr/lib/libmagic.so.1" ] || \
       [ -f "/usr/lib/x86_64-linux-gnu/libmagic.so.1" ] || \
       [ -f "/usr/lib64/libmagic.so.1" ]; then
        found=true
    fi

    # Also check if file command exists (usually comes with libmagic)
    if command -v file &> /dev/null; then
        # Verify file command works (indicates libmagic is functional)
        if file --version &> /dev/null; then
            found=true
        fi
    fi

    if [ "$found" = false ]; then
        echo -e "${RED}Error: libmagic is not installed.${NC}"
        echo ""
        echo -e "${YELLOW}libmagic is required for file type detection.${NC}"
        echo -e "${YELLOW}Please install it using one of the following methods:${NC}"
        echo ""
        echo -e "  ${GREEN}macOS:${NC}"
        echo -e "    ${BLUE}brew install libmagic${NC}"
        echo ""
        echo -e "  ${GREEN}Debian/Ubuntu:${NC}"
        echo -e "    ${BLUE}sudo apt-get install libmagic1${NC}"
        echo ""
        echo -e "  ${GREEN}RHEL/CentOS/Fedora:${NC}"
        echo -e "    ${BLUE}sudo yum install file-libs${NC}"
        echo ""
        exit 1
    fi
}

# Sync Python dependencies for a directory
sync_python_deps() {
    local dir=$1
    local name=$2

    cd "$SCRIPT_DIR/$dir"

    # Check if .venv exists and has the shared module installed
    local need_sync=false

    if [ ! -d ".venv" ]; then
        need_sync=true
    elif [ ! -f ".venv/pyvenv.cfg" ]; then
        need_sync=true
    else
        # Check if shared module is installed
        if ! .venv/bin/python -c "import shared" 2>/dev/null; then
            need_sync=true
        fi
        # Check if pyproject.toml is newer than .venv
        if [ "pyproject.toml" -nt ".venv" ]; then
            need_sync=true
        fi
        # Check if uv.lock exists and is newer than .venv
        if [ -f "uv.lock" ] && [ "uv.lock" -nt ".venv" ]; then
            need_sync=true
        fi
    fi

    if [ "$need_sync" = true ]; then
        echo -e "  ${YELLOW}Syncing dependencies for $name...${NC}"
        # Use --frozen to avoid modifying uv.lock file
        uv sync --frozen
        echo -e "  ${GREEN}✓${NC} $name dependencies synced"
    else
        echo -e "  ${GREEN}✓${NC} $name dependencies are up to date"
    fi

    cd "$SCRIPT_DIR"
}

check_python_env() {
    local dir=$1
    local name=$2

    cd "$SCRIPT_DIR/$dir"
    if [ ! -f ".env" ]; then
        if [ ! -f ".env.example" ]; then
            echo -e "${RED} $name Error: .env.example not found${NC}"
            exit 1
        fi
        cp .env.example .env
        echo -e "${GREEN}✓ $name Created .env from .env.example${NC}"
    else
        echo -e "${GREEN}✓ $name .env file already exists${NC}"
    fi
    cd "$SCRIPT_DIR"
}

# Check frontend dependencies
check_frontend_dependencies() {
    local frontend_dir="$SCRIPT_DIR/frontend"

    if [ ! -d "$frontend_dir/node_modules" ]; then
        echo -e "${YELLOW}Frontend dependencies not installed. Installing...${NC}"
        cd "$frontend_dir"
        npm install --ignore-scripts
        cd "$SCRIPT_DIR"
        echo -e "${GREEN}✓ Frontend dependencies installed${NC}"
        return
    fi

    # Create a marker file to track last successful install
    local marker_file="$frontend_dir/node_modules/.install-marker"
    
    # Check if package.json is newer than the marker file
    if [ "$frontend_dir/package.json" -nt "$marker_file" ]; then
        echo -e "${YELLOW}Frontend dependencies may be outdated (package.json changed). Updating...${NC}"
        cd "$frontend_dir"
        npm install --ignore-scripts && touch "$marker_file"
        cd "$SCRIPT_DIR"
        echo -e "${GREEN}✓ Frontend dependencies updated${NC}"
        return
    fi

    # Check package-lock.json if exists and is newer than marker
    if [ -f "$frontend_dir/package-lock.json" ]; then
        if [ "$frontend_dir/package-lock.json" -nt "$marker_file" ]; then
            echo -e "${YELLOW}Frontend dependencies may be outdated (package-lock.json changed). Updating...${NC}"
            cd "$frontend_dir"
            npm install --ignore-scripts && touch "$marker_file"
            cd "$SCRIPT_DIR"
            echo -e "${GREEN}✓ Frontend dependencies updated${NC}"
            return
        fi
    fi

    # If marker doesn't exist, create it (first time check after node_modules exists)
    if [ ! -f "$marker_file" ]; then
        touch "$marker_file"
    fi

    echo -e "${GREEN}✓ Frontend dependencies are up to date${NC}"
}

# Default configuration
DEFAULT_FRONTEND_PORT=3000
DEFAULT_EXECUTOR_IMAGE="ghcr.io/wecode-ai/wegent-executor:latest"

FRONTEND_PORT=$DEFAULT_FRONTEND_PORT
EXECUTOR_IMAGE=$DEFAULT_EXECUTOR_IMAGE
DEFAULT_API_URL="http://localhost:8000"
API_URL=$DEFAULT_API_URL

# Get local IP address
get_local_ip() {
    # Try to get the local IP address, fallback to localhost if not available
    local ip=""
    
    # Method 1: Try Linux ip command (most reliable, works on Linux)
    if command -v ip &> /dev/null; then
        ip=$(ip route get 1 2>/dev/null | awk '{print $7; exit}')
    fi
    
    # Method 2: Try hostname -I (works on some Linux, gets first non-loopback IP)
    if [ -z "$ip" ] && command -v hostname &> /dev/null; then
        ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    fi
    
    # Method 3: Try macOS/BSD ifconfig (works on macOS)
    # Filter out docker/bridge interfaces (br-, docker, veth)
    if [ -z "$ip" ] && command -v ifconfig &> /dev/null; then
        ip=$(ifconfig | grep -A 1 "^en\|^eth" | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
        # If no en/eth interface, try any non-docker interface
        if [ -z "$ip" ]; then
            ip=$(ifconfig | grep -v "^br-\|^docker\|^veth" | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
        fi
    fi
    
    # Fallback to localhost if no IP found
    if [ -z "$ip" ]; then
        ip="localhost"
    fi
    
    echo "$ip"
}

DEFAULT_SOCKET_URL="http://$(get_local_ip):8000"
SOCKET_URL=$DEFAULT_SOCKET_URL

# PID file directory
PID_DIR="$SCRIPT_DIR/.pids"

show_help() {
    cat << EOF
Wegent One-Click Startup Script (Local Development Mode)

Usage: $0 [options]

Options:
  -p, --port PORT           Frontend port (default: $DEFAULT_FRONTEND_PORT)
  -e, --executor-image IMG  Executor image (default: $DEFAULT_EXECUTOR_IMAGE)
  --api-url                 Backend api url (default: $DEFAULT_API_URL)
  --socket-url              Socket direct url (default: $DEFAULT_SOCKET_URL)
  --stop                    Stop all services
  --restart                 Restart all services
  --status                  Check service status
  -h, --help                Show help information

Examples:
  $0                                    # Start with default configuration
  $0 -p 8080                            # Specify frontend port as 8080
  $0 -e my-executor:latest              # Specify custom executor image
  $0 --socket-url http://192.168.1.100:8000  # Specify socket URL with your IP
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
    --api-url)
        API_URL="$2"
        shift 2
        ;;
    --socket-url)
        SOCKET_URL="$2"
        shift 2
        ;;
    --stop)
        ACTION="stop"
        shift
        ;;
    --restart)
        ACTION="restart"
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

    # Wait for service to start
    sleep 2

    if kill -0 "$pid" 2>/dev/null; then
        echo $pid > "$PID_DIR/${name}.pid"
        echo -e "    ${GREEN}✓${NC} $name started (PID: $pid)"
    else
        echo -e "    ${RED}✗${NC} $name failed to start, check log: $log_file"
        return 1
    fi

    cd "$SCRIPT_DIR"
}

# Health check for a service
check_service_health() {
    local name=$1
    local port=$2
    local health_path=$3
    local max_retries=15
    local retry_interval=2

    echo -n "  Checking $name..."

    for ((i=1; i<=max_retries; i++)); do
        # Try health endpoint first if provided
        if [ -n "$health_path" ]; then
            if curl -s --connect-timeout 2 "http://localhost:$port$health_path" >/dev/null 2>&1; then
                echo -e " ${GREEN}✓${NC} healthy (port $port)"
                return 0
            fi
        fi

        # Fallback: try root endpoint or just check if port is responding
        if curl -s --connect-timeout 2 "http://localhost:$port/" >/dev/null 2>&1; then
            echo -e " ${GREEN}✓${NC} healthy (port $port)"
            return 0
        fi

        # Also try connecting to port directly (for services that may not respond to HTTP immediately)
        if nc -z localhost $port 2>/dev/null; then
            # Port is open, give it a bit more time for HTTP
            if [ $i -ge 5 ]; then
                echo -e " ${GREEN}✓${NC} responding (port $port)"
                return 0
            fi
        fi

        sleep $retry_interval
    done

    echo -e " ${RED}✗${NC} failed (port $port not responding)"
    echo -e "    ${YELLOW}Check log: $PID_DIR/${name}.log${NC}"
    return 1
}

# Start all services
start_services() {
    echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║      Wegent One-Click Startup Script (Local Dev)      ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
    echo ""

    # Check prerequisites
    echo -e "${BLUE}Checking prerequisites...${NC}"

    # Check Python
    PYTHON_CMD=$(detect_python)
    local python_version=$($PYTHON_CMD --version 2>&1)
    echo -e "  ${GREEN}✓${NC} Python detected: $python_version"

    # Check uv
    if ! check_uv_installed; then
        show_uv_install_instructions
    fi
    local uv_version=$(uv --version 2>&1)
    echo -e "  ${GREEN}✓${NC} uv detected: $uv_version"

    if ! check_docker_installed; then
        show_docker_install_instructions
    fi
    local docker_version=$(docker --version | awk '{print $3}' | tr -d ',')
    echo -e "  ${GREEN}✓${NC} docker detected: $docker_version"

    # Check and start MySQL and Redis if needed
    check_mysql_redis

    # Check libmagic
    check_libmagic_installed
    echo -e "  ${GREEN}✓${NC} libmagic detected"

    # Check Node.js
    check_node_installed
    local node_version=$(node --version 2>&1)
    local npm_version=$(npm --version 2>&1)
    echo -e "  ${GREEN}✓${NC} Node.js detected: $node_version (npm $npm_version)"

    echo ""
    echo -e "${GREEN}Configuration:${NC}"
    echo -e "  Frontend Port:    $FRONTEND_PORT"
    echo -e "  Executor Image:   $EXECUTOR_IMAGE"
    echo -e "  API URL:          $API_URL"
    echo -e "  Socket URL:       $SOCKET_URL"
    echo ""

    # Check port conflicts
    echo -e "${BLUE}Checking port usage...${NC}"
    if ! check_all_ports; then
        exit 1
    fi
    echo -e "${GREEN}✓ All ports available${NC}"
    echo ""

    # Sync Python dependencies
    echo -e "${BLUE}Checking Python dependencies...${NC}"
    sync_python_deps "backend" "Backend"
    sync_python_deps "chat_shell" "Chat Shell"
    sync_python_deps "executor_manager" "Executor Manager"
    echo ""

    # Check Python env
    echo -e "${BLUE}Checking Python env...${NC}"
    check_python_env "backend" "Backend"
    check_python_env "chat_shell" "Chat Shell"
    echo ""

    # Check frontend dependencies
    echo -e "${BLUE}Checking frontend dependencies...${NC}"
    check_frontend_dependencies
    echo ""

    echo -e "${BLUE}Starting services...${NC}"

    # 1. Start Backend
    start_service "backend" "backend" \
        "source .venv/bin/activate && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"

    # 2. Start Chat Shell
    start_service "chat_shell" "chat_shell" \
        "export CHAT_SHELL_MODE=http && export CHAT_SHELL_STORAGE_TYPE=remote && export CHAT_SHELL_REMOTE_STORAGE_URL=http://localhost:8000/api/internal && source .venv/bin/activate && .venv/bin/python -m uvicorn chat_shell.main:app --reload --host 0.0.0.0 --port 8100"

    # 3. Start Executor Manager
    # TASK_API_DOMAIN uses local IP so docker containers can access the backend
    # DOCKER_HOST_ADDR=localhost so executor_manager can access docker containers
    start_service "executor_manager" "executor_manager" \
        "export EXECUTOR_IMAGE=$EXECUTOR_IMAGE && export TASK_API_DOMAIN=http://$(get_local_ip):8000 && export DOCKER_HOST_ADDR=localhost && export NETWORK=wegent-network && source .venv/bin/activate && uvicorn main:app --reload --host 0.0.0.0 --port 8001"

    # 4. Start Frontend (run in background)
    echo -e "  Starting ${BLUE}frontend${NC}..."
    cd "$SCRIPT_DIR/frontend"

    # Set environment variables
    export RUNTIME_INTERNAL_API_URL=$API_URL
    export RUNTIME_SOCKET_DIRECT_URL=$SOCKET_URL

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
    echo -e "${BLUE}Performing health checks...${NC}"

    # Health check for all services
    local failed=0
    check_service_health "backend" 8000 "/health" || failed=1
    check_service_health "chat_shell" 8100 "/health" || failed=1
    check_service_health "executor_manager" 8001 "/health" || failed=1
    check_service_health "frontend" $FRONTEND_PORT "" || failed=1

    echo ""
    if [ $failed -eq 1 ]; then
        echo -e "${YELLOW}════════════════════════════════════════════════════════${NC}"
        echo -e "${YELLOW}⚠️  Some services failed to start properly${NC}"
        echo ""
        echo -e "${YELLOW}Please check the log files for details:${NC}"
        echo -e "  Backend:          $PID_DIR/backend.log"
        echo -e "  Frontend:         $PID_DIR/frontend.log"
        echo -e "  Chat Shell:       $PID_DIR/chat_shell.log"
        echo -e "  Executor Manager: $PID_DIR/executor_manager.log"
        echo -e "${YELLOW}════════════════════════════════════════════════════════${NC}"
        exit 1
    fi

    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}All services started successfully!${NC}"
    echo ""
    echo -e "${GREEN}🌐 Access URLs:${NC}"
    echo -e "  Local Frontend:  ${BLUE}http://localhost:$FRONTEND_PORT${NC}"
    echo -e "  Remote Frontend: ${BLUE}http://$(get_local_ip):$FRONTEND_PORT${NC}"
    echo -e "  Socket URL:      ${BLUE}$SOCKET_URL${NC}"
    echo ""
    echo -e "${YELLOW}📋 Share with others for remote access:${NC}"
    echo -e "  Frontend URL: ${BLUE}http://$(get_local_ip):$FRONTEND_PORT${NC}"
    echo -e "  Socket URL:   ${BLUE}$SOCKET_URL${NC}"
    echo ""
    echo -e "${YELLOW}Common Commands:${NC}"
    echo -e "  $0 --status    Check service status"
    echo -e "  $0 --stop      Stop all services"
    echo -e "  $0 --socket-url http://YOUR_IP:8000  # Set custom socket URL"
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
    restart)
        stop_services
        start_services
        ;;
    status)
        show_status
        ;;
esac
