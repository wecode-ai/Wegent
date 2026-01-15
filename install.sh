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
INSTALL_DIR="${WEGENT_INSTALL_DIR:-$HOME/wegent}"

echo -e "${YELLOW}Installing Wegent to ${INSTALL_DIR}...${NC}"

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

echo -e "${YELLOW}Downloading docker-compose.yml...${NC}"
curl -fsSL "$COMPOSE_URL" -o docker-compose.yml

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
echo -e "  Useful commands:"
echo -e "    ${YELLOW}cd ${INSTALL_DIR} && $COMPOSE_CMD logs -f${NC}    # View logs"
echo -e "    ${YELLOW}cd ${INSTALL_DIR} && $COMPOSE_CMD down${NC}       # Stop services"
echo -e "    ${YELLOW}cd ${INSTALL_DIR} && $COMPOSE_CMD up -d${NC}      # Start services"
echo ""
