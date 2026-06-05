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
CYAN='\033[0;36m'
NC='\033[0m'

# Configuration file path (use .env file, same as docker-compose)
CONFIG_FILE="$SCRIPT_DIR/.env"

# Load configuration from .env file
load_config() {
    if [ -f "$CONFIG_FILE" ]; then
        echo -e "${BLUE}Loading configuration from .env...${NC}"
        # Read config file line by line, skip comments and empty lines
        while IFS='=' read -r key value || [ -n "$key" ]; do
            # Skip empty lines and comments
            [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
            # Remove leading/trailing whitespace
            key=$(echo "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
            value=$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
            # Remove quotes from value if present
            value=$(echo "$value" | sed 's/^["'"'"']//;s/["'"'"']$//')
            # Export the variable
            if [ -n "$key" ] && [ -n "$value" ]; then
                export "$key=$value"
                echo -e "  ${GREEN}✓${NC} Loaded: $key"
            fi
        done < "$CONFIG_FILE"
        echo ""

        # Backfill any missing port variables added after initial config was created
        local needs_save=false
        if ! grep -q "^KNOWLEDGE_RUNTIME_PORT=" "$CONFIG_FILE" 2>/dev/null; then
            echo -e "  ${YELLOW}↳${NC} Adding missing KNOWLEDGE_RUNTIME_PORT=$DEFAULT_KNOWLEDGE_RUNTIME_PORT to .env"
            needs_save=true
        fi
        if ! grep -q "^WEWORK_PORT=" "$CONFIG_FILE" 2>/dev/null; then
            echo -e "  ${YELLOW}↳${NC} Adding missing WEWORK_PORT=$DEFAULT_WEWORK_PORT to .env"
            needs_save=true
        fi
        if [ "$needs_save" = true ]; then
            save_config
            echo ""
        fi
    fi
}

# Save configuration to .env file
# Only saves start.sh specific variables, preserves existing content
save_config() {
    local temp_file=$(mktemp)
    
    # If .env exists, copy it but remove the variables we're going to update
    if [ -f "$CONFIG_FILE" ]; then
        grep -v "^BACKEND_PORT=" "$CONFIG_FILE" | \
        grep -v "^CHAT_SHELL_PORT=" | \
        grep -v "^EXECUTOR_MANAGER_PORT=" | \
        grep -v "^KNOWLEDGE_RUNTIME_PORT=" | \
        grep -v "^WEGENT_FRONTEND_PORT=" | \
        grep -v "^WEWORK_PORT=" | \
        grep -v "^EXECUTOR_IMAGE=" | \
        grep -v "^WEGENT_SOCKET_URL=" > "$temp_file" || true
    fi
    
    # Check if the start.sh section header exists
    if ! grep -q "# START.SH CONFIGURATION" "$temp_file" 2>/dev/null; then
        # Add header if .env is empty or doesn't have our section
        if [ ! -s "$temp_file" ]; then
            cat > "$temp_file" << 'EOF'
# Wegent Configuration
# This file is used by both docker-compose and start.sh
# Copy from .env.example and customize as needed

EOF
        fi
        
        cat >> "$temp_file" << EOF
# =============================================================================
# START.SH CONFIGURATION (Local Development)
# =============================================================================

# Service Ports
BACKEND_PORT=$BACKEND_PORT
CHAT_SHELL_PORT=$CHAT_SHELL_PORT
EXECUTOR_MANAGER_PORT=$EXECUTOR_MANAGER_PORT
KNOWLEDGE_RUNTIME_PORT=$KNOWLEDGE_RUNTIME_PORT
WEGENT_FRONTEND_PORT=$WEGENT_FRONTEND_PORT
WEWORK_PORT=$WEWORK_PORT

# Executor Docker image
EXECUTOR_IMAGE=$EXECUTOR_IMAGE

# Socket URL (for WebSocket connections, should be accessible from browser)
# For remote access, use your machine's IP address instead of localhost
WEGENT_SOCKET_URL=$WEGENT_SOCKET_URL
EOF
    else
        # Update existing values
        echo "" >> "$temp_file"
        echo "BACKEND_PORT=$BACKEND_PORT" >> "$temp_file"
        echo "CHAT_SHELL_PORT=$CHAT_SHELL_PORT" >> "$temp_file"
        echo "EXECUTOR_MANAGER_PORT=$EXECUTOR_MANAGER_PORT" >> "$temp_file"
        echo "KNOWLEDGE_RUNTIME_PORT=$KNOWLEDGE_RUNTIME_PORT" >> "$temp_file"
        echo "WEGENT_FRONTEND_PORT=$WEGENT_FRONTEND_PORT" >> "$temp_file"
        echo "WEWORK_PORT=$WEWORK_PORT" >> "$temp_file"
        echo "EXECUTOR_IMAGE=$EXECUTOR_IMAGE" >> "$temp_file"
        echo "WEGENT_SOCKET_URL=$WEGENT_SOCKET_URL" >> "$temp_file"
    fi
    
    mv "$temp_file" "$CONFIG_FILE"
    echo -e "${GREEN}✓ Configuration saved to .env${NC}"
}

# Interactive configuration initialization
# Args:
#   $1 - "standalone" (default): exit after completion, show full messages
#        "embedded": don't exit, used when called from start_services
init_config() {
    local mode="${1:-standalone}"
    shift || true
    local init_backend=false
    local init_frontend=false
    local init_chat_shell=false
    local init_executor_manager=false
    local init_knowledge_runtime=false
    local init_wework=false

    if [ $# -eq 0 ]; then
        init_backend=true
        init_frontend=true
        init_chat_shell=true
        init_executor_manager=true
        init_knowledge_runtime=true
        init_wework=true
    else
        local init_service
        for init_service in "$@"; do
            case "$init_service" in
                backend)
                    init_backend=true
                    ;;
                frontend)
                    init_frontend=true
                    ;;
                chat_shell)
                    init_chat_shell=true
                    ;;
                executor_manager)
                    init_executor_manager=true
                    ;;
                knowledge_runtime)
                    init_knowledge_runtime=true
                    ;;
                wework)
                    init_wework=true
                    ;;
            esac
        done
    fi
    
    echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║       Wegent Configuration Initialization Wizard       ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
    echo ""

    # Check if config file already exists (only in standalone mode)
    if [ "$mode" = "standalone" ] && [ -f "$CONFIG_FILE" ]; then
        echo -e "${YELLOW}⚠️  Configuration file .env already exists.${NC}"
        echo -e "Current configuration:"
        echo ""
        cat "$CONFIG_FILE" | grep -v "^#" | grep -v "^$" | while read line; do
            echo -e "  ${CYAN}$line${NC}"
        done
        echo ""
        read -p "Do you want to overwrite it? [y/N]: " overwrite
        if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
            echo -e "${YELLOW}Configuration initialization cancelled.${NC}"
            exit 0
        fi
        echo ""
    fi

    echo -e "${GREEN}Please configure the following settings:${NC}"
    echo -e "${YELLOW}(Press Enter to use default value)${NC}"
    echo ""

    # Get local IP for default socket URL
    local local_ip=$(get_local_ip)

    # === Service Ports ===
    echo -e "${BLUE}━━━ Service Ports ━━━${NC}"
    echo ""
    local setting_index=1

    # Backend Port
    if [ "$init_backend" = true ]; then
        echo -e "${CYAN}${setting_index}. Backend Port${NC}"
        echo -e "   The port for Backend API service."
        read -p "   Backend Port [$DEFAULT_BACKEND_PORT]: " input_backend_port
        BACKEND_PORT=${input_backend_port:-$DEFAULT_BACKEND_PORT}
        setting_index=$((setting_index + 1))
        echo ""
    fi

    # Chat Shell Port
    if [ "$init_chat_shell" = true ]; then
        echo -e "${CYAN}${setting_index}. Chat Shell Port${NC}"
        echo -e "   The port for Chat Shell service."
        read -p "   Chat Shell Port [$DEFAULT_CHAT_SHELL_PORT]: " input_chat_shell_port
        CHAT_SHELL_PORT=${input_chat_shell_port:-$DEFAULT_CHAT_SHELL_PORT}
        setting_index=$((setting_index + 1))
        echo ""
    fi

    # Executor Manager Port
    if [ "$init_executor_manager" = true ]; then
        echo -e "${CYAN}${setting_index}. Executor Manager Port${NC}"
        echo -e "   The port for Executor Manager service."
        read -p "   Executor Manager Port [$DEFAULT_EXECUTOR_MANAGER_PORT]: " input_executor_manager_port
        EXECUTOR_MANAGER_PORT=${input_executor_manager_port:-$DEFAULT_EXECUTOR_MANAGER_PORT}
        setting_index=$((setting_index + 1))
        echo ""
    fi

    # Knowledge Runtime Port
    if [ "$init_knowledge_runtime" = true ]; then
        echo -e "${CYAN}${setting_index}. Knowledge Runtime Port${NC}"
        echo -e "   The port for Knowledge Runtime service (RAG operations)."
        read -p "   Knowledge Runtime Port [$DEFAULT_KNOWLEDGE_RUNTIME_PORT]: " input_knowledge_runtime_port
        KNOWLEDGE_RUNTIME_PORT=${input_knowledge_runtime_port:-$DEFAULT_KNOWLEDGE_RUNTIME_PORT}
        setting_index=$((setting_index + 1))
        echo ""
    fi

    # Frontend Port
    if [ "$init_frontend" = true ]; then
        echo -e "${CYAN}${setting_index}. Frontend Port${NC}"
        echo -e "   The port where the web UI will be accessible."
        read -p "   Frontend Port [$DEFAULT_WEGENT_FRONTEND_PORT]: " input_frontend_port
        WEGENT_FRONTEND_PORT=${input_frontend_port:-$DEFAULT_WEGENT_FRONTEND_PORT}
        setting_index=$((setting_index + 1))
        echo ""
    fi

    # WeWork Port
    if [ "$init_wework" = true ]; then
        echo -e "${CYAN}${setting_index}. WeWork Port${NC}"
        echo -e "   The port for WeWork multi-platform workspace app."
        read -p "   WeWork Port [$DEFAULT_WEWORK_PORT]: " input_wework_port
        WEWORK_PORT=${input_wework_port:-$DEFAULT_WEWORK_PORT}
        setting_index=$((setting_index + 1))
        echo ""
    fi

    # === Other Settings ===
    echo -e "${BLUE}━━━ Other Settings ━━━${NC}"
    echo ""

    # Executor Image
    if [ "$init_executor_manager" = true ]; then
        echo -e "${CYAN}${setting_index}. Executor Docker Image${NC}"
        echo -e "   The Docker image used for task execution."
        read -p "   Executor Image [$DEFAULT_EXECUTOR_IMAGE]: " input_image
        EXECUTOR_IMAGE=${input_image:-$DEFAULT_EXECUTOR_IMAGE}
        setting_index=$((setting_index + 1))
        echo ""
    fi

    # Socket URL
    if [ "$init_backend" = true ] || [ "$init_frontend" = true ]; then
        echo -e "${CYAN}${setting_index}. Socket URL${NC}"
        echo -e "   The WebSocket URL for real-time communication."
        echo -e "   For remote access, use your machine's IP address."
        echo -e "   Detected local IP: ${GREEN}$local_ip${NC}"
        local default_socket="http://$local_ip:$BACKEND_PORT"
        read -p "   Socket URL [$default_socket]: " input_socket_url
        WEGENT_SOCKET_URL=${input_socket_url:-$default_socket}
        setting_index=$((setting_index + 1))
        echo ""
    fi

    # Show summary
    echo -e "${BLUE}════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}Configuration Summary:${NC}"
    echo -e "  ${YELLOW}Service Ports:${NC}"
    echo -e "    Backend Port:        ${CYAN}$BACKEND_PORT${NC}"
    echo -e "    Chat Shell Port:     ${CYAN}$CHAT_SHELL_PORT${NC}"
    echo -e "    Executor Mgr Port:   ${CYAN}$EXECUTOR_MANAGER_PORT${NC}"
    echo -e "    Knowledge Rtm Port:  ${CYAN}$KNOWLEDGE_RUNTIME_PORT${NC}"
    echo -e "    Frontend Port:       ${CYAN}$WEGENT_FRONTEND_PORT${NC}"
    echo -e "    WeWork Port:         ${CYAN}$WEWORK_PORT${NC}"
    echo -e "  ${YELLOW}Other Settings:${NC}"
    echo -e "    Executor Image:      ${CYAN}$EXECUTOR_IMAGE${NC}"
    echo -e "    Socket URL:          ${CYAN}$WEGENT_SOCKET_URL${NC}"
    echo -e "${BLUE}════════════════════════════════════════════════════════${NC}"
    echo ""

    read -p "Save this configuration? [Y/n]: " confirm
    if [[ "$confirm" =~ ^[Nn]$ ]]; then
        echo -e "${YELLOW}Configuration not saved.${NC}"
        if [ "$mode" = "standalone" ]; then
            exit 0
        else
            return 1
        fi
    fi

    save_config

    echo ""
    echo -e "${GREEN}✓ Configuration initialized successfully!${NC}"
    
    # Only show these messages in standalone mode
    if [ "$mode" = "standalone" ]; then
        echo -e "${YELLOW}You can now run './start.sh' to start all services.${NC}"
        echo -e "${YELLOW}To modify configuration, edit .env or run './start.sh --init' again.${NC}"
    fi
}

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

