#!/usr/bin/env bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
cat << 'EOF'
 __        __                    _
 \ \      / /__  __ _  ___ _ __ | |_
  \ \ /\ / / _ \/ _` |/ _ \ '_ \| __|
   \ V  V /  __/ (_| |  __/ | | | |_
    \_/\_/ \___|\__, |\___|_| |_|\__|
                |___/
EOF
echo -e "${NC}"
echo -e "${GREEN}Wegent Installer${NC}"
echo ""

# Check for required commands
check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${RED}Error: $1 is not installed.${NC}"
        echo "Please install $1 and try again."
        exit 1
    fi
}

echo -e "${YELLOW}Checking requirements...${NC}"
check_command "docker"
check_command "curl"

# Check if docker compose is available
if docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
else
    echo -e "${RED}Error: docker compose is not available.${NC}"
    echo "Please install Docker Compose and try again."
    exit 1
fi

# Check if docker daemon is running
if ! docker info &> /dev/null; then
    echo -e "${RED}Error: Docker daemon is not running.${NC}"
    echo "Please start Docker and try again."
    echo ""
    echo "  - On macOS/Windows: Start Docker Desktop"
    echo "  - On Linux: sudo systemctl start docker"
    exit 1
fi

echo -e "${GREEN}All requirements satisfied.${NC}"
echo ""

# Download docker-compose.yml
COMPOSE_URL="https://raw.githubusercontent.com/wecode-ai/Wegent/main/docker-compose.yml"
INSTALL_DIR="${WEGENT_INSTALL_DIR:-.}"

echo -e "${YELLOW}Installing Wegent to ${INSTALL_DIR}...${NC}"

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Detect if this is a source clone scenario
# Check if WEGENT_SOURCE_BUILD is explicitly set, otherwise check git remote
IS_SOURCE_BUILD="${WEGENT_SOURCE_BUILD:-}"

if [ -z "$IS_SOURCE_BUILD" ]; then
    # Check if we are in a git repository AND have the build configuration file
    # This prevents false positives (e.g., running in ~) and supports forks/renamed repos
    if git rev-parse --git-dir > /dev/null 2>&1 && [ -f "docker-compose.build.yml" ]; then
        IS_SOURCE_BUILD=1
    else
        IS_SOURCE_BUILD=0
    fi
fi

if [ "$IS_SOURCE_BUILD" = "1" ]; then
    echo -e "${GREEN}Detected Wegent source code (git clone).${NC}"
    echo -e "${YELLOW}Will build images from source code.${NC}"
fi

# Download docker-compose.yml (only if not in source mode)
if [ "$IS_SOURCE_BUILD" = "1" ]; then
    if [ -f "docker-compose.yml" ]; then
        echo -e "${GREEN}Found existing docker-compose.yml, skipping download.${NC}"
    else
        echo -e "${RED}Error: docker-compose.yml not found in source directory.${NC}"
        echo "Please ensure you have the latest source code from the repository."
        exit 1
    fi
else
    echo -e "${YELLOW}Downloading docker-compose.yml...${NC}"
    curl -fsSL "$COMPOSE_URL" -o docker-compose.yml
fi

# Check docker-compose.build.yml exists for source build
if [ "$IS_SOURCE_BUILD" = "1" ]; then
    if [ ! -f "docker-compose.build.yml" ]; then
        echo -e "${RED}Error: docker-compose.build.yml not found in source directory.${NC}"
        echo "Please ensure you have the latest source code from the repository."
        exit 1
    fi
fi

# Detect server IP for WebSocket configuration
# Cross-platform compatible (macOS and Linux)
detect_server_ip() {
    local ip=""
    
    # Detect OS type
    local os_type
    os_type=$(uname -s)
    
    if [ "$os_type" = "Darwin" ]; then
        # macOS: use ipconfig or ifconfig
        # Try to get IP from en0 (usually the primary interface on Mac)
        for iface in en0 en1 en2 en3; do
            ip=$(ipconfig getifaddr "$iface" 2>/dev/null)
            if [ -n "$ip" ] && [ "$ip" != "127.0.0.1" ]; then
                echo "$ip"
                return
            fi
        done
        # Fallback: use ifconfig to find first non-loopback IPv4
        ip=$(ifconfig 2>/dev/null | awk '/inet / && !/127.0.0.1/ {print $2; exit}')
        if [ -n "$ip" ]; then
            echo "$ip"
            return
        fi
    else
        # Linux: use ip command or hostname -I
        # Try to get IP from common physical interfaces first
        for iface in eth0 ens33 ens160 enp0s3 enp0s8 ens192 em1; do
            ip=$(ip -4 addr show "$iface" 2>/dev/null | awk '/inet / {split($2, a, "/"); print a[1]}' | head -1)
            if [ -n "$ip" ]; then
                echo "$ip"
                return
            fi
        done
        # Fallback: get first non-docker, non-loopback IP using hostname -I
        ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^172\.\(1[6-9]\|2[0-9]\|3[0-1]\)\.' | grep -v '^127\.' | head -1)
        if [ -n "$ip" ]; then
            echo "$ip"
            return
        fi
        # Last resort: use ip route
        ip=$(ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
        if [ -n "$ip" ]; then
            echo "$ip"
            return
        fi
    fi
    
    echo ""
}

# Configure WebSocket URL
SERVER_IP=$(detect_server_ip)
SOCKET_URL="http://localhost:8000"

# Skip if .env already exists
if [ -f ".env" ]; then
    echo -e "${GREEN}Found existing .env file, skipping configuration.${NC}"
    echo ""
elif [ -n "$SERVER_IP" ] && [ "$SERVER_IP" != "127.0.0.1" ]; then
    echo ""
    echo -e "${YELLOW}Detected server IP: ${GREEN}${SERVER_IP}${NC}"
    echo -e "Use this IP for WebSocket connection (for remote access)?"
    echo -e "  ${GREEN}[Y]${NC} Yes, use ${SERVER_IP}"
    echo -e "  ${YELLOW}[n]${NC} No, use localhost (local development)"
    echo -e "  ${BLUE}[c]${NC} Custom IP or domain"
    read -r -p "Choose [Y/n/c]: " choice

    case "$choice" in
        n|N)
            SOCKET_URL="http://localhost:8000"
            ;;
        c|C)
            read -r -p "Enter custom address (e.g., example.com): " custom_host
            SOCKET_URL="http://${custom_host}:8000"
            ;;
        *)
            SOCKET_URL="http://${SERVER_IP}:8000"
            ;;
    esac

    # Generate .env file
    echo "# Wegent Configuration" > .env
    echo "# Generated by install.sh" >> .env
    echo "" >> .env
    echo "# WebSocket URL for frontend to connect to backend" >> .env
    echo "WEGENT_SOCKET_URL=${SOCKET_URL}" >> .env
    echo -e "${GREEN}Configuration saved to .env${NC}"
    echo ""
else
    # Local development, generate default .env
    echo "# Wegent Configuration" > .env
    echo "# Generated by install.sh" >> .env
    echo "" >> .env
    echo "# WebSocket URL for frontend to connect to backend" >> .env
    echo "WEGENT_SOCKET_URL=${SOCKET_URL}" >> .env
    echo -e "${GREEN}Configuration saved to .env${NC}"
    echo ""
fi

# Set compose command with build file if source build
if [ "$IS_SOURCE_BUILD" = "1" ]; then
    COMPOSE_CMD="$COMPOSE_CMD -f docker-compose.yml -f docker-compose.build.yml"
fi

echo -e "${YELLOW}Starting Wegent services...${NC}"
$COMPOSE_CMD up -d

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Wegent installed successfully!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "  Open ${BLUE}http://localhost:3000${NC} in your browser"
echo ""
echo -e "  Installation directory: ${YELLOW}${INSTALL_DIR}${NC}"
echo ""
if [ "$IS_SOURCE_BUILD" = "1" ]; then
    echo -e "  ${BLUE}Source build mode${NC} - images built from local source code"
    echo ""
    echo -e "  Useful commands:"
    echo -e "    ${YELLOW}cd ${INSTALL_DIR} && $COMPOSE_CMD logs -f${NC}    # View logs"
    echo -e "    ${YELLOW}cd ${INSTALL_DIR} && $COMPOSE_CMD down${NC}       # Stop services"
    echo -e "    ${YELLOW}cd ${INSTALL_DIR} && $COMPOSE_CMD up -d${NC}      # Start services"
    echo -e "    ${YELLOW}cd ${INSTALL_DIR} && $COMPOSE_CMD build --no-cache${NC}  # Rebuild images"
else
    echo -e "  Useful commands:"
    echo -e "    ${YELLOW}cd ${INSTALL_DIR} && $COMPOSE_CMD logs -f${NC}    # View logs"
    echo -e "    ${YELLOW}cd ${INSTALL_DIR} && $COMPOSE_CMD down${NC}       # Stop services"
    echo -e "    ${YELLOW}cd ${INSTALL_DIR} && $COMPOSE_CMD up -d${NC}      # Start services"
fi
echo ""