# Detect if running in WSL
is_wsl() {
    if grep -qi microsoft /proc/version 2>/dev/null; then
        return 0
    fi
    return 1
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

# Patch backend DATABASE_URL and REDIS_URL to use configured MYSQL_PORT and REDIS_PORT.
# When start.sh runs services locally, MySQL/Redis are exposed on host ports from
# MYSQL_PORT/REDIS_PORT in .env, but backend/.env hardcodes the default ports (3306/6379).
# This function reads backend/.env, patches the ports, and exports them as env vars
# so pydantic-settings (which prefers env vars over .env file values) picks them up.
patch_backend_service_urls() {
    local backend_env="$SCRIPT_DIR/backend/.env"

    if [ ! -f "$backend_env" ]; then
        return
    fi

    # Patch DATABASE_URL with MYSQL_PORT if configured
    if [ -n "$MYSQL_PORT" ]; then
        local db_url
        db_url=$(grep "^DATABASE_URL=" "$backend_env" | cut -d'=' -f2-)
        if [ -n "$db_url" ]; then
            # Replace port in @host:PORT pattern (supports optional trailing slash)
            # e.g., @localhost:3306/db -> @localhost:23306/db
            local patched_db_url
            patched_db_url=$(echo "$db_url" | sed -E "s#(@[^/:]+):[0-9]+(/|$)#\1:$MYSQL_PORT\2#")
            export DATABASE_URL="$patched_db_url"
            echo -e "  ${GREEN}✓${NC} DATABASE_URL patched to use MYSQL_PORT=$MYSQL_PORT"
        fi
    fi

    # Patch REDIS_URL with REDIS_PORT if configured
    if [ -n "$REDIS_PORT" ]; then
        local redis_url
        redis_url=$(grep "^REDIS_URL=" "$backend_env" | cut -d'=' -f2-)
        if [ -n "$redis_url" ]; then
            # Replace port in host:PORT pattern (supports optional credentials and trailing slash)
            # e.g., redis://127.0.0.1:6379/0 or redis://:pwd@127.0.0.1:6379/0
            local patched_redis_url
            patched_redis_url=$(echo "$redis_url" | sed -E "s#(//([^/@]+@)?[^/:]+):[0-9]+(/|$)#\1:$REDIS_PORT\3#")
            export REDIS_URL="$patched_redis_url"
            echo -e "  ${GREEN}✓${NC} REDIS_URL patched to use REDIS_PORT=$REDIS_PORT"
        fi
    fi
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

clean_frontend_cache() {
    local frontend_cache_dir="$SCRIPT_DIR/frontend/.next"

    echo -e "${BLUE}Cleaning frontend cache...${NC}"

    if [ -d "$frontend_cache_dir" ]; then
        rm -rf "$frontend_cache_dir"
        echo -e "  ${GREEN}✓${NC} Removed $frontend_cache_dir"
    else
        echo -e "  ${GREEN}✓${NC} Frontend cache is already clean"
    fi
}

# Get local IP address (defined early as it's used by default values)
get_local_ip() {
    # Try to get the local IP address, fallback to localhost if not available
    local ip=""
    local default_iface=""

    # Method 1: Get IP from the default route interface (most reliable)
    # macOS: use 'route -n get default' to get the interface
    # Linux: use 'ip route' to get the interface
    if [ -z "$ip" ]; then
        # Try macOS style
        if command -v route &> /dev/null; then
            default_iface=$(route -n get default 2>/dev/null | grep "interface:" | awk '{print $2}')
            if [ -n "$default_iface" ] && command -v ifconfig &> /dev/null; then
                ip=$(ifconfig "$default_iface" 2>/dev/null | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
            fi
        fi

        # Try Linux style with ip command
        if [ -z "$ip" ] && command -v ip &> /dev/null; then
            default_iface=$(ip route 2>/dev/null | grep default | awk '{print $5}' | head -1)
            if [ -n "$default_iface" ]; then
                ip=$(ip addr show "$default_iface" 2>/dev/null | grep "inet " | awk '{print $2}' | cut -d/ -f1 | head -1)
            fi
        fi
    fi

    # Method 2: Try hostname -I (works on some Linux, gets first non-loopback IP)
    if [ -z "$ip" ] && command -v hostname &> /dev/null; then
        ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    fi

    # Method 3: Try macOS/BSD ifconfig with common interface patterns
    # Filter out docker/bridge interfaces (br-, docker, veth)
    if [ -z "$ip" ] && command -v ifconfig &> /dev/null; then
        # First try en0 (most common default on macOS)
        ip=$(ifconfig en0 2>/dev/null | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
        # Then try en/eth interfaces
        if [ -z "$ip" ]; then
            ip=$(ifconfig | grep -A 1 "^en\|^eth" | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
        fi
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

# Default configuration (use same variable names as docker-compose)
# Service ports
DEFAULT_BACKEND_PORT=8000
DEFAULT_CHAT_SHELL_PORT=8100
DEFAULT_EXECUTOR_MANAGER_PORT=8001
DEFAULT_KNOWLEDGE_RUNTIME_PORT=8200
DEFAULT_WEGENT_FRONTEND_PORT=3000
DEFAULT_WEWORK_PORT=1420

# Other settings
DEFAULT_EXECUTOR_IMAGE="ghcr.io/wecode-ai/wegent-executor:latest"

# Initialize port variables
BACKEND_PORT=$DEFAULT_BACKEND_PORT
CHAT_SHELL_PORT=$DEFAULT_CHAT_SHELL_PORT
EXECUTOR_MANAGER_PORT=$DEFAULT_EXECUTOR_MANAGER_PORT
KNOWLEDGE_RUNTIME_PORT=$DEFAULT_KNOWLEDGE_RUNTIME_PORT
WEGENT_FRONTEND_PORT=$DEFAULT_WEGENT_FRONTEND_PORT
WEWORK_PORT=$DEFAULT_WEWORK_PORT
EXECUTOR_IMAGE=$DEFAULT_EXECUTOR_IMAGE

# These will be computed after ports are loaded from config
WEGENT_SOCKET_URL=""
TASK_API_DOMAIN=""
EXECUTOR_MANAGER_URL=""
KNOWLEDGE_RUNTIME_URL=""

# PID file directory
PID_DIR="$SCRIPT_DIR/.pids"
AUTO_PORT_SEARCH_LIMIT=100

normalize_service_name() {
    case "$1" in
        all)
            echo "all"
            ;;
        backend|be|api)
            echo "backend"
            ;;
        frontend|fe|ui)
            echo "frontend"
            ;;
        chat_shell|cs|chat)
            echo "chat_shell"
            ;;
        executor_manager|em|executor)
            echo "executor_manager"
            ;;
        knowledge_runtime|kr|knowledge)
            echo "knowledge_runtime"
            ;;
        wework|ww)
            echo "wework"
            ;;
        *)
            return 1
            ;;
    esac
}

valid_service_names() {
    echo "all, backend|be|api, frontend|fe|ui, chat_shell|cs|chat, executor_manager|em|executor, knowledge_runtime|kr|knowledge, wework|ww"
}

get_configured_service_port() {
    case "$1" in
        backend)
            echo "$BACKEND_PORT"
            ;;
        frontend)
            echo "$WEGENT_FRONTEND_PORT"
            ;;
        chat_shell)
            echo "$CHAT_SHELL_PORT"
            ;;
        executor_manager)
            echo "$EXECUTOR_MANAGER_PORT"
            ;;
        knowledge_runtime)
            echo "$KNOWLEDGE_RUNTIME_PORT"
            ;;
        wework)
            echo "$WEWORK_PORT"
            ;;
    esac
}

set_configured_service_port() {
    local service=$1
    local port=$2

    case "$service" in
        backend)
            BACKEND_PORT="$port"
            ;;
        frontend)
            WEGENT_FRONTEND_PORT="$port"
            ;;
        chat_shell)
            CHAT_SHELL_PORT="$port"
            ;;
        executor_manager)
            EXECUTOR_MANAGER_PORT="$port"
            ;;
        knowledge_runtime)
            KNOWLEDGE_RUNTIME_PORT="$port"
            ;;
        wework)
            WEWORK_PORT="$port"
            ;;
    esac
}

service_port_set_by_cli() {
    case "$1" in
        backend)
            [ -n "$CLI_BACKEND_PORT" ]
            ;;
        frontend)
            [ -n "$CLI_WEGENT_FRONTEND_PORT" ]
            ;;
        chat_shell)
            [ -n "$CLI_CHAT_SHELL_PORT" ]
            ;;
        executor_manager)
            [ -n "$CLI_EXECUTOR_MANAGER_PORT" ]
            ;;
        knowledge_runtime)
            [ -n "$CLI_KNOWLEDGE_RUNTIME_PORT" ]
            ;;
        wework)
            [ -n "$CLI_WEWORK_PORT" ]
            ;;
        *)
            return 1
            ;;
    esac
}

get_runtime_service_port() {
    local service=$1
    local port_file="$PID_DIR/${service}.port"

    if [ -f "$port_file" ]; then
        cat "$port_file"
    else
        get_configured_service_port "$service"
    fi
}

write_runtime_service_port() {
    local service=$1
    local port=$2

    echo "$port" > "$PID_DIR/${service}.port"
}

remove_runtime_service_port() {
    local service=$1

    rm -f "$PID_DIR/${service}.port"
}

get_tracked_services() {
    local service

    for service in backend frontend chat_shell executor_manager knowledge_runtime wework; do
        if [ -f "$PID_DIR/${service}.pid" ]; then
            echo "$service"
        fi
    done
}

show_help() {
    cat << EOF
Wegent One-Click Startup Script (Local Development Mode)

Usage: $0 [options]

Options:
  -b, --backend-port PORT       Backend API port (default: $DEFAULT_BACKEND_PORT)
  -c, --chat-shell-port PORT    Chat Shell port (default: $DEFAULT_CHAT_SHELL_PORT)
  -m, --executor-manager-port PORT  Executor Manager port (default: $DEFAULT_EXECUTOR_MANAGER_PORT)
  -k, --knowledge-runtime-port PORT  Knowledge Runtime port (default: $DEFAULT_KNOWLEDGE_RUNTIME_PORT)
  -p, --port PORT               Frontend port (default: $DEFAULT_WEGENT_FRONTEND_PORT)
  -e, --executor-image IMG      Executor image (default: $DEFAULT_EXECUTOR_IMAGE)
  --socket-url URL              Socket direct url (auto-computed from BACKEND_PORT)
  --clean-frontend-cache        Remove frontend .next cache before starting frontend
  --init                        Interactive configuration initialization
  --stop [services...]          Stop all known service ports by default. Can specify multiple:
                                $(valid_service_names)
  -g, --graceful                Use graceful shutdown with stop/restart (SIGTERM, wait 30s, then SIGKILL)
  --restart [services...]       Restart services (default: all)
  --status                      Check service status
  -h, --help                    Show help information

Service Selection:
  Passing service names without --stop/--restart starts only those services.
  Example: $0 backend frontend

Configuration File:
  The script uses the .env configuration file in the project root.
  Variables defined in .env will be loaded automatically on startup.
  This is the same file used by docker-compose.yml.
  Use '--init' to create or update the configuration file interactively.

  Supported variables in .env:
    Service Ports:
      BACKEND_PORT          - Backend API port (default: $DEFAULT_BACKEND_PORT)
      CHAT_SHELL_PORT       - Chat Shell port (default: $DEFAULT_CHAT_SHELL_PORT)
      EXECUTOR_MANAGER_PORT - Executor Manager port (default: $DEFAULT_EXECUTOR_MANAGER_PORT)
      KNOWLEDGE_RUNTIME_PORT - Knowledge Runtime port (default: $DEFAULT_KNOWLEDGE_RUNTIME_PORT)
      WEGENT_FRONTEND_PORT  - Frontend port (default: $DEFAULT_WEGENT_FRONTEND_PORT)

    Other Settings:
      EXECUTOR_IMAGE        - Docker image for executor
      WEGENT_SOCKET_URL     - WebSocket URL (auto-computed: http://LOCAL_IP:BACKEND_PORT)
      TASK_API_DOMAIN       - URL for executor_manager to call backend (auto-computed)
      EXECUTOR_MANAGER_URL  - URL for backend to call executor_manager (auto-computed)
      KNOWLEDGE_RUNTIME_URL - URL for backend to call knowledge_runtime (auto-computed)

Examples:
  $0                                    # Start with default configuration
  $0 backend frontend                   # Start only backend and frontend
  $0 be fe                              # Start only backend and frontend (short names)
  $0 --clean-frontend-cache             # Start after clearing frontend .next cache
  $0 --init                             # Initialize configuration interactively
  $0 -b 8001                            # Specify backend port as 8001
  $0 -c 8101                            # Specify chat shell port as 8101
  $0 -m 8002                            # Specify executor manager port as 8002
  $0 -k 8201                            # Specify knowledge runtime port as 8201
  $0 -p 8080                            # Specify frontend port as 8080
  $0 -e my-executor:latest              # Specify custom executor image
  $0 --socket-url http://192.168.1.100:8000  # Specify socket URL with your IP
  $0 --stop                             # Stop all known service ports (force kill)
  $0 --stop all                         # Stop all known services (force kill)
  $0 --stop backend frontend            # Stop only backend and frontend
  $0 --stop be cs kr                    # Stop backend, chat_shell, knowledge_runtime (short names)
  $0 --stop --graceful                  # Stop with graceful shutdown
  $0 --restart --graceful               # Restart with graceful shutdown
  $0 --restart backend --graceful       # Restart only backend gracefully

EOF
}

# Parse arguments
ACTION="start"
START_SERVICES=()
STOP_SERVICES=()

# Track which variables were set via command line (to override config file)
CLI_BACKEND_PORT=""
CLI_CHAT_SHELL_PORT=""
CLI_EXECUTOR_MANAGER_PORT=""
CLI_KNOWLEDGE_RUNTIME_PORT=""
CLI_WEGENT_FRONTEND_PORT=""
CLI_WEWORK_PORT=""
CLI_EXECUTOR_IMAGE=""
CLI_WEGENT_SOCKET_URL=""
CLI_CLEAN_FRONTEND_CACHE=""
CLEAN_FRONTEND_CACHE="false"

while [[ $# -gt 0 ]]; do
case $1 in
    -b|--backend-port)
        CLI_BACKEND_PORT="$2"
        shift 2
        ;;
    -c|--chat-shell-port)
        CLI_CHAT_SHELL_PORT="$2"
        shift 2
        ;;
    -m|--executor-manager-port)
        CLI_EXECUTOR_MANAGER_PORT="$2"
        shift 2
        ;;
    -k|--knowledge-runtime-port)
        CLI_KNOWLEDGE_RUNTIME_PORT="$2"
        shift 2
        ;;
    -p|--port)
        CLI_WEGENT_FRONTEND_PORT="$2"
        shift 2
        ;;
    -w|--wework-port)
        CLI_WEWORK_PORT="$2"
        shift 2
        ;;
    -e|--executor-image)
        CLI_EXECUTOR_IMAGE="$2"
        shift 2
        ;;
    --socket-url)
        CLI_WEGENT_SOCKET_URL="$2"
        shift 2
        ;;
    --clean-frontend-cache)
        CLI_CLEAN_FRONTEND_CACHE="true"
        CLEAN_FRONTEND_CACHE="true"
        shift
        ;;
    --init)
        ACTION="init"
        shift
        ;;
    --stop)
        ACTION="stop"
        shift
        # Collect service names to stop (if any)
        STOP_SERVICES=()
        while [[ $# -gt 0 ]] && [[ "$1" != --* ]] && [[ "$1" != -* ]]; do
            STOP_SERVICES+=("$1")
            shift
        done
        ;;
    --restart)
        ACTION="restart"
        shift
        # Collect service names to restart (if any)
        STOP_SERVICES=()
        while [[ $# -gt 0 ]] && [[ "$1" != --* ]] && [[ "$1" != -* ]]; do
            STOP_SERVICES+=("$1")
            shift
        done
        ;;
    --status)
        ACTION="status"
        shift
        ;;
    -g|--graceful)
        GRACEFUL_STOP="true"
        shift
        ;;
    -h|--help)
        show_help
        exit 0
        ;;
    *)
        if [ "$ACTION" = "start" ]; then
            if normalized_service=$(normalize_service_name "$1"); then
                START_SERVICES+=("$normalized_service")
                shift
            else
                echo -e "${RED}Unknown parameter or service: $1${NC}"
                echo -e "Valid services: $(valid_service_names)"
                show_help
                exit 1
            fi
        else
            echo -e "${RED}Unknown parameter: $1${NC}"
            show_help
            exit 1
        fi
        ;;
esac
done

# Load configuration from .env file (if exists)
# This sets variables from the config file
load_config

# Apply command line overrides (CLI arguments take precedence over config file)
[ -n "$CLI_BACKEND_PORT" ] && BACKEND_PORT="$CLI_BACKEND_PORT"
[ -n "$CLI_CHAT_SHELL_PORT" ] && CHAT_SHELL_PORT="$CLI_CHAT_SHELL_PORT"
[ -n "$CLI_EXECUTOR_MANAGER_PORT" ] && EXECUTOR_MANAGER_PORT="$CLI_EXECUTOR_MANAGER_PORT"
[ -n "$CLI_KNOWLEDGE_RUNTIME_PORT" ] && KNOWLEDGE_RUNTIME_PORT="$CLI_KNOWLEDGE_RUNTIME_PORT"
[ -n "$CLI_WEGENT_FRONTEND_PORT" ] && WEGENT_FRONTEND_PORT="$CLI_WEGENT_FRONTEND_PORT"
[ -n "$CLI_WEWORK_PORT" ] && WEWORK_PORT="$CLI_WEWORK_PORT"
[ -n "$CLI_EXECUTOR_IMAGE" ] && EXECUTOR_IMAGE="$CLI_EXECUTOR_IMAGE"
[ -n "$CLI_WEGENT_SOCKET_URL" ] && WEGENT_SOCKET_URL="$CLI_WEGENT_SOCKET_URL"
[ -n "$CLI_CLEAN_FRONTEND_CACHE" ] && CLEAN_FRONTEND_CACHE="$CLI_CLEAN_FRONTEND_CACHE"

url_port_matches() {
    local url=$1
    local expected_port=$2
    local actual_port

    actual_port=$(echo "$url" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' | sed -E 's#^[^/:]+:([0-9]+).*#\1#')
    [ "$actual_port" = "$expected_port" ]
}

replace_url_port() {
    local url=$1
    local port=$2

    echo "$url" | sed -E "s#(^[a-zA-Z][a-zA-Z0-9+.-]*://[^/:]+):[0-9]+#\1:$port#"
}

extract_url_host() {
    local url=$1

    echo "$url" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' | cut -d/ -f1 | cut -d: -f1
}

replace_url_host_and_port() {
    local url=$1
    local host=$2
    local port=$3

    echo "$url" | sed -E "s#(^[a-zA-Z][a-zA-Z0-9+.-]*://)[^/:]+(:[0-9]+)?#\1$host:$port#"
}

update_url_port_if_matches() {
    local url=$1
    local old_port=$2
    local new_port=$3

    if [ -n "$url" ] && url_port_matches "$url" "$old_port"; then
        replace_url_port "$url" "$new_port"
    else
        echo "$url"
    fi
}

compute_derived_urls() {
    local previous_backend_port="${1:-}"
    local previous_executor_manager_port="${2:-}"
    local previous_knowledge_runtime_port="${3:-}"
    local previous_socket_url="$WEGENT_SOCKET_URL"
    local socket_host=""

    LOCAL_IP=$(get_local_ip)

    if [ -z "$WEGENT_SOCKET_URL" ]; then
        WEGENT_SOCKET_URL="http://$LOCAL_IP:$BACKEND_PORT"
    elif [ -z "$CLI_WEGENT_SOCKET_URL" ]; then
        socket_host=$(extract_url_host "$WEGENT_SOCKET_URL")
        if [ -n "$socket_host" ] && [ "$socket_host" != "localhost" ] && [ "$socket_host" != "127.0.0.1" ] && [ "$socket_host" != "$LOCAL_IP" ]; then
            WEGENT_SOCKET_URL=$(replace_url_host_and_port "$WEGENT_SOCKET_URL" "$LOCAL_IP" "$BACKEND_PORT")
        elif [ -n "$previous_backend_port" ] && [ "$BACKEND_PORT" != "$previous_backend_port" ]; then
            WEGENT_SOCKET_URL=$(update_url_port_if_matches "$WEGENT_SOCKET_URL" "$previous_backend_port" "$BACKEND_PORT")
        fi
    fi

    if [ -z "$TASK_API_DOMAIN" ] || [ "$TASK_API_DOMAIN" = "$previous_socket_url" ]; then
        TASK_API_DOMAIN="$WEGENT_SOCKET_URL"
    elif [ -n "$previous_backend_port" ] && [ "$BACKEND_PORT" != "$previous_backend_port" ]; then
        TASK_API_DOMAIN=$(update_url_port_if_matches "$TASK_API_DOMAIN" "$previous_backend_port" "$BACKEND_PORT")
    fi

    if [ -z "$EXECUTOR_MANAGER_URL" ]; then
        EXECUTOR_MANAGER_URL="http://localhost:$EXECUTOR_MANAGER_PORT"
    elif [ -n "$previous_executor_manager_port" ] && [ "$EXECUTOR_MANAGER_PORT" != "$previous_executor_manager_port" ]; then
        EXECUTOR_MANAGER_URL=$(update_url_port_if_matches "$EXECUTOR_MANAGER_URL" "$previous_executor_manager_port" "$EXECUTOR_MANAGER_PORT")
    fi

    if [ -z "$KNOWLEDGE_RUNTIME_URL" ]; then
        KNOWLEDGE_RUNTIME_URL="http://localhost:$KNOWLEDGE_RUNTIME_PORT"
    elif [ -n "$previous_knowledge_runtime_port" ] && [ "$KNOWLEDGE_RUNTIME_PORT" != "$previous_knowledge_runtime_port" ]; then
        KNOWLEDGE_RUNTIME_URL=$(update_url_port_if_matches "$KNOWLEDGE_RUNTIME_URL" "$previous_knowledge_runtime_port" "$KNOWLEDGE_RUNTIME_PORT")
    fi

    if [ -z "$BACKEND_API_URL" ]; then
        BACKEND_API_URL="http://$LOCAL_IP:$BACKEND_PORT"
    elif [ -n "$previous_backend_port" ] && [ "$BACKEND_PORT" != "$previous_backend_port" ]; then
        BACKEND_API_URL=$(update_url_port_if_matches "$BACKEND_API_URL" "$previous_backend_port" "$BACKEND_PORT")
    fi

    export BACKEND_API_URL="$BACKEND_API_URL"
    export KNOWLEDGE_RUNTIME_URL="$KNOWLEDGE_RUNTIME_URL"
}

# Compute derived URLs based on configured ports (if not already set from config)
compute_derived_urls

# Create PID directory
mkdir -p "$PID_DIR"

get_port_listener_pids() {
    local port=$1
    local pids=""

    if command -v lsof >/dev/null 2>&1; then
        pids=$(lsof -Pi :"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)
    fi

    if [ -z "$pids" ] && command -v ss >/dev/null 2>&1; then
        pids=$(ss -H -lntp "sport = :$port" 2>/dev/null | sed -nE 's/.*pid=([0-9]+).*/\1/p' | sort -u || true)
    fi

    if [ -n "$pids" ]; then
        echo "$pids"
    fi
}

is_port_listening() {
    local port=$1
    [ -n "$(get_port_listener_pids "$port")" ]
}

# Check if port is in use
check_port() {
    local port=$1
    local service=$2
    if is_port_listening "$port"; then
        # Port in use - check if it's our own process
        if [ -n "$service" ] && [ -f "$PID_DIR/$service.pid" ]; then
            local our_pid
            our_pid=$(cat "$PID_DIR/$service.pid" 2>/dev/null)
            local port_pids
            port_pids=$(get_port_listener_pids "$port")
            if [ -n "$our_pid" ] && grep -qx "$our_pid" <<< "$port_pids"; then
                return 0
            fi
        fi
        return 1
    fi
    return 0
}

RESOLVED_START_PORTS=()

is_reserved_start_port() {
    local candidate=$1
    local current_service="${2:-}"
    local ignore_configured_ports="${3:-false}"
    local reserved_port
    local reserved_service

    for reserved_port in "${RESOLVED_START_PORTS[@]}"; do
        if [ "$candidate" = "$reserved_port" ]; then
            return 0
        fi
    done

    if [ "$ignore_configured_ports" = true ]; then
        return 1
    fi

    for reserved_service in backend frontend chat_shell executor_manager knowledge_runtime wework; do
        if [ "$reserved_service" = "$current_service" ]; then
            continue
        fi

        reserved_port=$(get_configured_service_port "$reserved_service")
        if [ "$candidate" = "$reserved_port" ]; then
            return 0
        fi
    done

    return 1
}

find_available_port() {
    local start_port=$1
    local service=$2
    local ignore_configured_ports="${3:-false}"
    local port=$start_port
    local attempts=0

    while [ "$attempts" -le "$AUTO_PORT_SEARCH_LIMIT" ]; do
        if check_port "$port" "$service" && ! is_reserved_start_port "$port" "$service" "$ignore_configured_ports"; then
            echo "$port"
            return 0
        fi

        port=$((port + 1))
        attempts=$((attempts + 1))
    done

    return 1
}

resolve_start_service_port() {
    local service=$1
    local label=$2
    local current_port
    local ignore_configured_ports=false
    local new_port

    current_port=$(get_configured_service_port "$service")

    if service_port_set_by_cli "$service"; then
        ignore_configured_ports=true
    fi

    if check_port "$current_port" "$service" && ! is_reserved_start_port "$current_port" "$service" "$ignore_configured_ports"; then
        RESOLVED_START_PORTS+=("$current_port")
        return 0
    fi

    if ! new_port=$(find_available_port "$((current_port + 1))" "$service" "$ignore_configured_ports"); then
        echo -e "  ${RED}●${NC} Unable to find an available port for $label after $current_port"
        return 1
    fi

    if ! check_port "$current_port" "$service"; then
        echo -e "  ${YELLOW}●${NC} Port $current_port ($label) is already in use; using $new_port"
    else
        echo -e "  ${YELLOW}●${NC} Port $current_port ($label) conflicts with another selected service; using $new_port"
    fi

    set_configured_service_port "$service" "$new_port"
    RESOLVED_START_PORTS+=("$new_port")
    return 0
}

# Check if WEGENT_SOCKET_URL IP matches local IP
check_socket_url_ip() {
    local local_ip=$(get_local_ip)
    local socket_ip=""

    # Extract IP from WEGENT_SOCKET_URL (format: http://IP:PORT or https://IP:PORT)
    if [ -n "$WEGENT_SOCKET_URL" ]; then
        socket_ip=$(echo "$WEGENT_SOCKET_URL" | sed -E 's|^https?://||' | cut -d':' -f1)
    fi

    # Skip check if not configured
    if [ -z "$socket_ip" ]; then
        return 0
    fi

    # Skip check for localhost/127.0.0.1 as they should work on any machine
    if [ "$socket_ip" = "localhost" ] || [ "$socket_ip" = "127.0.0.1" ]; then
        return 0
    fi

    # Check if IPs match
    if [ "$socket_ip" != "$local_ip" ]; then
        echo ""
        echo -e "${RED}╔════════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${RED}║                   ⚠️  IP Address Mismatch Warning              ║${NC}"
        echo -e "${RED}╚════════════════════════════════════════════════════════════════╝${NC}"
        echo ""
        echo -e "${YELLOW}Current Machine IP:${NC}  ${CYAN}$local_ip${NC}"
        echo -e "${YELLOW}WEGENT_SOCKET_URL:${NC}   ${CYAN}$WEGENT_SOCKET_URL${NC}"
        echo ""
        echo -e "${RED}⚠️  Warning: The configured Socket URL IP does not match the current machine IP!${NC}"
        echo ""
        echo -e "${YELLOW}This may cause:${NC}"
        echo -e "  • Frontend unable to connect to WebSocket"
        echo -e "  • Connection failure or timeout on the page"
        echo -e "  • Real-time messages cannot be pushed"
        echo ""
        echo -e "${YELLOW}If this was not intentional, update WEGENT_SOCKET_URL in .env to:${NC}"
        echo -e "  ${GREEN}http://$local_ip:$BACKEND_PORT${NC}"
        echo ""
    fi
}

# Stop services (all or specified)
# Usage: stop_services <graceful> [service1 service2 ...]
# Services: backend, frontend, chat_shell, executor_manager, knowledge_runtime, wework
stop_services() {
    local graceful="${1:-false}"
    shift

    # Define all services and their ports
    local all_services=("backend" "frontend" "chat_shell" "executor_manager" "knowledge_runtime" "wework")
    local all_ports=()

    for service in "${all_services[@]}"; do
        all_ports+=("$(get_runtime_service_port "$service")")
    done

    # Determine which services to stop
    local services=()
    local service_ports=()

    if [ $# -eq 0 ]; then
        # No specific services provided: stop every known service port.
        # PID files can be missing when a process was orphaned or started by a
        # previous shell, so default stop must not depend on .pids alone.
        services=("${all_services[@]}")
        service_ports=("${all_ports[@]}")
    else
        # Parse specified services
        for svc in "$@"; do
            local service
            if ! service=$(normalize_service_name "$svc"); then
                echo -e "${RED}Unknown service: $svc${NC}"
                echo -e "Valid services: $(valid_service_names)"
                return 1
            fi

            if [ "$service" = "all" ]; then
                services=("${all_services[@]}")
                service_ports=("${all_ports[@]}")
                break
            else
                services+=("$service")
                service_ports+=("$(get_runtime_service_port "$service")")
            fi
        done
    fi

    if [ ${#services[@]} -eq 0 ]; then
        echo -e "${YELLOW}No services to stop${NC}"
        return 0
    fi

    if [ "$graceful" = "true" ]; then
        echo -e "${YELLOW}Gracefully stopping services: ${services[*]}${NC}"
    else
        echo -e "${YELLOW}Stopping services: ${services[*]}${NC}"
    fi

    # First: try to stop via PID files
    for service in "${services[@]}"; do
        local pid_file="$PID_DIR/${service}.pid"
        if [ -f "$pid_file" ]; then
            local pid=$(cat "$pid_file")
            if kill -0 "$pid" 2>/dev/null; then
                echo -e "  Stopping $service (PID: $pid)..."

                # For backend service in graceful mode, call shutdown API first (like K8s preStop hook)
                if [ "$graceful" = "true" ] && [ "$service" = "backend" ]; then
                    local backend_port
                    backend_port=$(get_runtime_service_port "backend")
                    echo -e "    Calling /api/shutdown/wait (K8s preStop style)..."
                    curl -s -X POST "http://localhost:${backend_port}/api/shutdown/wait" -m 30 2>/dev/null || true
                    echo ""
                fi

                if [ "$graceful" = "true" ]; then
                    # Graceful shutdown: send SIGTERM to process group, wait, then SIGKILL if needed
                    kill -TERM -- -"$pid" 2>/dev/null || true
                    kill -TERM "$pid" 2>/dev/null || true
                else
                    # Force kill: SIGKILL immediately
                    kill -9 -- -"$pid" 2>/dev/null || true
                    kill -9 "$pid" 2>/dev/null || true
                fi
            fi
        fi
    done

    # If graceful mode, wait for processes to exit and ports to be released
    # Similar to K8s terminationGracePeriodSeconds behavior
    if [ "$graceful" = "true" ]; then
        local wait_time=0
        local max_wait=60  # K8s uses 700s, but local dev uses 60s
        local all_stopped=false

        # Give processes a moment to start shutting down
        sleep 0.5

        while [ $wait_time -lt $max_wait ]; do
            all_stopped=true

            # Check if any service still has processes running OR ports occupied
            local i=0
            for service in "${services[@]}"; do
                local pid_file="$PID_DIR/${service}.pid"
                local port="${service_ports[$i]}"
                local service_stopped=true

                # Check if main process still exists
                if [ -f "$pid_file" ]; then
                    local pid=$(cat "$pid_file")
                    if kill -0 "$pid" 2>/dev/null; then
                        all_stopped=false
                        service_stopped=false
                    fi
                fi

                # Check if port is still occupied (child processes may still be using it)
                if is_port_listening "$port"; then
                    all_stopped=false
                    service_stopped=false
                fi

                # Log which service is still stopping (only on first few iterations or last)
                if [ "$service_stopped" = false ] && [ $wait_time -lt 3 ]; then
                    echo -e "    ${YELLOW}•${NC} $service still stopping..."
                fi

                i=$((i + 1))
            done

            if [ "$all_stopped" = true ]; then
                if [ $wait_time -gt 0 ]; then
                    echo ""
                fi
                echo -e "  ${GREEN}✓${NC} Services stopped gracefully (${wait_time}s)"
                break
            fi

            sleep 1
            wait_time=$((wait_time + 1))
            echo -e "  Waiting for services to stop... (${wait_time}s/${max_wait}s)"
        done

        # Force kill any remaining processes and clean up ports
        local i=0
        for service in "${services[@]}"; do
            local pid_file="$PID_DIR/${service}.pid"
            local port="${service_ports[$i]}"

            # Kill main process if still running
            if [ -f "$pid_file" ]; then
                local pid=$(cat "$pid_file")
                if kill -0 "$pid" 2>/dev/null; then
                    echo -e "  ${YELLOW}Force killing $service process after graceful timeout${NC}"
                    kill -9 -- -"$pid" 2>/dev/null || true
                    kill -9 "$pid" 2>/dev/null || true
                fi
            fi

            # Force kill any processes still occupying the port
            local pids=$(get_port_listener_pids "$port" | tr '\n' ' ')
            if [ -n "$pids" ]; then
                echo -e "  ${YELLOW}Force killing processes on port $port after graceful timeout${NC}"
                echo "$pids" | xargs kill -9 2>/dev/null || true
            fi

            i=$((i + 1))
        done
    fi

    # Clean up PID files
    for service in "${services[@]}"; do
        rm -f "$PID_DIR/${service}.pid"
        remove_runtime_service_port "$service"
    done

    # Force kill any processes still occupying our ports (safety net)
    # Skip this in graceful mode to allow services to shutdown cleanly
    if [ "$graceful" != "true" ]; then
        for port in "${service_ports[@]}"; do
            local pids=$(get_port_listener_pids "$port" | tr '\n' ' ')
            if [ -n "$pids" ]; then
                echo -e "  Force killing processes on port $port: $pids"
                echo "$pids" | xargs kill -9 2>/dev/null || true
            fi
        done
        sleep 1
    else
        # In graceful mode, wait for ports to be fully released (including TIME_WAIT cleanup)
        # This is important for restart to work properly
        local port_wait_time=0
        local max_port_wait=10
        local all_ports_free=false

        echo -e "  Waiting for ports to be released..."
        while [ $port_wait_time -lt $max_port_wait ]; do
            all_ports_free=true
            for port in "${service_ports[@]}"; do
                if is_port_listening "$port"; then
                    all_ports_free=false
                    break
                fi
            done

            if [ "$all_ports_free" = true ]; then
                break
            fi

            sleep 1
            port_wait_time=$((port_wait_time + 1))
        done

        if [ "$all_ports_free" != true ]; then
            echo -e "  ${YELLOW}Warning: Some ports still in use after graceful shutdown${NC}"
        fi
    fi

    # Verify all ports are free
    local ports_freed=1
    for port in "${service_ports[@]}"; do
        if is_port_listening "$port"; then
            ports_freed=0
            echo -e "  ${RED}✗${NC} Port $port still in use"
        fi
    done

    if [ $ports_freed -eq 1 ]; then
        echo -e "${GREEN}Services stopped: ${services[*]}${NC}"
    else
        echo -e "${YELLOW}Some ports could not be freed. You may need to kill processes manually:${NC}"
        echo -e "  ${BLUE}lsof -i :PORT${NC} or ${BLUE}ss -lntp 'sport = :PORT'${NC}"
        echo -e "  ${BLUE}kill -9 PID${NC}"
    fi
}
# Show service status
show_status() {
    echo -e "${BLUE}Wegent Service Status:${NC}"
    echo ""

    local services=("backend" "frontend" "chat_shell" "executor_manager" "knowledge_runtime" "wework")

    for service in "${services[@]}"; do
        local port
        port=$(get_runtime_service_port "$service")
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
            if is_port_listening "$port"; then
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
    local port="${4:-}"
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
        if [ -n "$port" ]; then
            write_runtime_service_port "$name" "$port"
        fi
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
    # Parse arguments: if services specified, only start those
    local all_services=("backend" "frontend" "chat_shell" "executor_manager" "knowledge_runtime" "wework")
    local specified_services=()
    local start_backend=false
    local start_frontend=false
    local start_chat_shell=false
    local start_executor_manager=false
    local start_knowledge_runtime=false
    local start_wework=false

    if [ $# -eq 0 ]; then
        # No specific services, start all
        start_backend=true
        start_frontend=true
        start_chat_shell=true
        start_executor_manager=true
        start_knowledge_runtime=true
        start_wework=true
    else
        # Parse specified services
        for svc in "$@"; do
            local service
            if ! service=$(normalize_service_name "$svc"); then
                echo -e "${RED}Unknown service: $svc${NC}"
                echo -e "Valid services: $(valid_service_names)"
                exit 1
            fi

            case "$service" in
                all)
                    start_backend=true
                    start_frontend=true
                    start_chat_shell=true
                    start_executor_manager=true
                    start_knowledge_runtime=true
                    start_wework=true
                    specified_services=("${all_services[@]}")
                    break
                    ;;
                backend)
                    start_backend=true
                    ;;
                frontend)
                    start_frontend=true
                    ;;
                chat_shell)
                    start_chat_shell=true
                    ;;
                executor_manager)
                    start_executor_manager=true
                    ;;
                knowledge_runtime)
                    start_knowledge_runtime=true
                    ;;
                wework)
                    start_wework=true
                    ;;
            esac
            specified_services+=("$service")
        done
    fi

    # Check if config file exists, if not, run init wizard first
    if [ ! -f "$CONFIG_FILE" ]; then
        echo -e "${YELLOW}╔════════════════════════════════════════════════════════╗${NC}"
        echo -e "${YELLOW}║     No configuration file found. Starting setup...     ║${NC}"
        echo -e "${YELLOW}╚════════════════════════════════════════════════════════╝${NC}"
        echo ""
        echo -e "${YELLOW}This appears to be your first time running Wegent.${NC}"
        echo -e "${YELLOW}Let's create a configuration file (.env) first.${NC}"
        echo ""

        # Run the init config wizard in embedded mode (don't exit after saving)
        if ! init_config "embedded" "${specified_services[@]}"; then
            echo -e "${RED}Configuration setup cancelled. Exiting.${NC}"
            exit 1
        fi
        echo ""
    fi

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
    echo -e "${BLUE}Checking port usage...${NC}"
    local previous_backend_port="$BACKEND_PORT"
    local previous_executor_manager_port="$EXECUTOR_MANAGER_PORT"
    local previous_knowledge_runtime_port="$KNOWLEDGE_RUNTIME_PORT"
    local port_resolution_failed=false
    RESOLVED_START_PORTS=()

    if [ "$start_backend" = true ]; then
        resolve_start_service_port "backend" "Backend" || port_resolution_failed=true
    fi
    if [ "$start_chat_shell" = true ]; then
        resolve_start_service_port "chat_shell" "Chat Shell" || port_resolution_failed=true
    fi
    if [ "$start_executor_manager" = true ]; then
        resolve_start_service_port "executor_manager" "Executor Manager" || port_resolution_failed=true
    fi
    if [ "$start_knowledge_runtime" = true ]; then
        resolve_start_service_port "knowledge_runtime" "Knowledge Runtime" || port_resolution_failed=true
    fi
    if [ "$start_frontend" = true ]; then
        resolve_start_service_port "frontend" "Frontend" || port_resolution_failed=true
    fi
    if [ "$start_wework" = true ]; then
        resolve_start_service_port "wework" "WeWork" || port_resolution_failed=true
    fi

    if [ "$port_resolution_failed" = true ]; then
        exit 1
    fi

    compute_derived_urls "$previous_backend_port" "$previous_executor_manager_port" "$previous_knowledge_runtime_port"
    echo -e "${GREEN}✓ Required ports resolved${NC}"
    echo ""

    echo -e "${GREEN}Configuration:${NC}"
    echo -e "  Backend Port:        $BACKEND_PORT"
    echo -e "  Chat Shell Port:     $CHAT_SHELL_PORT"
    echo -e "  Executor Mgr Port:   $EXECUTOR_MANAGER_PORT"
    echo -e "  Knowledge Rtm Port:  $KNOWLEDGE_RUNTIME_PORT"
    echo -e "  Frontend Port:       $WEGENT_FRONTEND_PORT"
    echo -e "  WeWork Port:         $WEWORK_PORT"
    echo -e "  Executor Image:      $EXECUTOR_IMAGE"
    echo -e "  Socket URL:          $WEGENT_SOCKET_URL"
    echo -e "  Task API Domain:     $TASK_API_DOMAIN"
    echo -e "  Executor Manager:    $EXECUTOR_MANAGER_URL"
    echo -e "  Knowledge Runtime:   $KNOWLEDGE_RUNTIME_URL"
    echo ""

    # Check if WEGENT_SOCKET_URL IP matches local IP
    check_socket_url_ip

    # Sync Python dependencies
    echo -e "${BLUE}Checking Python dependencies...${NC}"
    if [ "$start_backend" = true ]; then
        sync_python_deps "backend" "Backend"
    fi
    if [ "$start_chat_shell" = true ]; then
        sync_python_deps "chat_shell" "Chat Shell"
    fi
    if [ "$start_executor_manager" = true ]; then
        sync_python_deps "executor_manager" "Executor Manager"
    fi
    if [ "$start_knowledge_runtime" = true ]; then
        sync_python_deps "knowledge_runtime" "Knowledge Runtime"
    fi
    echo ""

    # Check Python env
    echo -e "${BLUE}Checking Python env...${NC}"
    if [ "$start_backend" = true ]; then
        check_python_env "backend" "Backend"
    fi
    if [ "$start_chat_shell" = true ]; then
        check_python_env "chat_shell" "Chat Shell"
    fi
    echo ""

    # Patch backend connection URLs to use configured MYSQL_PORT / REDIS_PORT.
    # backend/.env hardcodes default ports; this ensures the local backend process
    # connects to the correct host ports exposed by docker-compose.
    echo -e "${BLUE}Patching service connection URLs...${NC}"
    patch_backend_service_urls
    echo ""

    # Check frontend dependencies
    if [ "$start_frontend" = true ]; then
        echo -e "${BLUE}Checking frontend dependencies...${NC}"
        check_frontend_dependencies
        echo ""

        if [ "$CLEAN_FRONTEND_CACHE" = "true" ]; then
            clean_frontend_cache
            echo ""
        fi
    fi

    # Check wework dependencies
    if [ "$start_wework" = true ]; then
        if [ ! -d "$SCRIPT_DIR/wework/node_modules" ]; then
            echo -e "${YELLOW}WeWork dependencies not installed. Installing...${NC}"
            cd "$SCRIPT_DIR/wework"
            npm install --ignore-scripts
            cd "$SCRIPT_DIR"
            echo -e "${GREEN}✓ WeWork dependencies installed${NC}"
        else
            echo -e "${GREEN}✓ WeWork dependencies are up to date${NC}"
        fi
        echo ""
    fi

    echo -e "${BLUE}Starting services...${NC}"

    # Common reload exclude patterns to avoid scanning .venv and __pycache__ directories
    # This significantly reduces CPU usage during development
    local RELOAD_EXCLUDE="--reload-exclude '.venv/*' --reload-exclude '__pycache__/*' --reload-exclude '*.pyc' --reload-exclude '.git/*'"

    # 1. Start Backend
    if [ "$start_backend" = true ]; then
        # EXECUTOR_MANAGER_URL: URL for backend to call executor_manager
        # BACKEND_INTERNAL_URL: URL passed into task runtime configs such as MCP
        # server URLs. Use TASK_API_DOMAIN so Docker executor containers can
        # reach the host backend instead of receiving localhost.
        # CHAT_SHELL_URL: URL for backend to call chat_shell service
        # LOG_LEVEL: Application log level (DEBUG enables debug logging)
        # --reload-dir: Watch shared module for changes (editable dependency)
        # --reload-exclude: Exclude .venv and __pycache__ to reduce CPU usage
        start_service "backend" "backend" \
            "export EXECUTOR_MANAGER_URL=$EXECUTOR_MANAGER_URL && export CHAT_SHELL_URL=http://localhost:$CHAT_SHELL_PORT && export BACKEND_INTERNAL_URL=$TASK_API_DOMAIN && export LOG_LEVEL=DEBUG && source .venv/bin/activate && uvicorn app.main:app --reload --reload-dir . --reload-dir ../shared $RELOAD_EXCLUDE --host 0.0.0.0 --port $BACKEND_PORT --log-level debug" \
            "$BACKEND_PORT"
    fi

    # 2. Start Chat Shell
    if [ "$start_chat_shell" = true ]; then
        # EXECUTOR_MANAGER_URL: URL for chat_shell to call executor_manager (for sandbox operations)
        # --reload-dir: Watch shared module for changes (editable dependency)
        # --reload-exclude: Exclude .venv and __pycache__ to reduce CPU usage
        start_service "chat_shell" "chat_shell" \
            "export CHAT_SHELL_MODE=http && export CHAT_SHELL_STORAGE_TYPE=remote && export CHAT_SHELL_REMOTE_STORAGE_URL=http://localhost:$BACKEND_PORT/api/internal && export EXECUTOR_MANAGER_URL=$EXECUTOR_MANAGER_URL && source .venv/bin/activate && .venv/bin/python -m uvicorn chat_shell.main:app --reload --reload-dir . --reload-dir ../shared $RELOAD_EXCLUDE --host 0.0.0.0 --port $CHAT_SHELL_PORT --log-level debug" \
            "$CHAT_SHELL_PORT"
    fi

    # 3. Start Executor Manager
    if [ "$start_executor_manager" = true ]; then
        # TASK_API_DOMAIN: URL for executor_manager to call backend (uses local IP so docker containers can access)
        # DOCKER_HOST_ADDR=localhost so executor_manager can access docker containers
        # CALLBACK_HOST: URL for executor containers to call back to executor_manager (uses local IP so docker containers can access)
        # --reload-dir: Watch shared module for changes (editable dependency)
        # --reload-exclude: Exclude .venv and __pycache__ to reduce CPU usage
        local CALLBACK_HOST="http://$LOCAL_IP:$EXECUTOR_MANAGER_PORT"
        start_service "executor_manager" "executor_manager" \
            "export EXECUTOR_IMAGE=$EXECUTOR_IMAGE && export TASK_API_DOMAIN=$TASK_API_DOMAIN && export DOCKER_HOST_ADDR=localhost && export NO_PROXY=localhost,127.0.0.1 && export no_proxy=localhost,127.0.0.1 && export NETWORK=wegent-network && export CALLBACK_HOST=$CALLBACK_HOST && source .venv/bin/activate && uvicorn main:app --reload --reload-dir . --reload-dir ../shared $RELOAD_EXCLUDE --host 0.0.0.0 --port $EXECUTOR_MANAGER_PORT --log-level debug" \
            "$EXECUTOR_MANAGER_PORT"
    fi

    # 4. Start Knowledge Runtime
    if [ "$start_knowledge_runtime" = true ]; then
        # INTERNAL_SERVICE_TOKEN: Token for internal service authentication
        # BACKEND_INTERNAL_URL: URL for knowledge_runtime to call backend
        # KNOWLEDGE_RUNTIME_URL: URL for backend to call knowledge_runtime
        # --reload-dir: Watch shared and knowledge_engine modules for changes (editable dependencies)
        # --reload-exclude: Exclude .venv and __pycache__ to reduce CPU usage
        start_service "knowledge_runtime" "knowledge_runtime" \
            "export INTERNAL_SERVICE_TOKEN=\$INTERNAL_SERVICE_TOKEN && export BACKEND_INTERNAL_URL=http://localhost:$BACKEND_PORT && export KNOWLEDGE_RUNTIME_URL=$KNOWLEDGE_RUNTIME_URL && source .venv/bin/activate && uvicorn knowledge_runtime.main:app --reload --reload-dir . --reload-dir ../shared --reload-dir ../knowledge_engine $RELOAD_EXCLUDE --host 0.0.0.0 --port $KNOWLEDGE_RUNTIME_PORT --log-level debug" \
            "$KNOWLEDGE_RUNTIME_PORT"
    fi

    # 5. Start Frontend (run in background)
    if [ "$start_frontend" = true ]; then
        echo -e "  Starting ${BLUE}frontend${NC}..."
        cd "$SCRIPT_DIR/frontend"

        # Set environment variables (use same names as docker-compose)
        export RUNTIME_INTERNAL_API_URL=http://localhost:$BACKEND_PORT
        export RUNTIME_SOCKET_DIRECT_URL=$WEGENT_SOCKET_URL

        # Build the frontend startup command
        # In WSL, use full path to node to ensure we use the correct nvm-installed version
        # instead of potentially using Windows node or a different version
        local frontend_cmd="PORT=$WEGENT_FRONTEND_PORT npm run dev"

        if is_wsl; then
            # Get the full path to node from the current shell (which has nvm loaded)
            local node_path=$(command -v node)
            if [ -n "$node_path" ]; then
                # Set PATH to use the nvm node directory
                local node_dir=$(dirname "$node_path")
                frontend_cmd="PATH=$node_dir:\$PATH $frontend_cmd"
            fi
        fi

        # Start frontend in background
        nohup bash -c "$frontend_cmd" > "$PID_DIR/frontend.log" 2>&1 &
        local frontend_pid=$!
        echo $frontend_pid > "$PID_DIR/frontend.pid"

        sleep 3

        if kill -0 "$frontend_pid" 2>/dev/null; then
            write_runtime_service_port "frontend" "$WEGENT_FRONTEND_PORT"
            echo -e "    ${GREEN}✓${NC} frontend started (PID: $frontend_pid)"
        else
            echo -e "    ${RED}✗${NC} frontend failed to start, check log: $PID_DIR/frontend.log"
        fi

        cd "$SCRIPT_DIR"
    fi

    # 6. Start WeWork (run in background)
    if [ "$start_wework" = true ]; then
        echo -e "  Starting ${BLUE}wework${NC}..."
        cd "$SCRIPT_DIR/wework"

        export VITE_API_PROXY_TARGET=http://localhost:$BACKEND_PORT
        export VITE_SOCKET_PROXY_TARGET=$WEGENT_SOCKET_URL
        export VITE_SOCKET_BASE_URL=$WEGENT_SOCKET_URL

        local wework_cmd="npm run dev -- --host 0.0.0.0 --port $WEWORK_PORT"

        if is_wsl; then
            local node_path=$(command -v node)
            if [ -n "$node_path" ]; then
                local node_dir=$(dirname "$node_path")
                wework_cmd="PATH=$node_dir:\$PATH $wework_cmd"
            fi
        fi

        nohup bash -c "$wework_cmd" > "$PID_DIR/wework.log" 2>&1 &
        local wework_pid=$!
        echo $wework_pid > "$PID_DIR/wework.pid"

        sleep 3

        if kill -0 "$wework_pid" 2>/dev/null; then
            write_runtime_service_port "wework" "$WEWORK_PORT"
            echo -e "    ${GREEN}✓${NC} wework started (PID: $wework_pid)"
        else
            echo -e "    ${RED}✗${NC} wework failed to start, check log: $PID_DIR/wework.log"
        fi

        cd "$SCRIPT_DIR"
    fi

    echo ""
    echo -e "${BLUE}Performing health checks...${NC}"

    # Health check only for started services
    local failed=0
    if [ "$start_backend" = true ]; then
        check_service_health "backend" $BACKEND_PORT "/health" || failed=1
    fi
    if [ "$start_chat_shell" = true ]; then
        check_service_health "chat_shell" $CHAT_SHELL_PORT "/health" || failed=1
    fi
    if [ "$start_executor_manager" = true ]; then
        check_service_health "executor_manager" $EXECUTOR_MANAGER_PORT "/health" || failed=1
    fi
    if [ "$start_knowledge_runtime" = true ]; then
        check_service_health "knowledge_runtime" $KNOWLEDGE_RUNTIME_PORT "/internal/rag/health" || failed=1
    fi
    if [ "$start_frontend" = true ]; then
        check_service_health "frontend" $WEGENT_FRONTEND_PORT "" || failed=1
    fi
    if [ "$start_wework" = true ]; then
        check_service_health "wework" $WEWORK_PORT "" || failed=1
    fi

    echo ""
    if [ $failed -eq 1 ]; then
        echo -e "${YELLOW}════════════════════════════════════════════════════════${NC}"
        echo -e "${YELLOW}⚠️  Some services failed to start properly${NC}"
        echo ""
        echo -e "${YELLOW}Please check the log files for details:${NC}"
        echo -e "  Backend:           $PID_DIR/backend.log"
        echo -e "  Frontend:          $PID_DIR/frontend.log"
        echo -e "  Chat Shell:        $PID_DIR/chat_shell.log"
        echo -e "  Executor Manager:  $PID_DIR/executor_manager.log"
        echo -e "  Knowledge Runtime: $PID_DIR/knowledge_runtime.log"
        echo -e "  WeWork:            $PID_DIR/wework.log"
        echo -e "${YELLOW}════════════════════════════════════════════════════════${NC}"
        exit 1
    fi

    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    if [ $# -eq 0 ]; then
        echo -e "${GREEN}All services started successfully!${NC}"
    else
        echo -e "${GREEN}Services started: ${specified_services[*]}${NC}"
    fi
    echo ""

    # Only show URLs if frontend is started or if starting all
    if [ "$start_frontend" = true ]; then
        echo -e "${GREEN}🌐 Access URLs:${NC}"
        echo -e "  Local Frontend:  ${BLUE}http://localhost:$WEGENT_FRONTEND_PORT${NC}"
        echo -e "  Remote Frontend: ${BLUE}http://$(get_local_ip):$WEGENT_FRONTEND_PORT${NC}"
        echo -e "  Socket URL:      ${BLUE}$WEGENT_SOCKET_URL${NC}"
        echo ""
        echo -e "${YELLOW}📋 Share with others for remote access:${NC}"
        echo -e "  Frontend URL: ${BLUE}http://$(get_local_ip):$WEGENT_FRONTEND_PORT${NC}"
        echo -e "  Socket URL:   ${BLUE}$WEGENT_SOCKET_URL${NC}"
        echo ""
    fi
    if [ "$start_wework" = true ]; then
        echo -e "${GREEN}🌐 WeWork URL:${NC}"
        echo -e "  Local:  ${BLUE}http://localhost:$WEWORK_PORT${NC}"
        echo -e "  Remote: ${BLUE}http://$(get_local_ip):$WEWORK_PORT${NC}"
        echo ""
    fi

    echo -e "${YELLOW}Common Commands:${NC}"
    echo -e "  $0 --status    Check service status"
    echo -e "  $0 --stop      Stop all services"
    echo -e "  $0 --socket-url http://YOUR_IP:8000  # Set custom socket URL"
    echo ""
    echo -e "${YELLOW}Log Files:${NC}"
    echo -e "  Backend:           $PID_DIR/backend.log"
    echo -e "  Frontend:          $PID_DIR/frontend.log"
    echo -e "  Chat Shell:        $PID_DIR/chat_shell.log"
    echo -e "  Executor Manager:  $PID_DIR/executor_manager.log"
    echo -e "  Knowledge Runtime: $PID_DIR/knowledge_runtime.log"
    echo -e "  WeWork:            $PID_DIR/wework.log"
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
}

# Execute action
case $ACTION in
    start)
        if [ ${#START_SERVICES[@]} -eq 0 ]; then
            start_services
        else
            start_services "${START_SERVICES[@]}"
        fi
        ;;
    init)
        init_config
        ;;
    stop)
        if [ ${#STOP_SERVICES[@]} -eq 0 ]; then
            stop_services "${GRACEFUL_STOP:-false}"
        else
            stop_services "${GRACEFUL_STOP:-false}" "${STOP_SERVICES[@]}"
        fi
        ;;
    restart)
        if [ ${#STOP_SERVICES[@]} -eq 0 ]; then
            stop_services "${GRACEFUL_STOP:-false}"
            start_services
        else
            stop_services "${GRACEFUL_STOP:-false}" "${STOP_SERVICES[@]}"
            start_services "${STOP_SERVICES[@]}"
        fi
        ;;
    status)
        show_status
        ;;
esac
