#!/bin/bash

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Frontend One-Click Startup Script
# Usage: ./start.sh [--port PORT] [--api-url API_URL]

set -e

# Trap Ctrl+C and cleanup
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down server...${NC}"
    # Kill all child processes
    jobs -p | xargs -r kill 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default configuration
DEFAULT_PORT=3000
DEFAULT_API_URL="http://localhost:8000"

PORT=$DEFAULT_PORT
API_URL=$DEFAULT_API_URL

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --port)
            PORT="$2"
            shift 2
            ;;
        --api-url)
            API_URL="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --port PORT          Frontend server port (default: 3000)"
            echo "  --api-url URL        Backend API URL (default: http://localhost:8000)"
            echo "  -h, --help           Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                                    # Use default configuration"
            echo "  $0 --port 3001                        # Use custom frontend port"
            echo "  $0 --api-url http://backend:8000      # Use custom backend URL"
            echo "  $0 --port 3001 --api-url http://localhost:9000  # Custom port and API"
            exit 0
            ;;
        *)
            echo -e "${RED}Error: Unknown option $1${NC}"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Validate port number
validate_port() {
    local port=$1
    local name=$2
    
    if ! [[ "$port" =~ ^[0-9]+$ ]]; then
        echo -e "${RED}Error: $name must be a number${NC}"
        exit 1
    fi
    
    if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
        echo -e "${RED}Error: $name must be between 1 and 65535${NC}"
        exit 1
    fi
}

validate_port "$PORT" "Frontend port"

# Check if port is already in use
check_port() {
    local port=$1
    local name=$2
    
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo -e "${YELLOW}Warning: Port $port ($name) is already in use${NC}"
        echo ""
        
        # Check for suspended jobs
        local suspended_jobs=$(jobs -l | grep -i "suspended" | grep "start.sh" || true)
        if [ -n "$suspended_jobs" ]; then
            echo -e "${RED}Detected suspended start.sh process!${NC}"
            echo -e "${YELLOW}To properly stop it:${NC}"
            echo -e "   ${BLUE}fg${NC}              # Bring to foreground"
            echo -e "   ${BLUE}Ctrl+C${NC}          # Then press Ctrl+C to stop"
            echo ""
            echo -e "${YELLOW}Or kill all suspended jobs:${NC}"
            echo -e "   ${BLUE}jobs -p | xargs kill -9${NC}"
            echo ""
        fi
        
        echo -e "${YELLOW}You have two options:${NC}"
        echo -e "${YELLOW}1. Stop the service using this port:${NC}"
        echo -e "   ${BLUE}lsof -i :$port${NC}  # Find the process"
        echo -e "   ${BLUE}kill -9 <PID>${NC}    # Stop the process"
        echo ""
        echo -e "${YELLOW}2. Use a different port (recommended):${NC}"
        echo -e "   ${BLUE}./start.sh --port 3001${NC}"
        echo -e "   ${BLUE}./start.sh --port 3002${NC}"
        echo ""
        echo -e "${YELLOW}For more options, run:${NC} ${BLUE}./start.sh --help${NC}"
        return 1
    fi
    return 0
}

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Wegent Frontend One-Click Startup Script         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}Configuration:${NC}"
echo -e "  Frontend:    http://localhost:$PORT"
echo -e "  Backend API: $API_URL"
echo ""
echo -e "${BLUE}Tip: Use ${NC}${YELLOW}./start.sh --help${NC}${BLUE} to see all available options${NC}"
echo ""

# Check frontend port
if ! check_port "$PORT" "Frontend"; then
    echo ""
    echo -e "${RED}✗ Cannot start frontend on port $PORT${NC}"
    exit 1
fi

# Step 1: Check Node.js version
echo -e "${BLUE}[1/4] Checking Node.js version...${NC}"
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    echo "Please install Node.js 18 or higher"
    exit 1
fi

NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
REQUIRED_VERSION="18"

if [ "$NODE_VERSION" -lt "$REQUIRED_VERSION" ]; then
    echo -e "${RED}Error: Node.js $REQUIRED_VERSION or higher is required (found v$NODE_VERSION)${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Node.js v$(node --version | cut -d'v' -f2) detected${NC}"
echo ""

# Step 2: Install dependencies
echo -e "${BLUE}[2/4] Installing dependencies...${NC}"
if [ ! -f "package.json" ]; then
    echo -e "${RED}Error: package.json not found${NC}"
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies with npm..."
    npm install
    if [ $? -ne 0 ]; then
        echo -e "${RED}Error: Failed to install dependencies${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Dependencies installed${NC}"
else
    echo -e "${GREEN}✓ Dependencies already installed${NC}"
fi
echo ""

# Step 3: Configure environment variables
echo -e "${BLUE}[3/4] Configuring environment variables...${NC}"

# Check if .env.local exists, create template if not
if [ ! -f ".env.local" ]; then
    echo -e "${YELLOW}Creating .env.local template file...${NC}"
    cat > .env.local << EOF
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Frontend Environment Variables

# Runtime API Configuration (can be changed without rebuilding)
# RUNTIME_INTERNAL_API_URL is set via environment variable by this script
# RUNTIME_SOCKET_DIRECT_URL is set via environment variable by this script

# Legacy: NEXT_PUBLIC_API_URL is deprecated, use RUNTIME_INTERNAL_API_URL instead
NEXT_PUBLIC_USE_MOCK_API=false

# Authentication Configuration
NEXT_PUBLIC_LOGIN_MODE=all

# I18N Configuration
I18N_LNG=en

# Deploy Mode Configuration
NEXT_PUBLIC_FRONTEND_ENABLE_DISPLAY_QUOTAS=enable
EOF
    echo -e "${GREEN}✓ Created .env.local template${NC}"
fi

# Export runtime environment variables (will be read by Next.js at startup)
export RUNTIME_INTERNAL_API_URL=$API_URL
export RUNTIME_SOCKET_DIRECT_URL=$API_URL
echo -e "${GREEN}✓ Using API URL: $API_URL (via RUNTIME_INTERNAL_API_URL)${NC}"
echo -e "${YELLOW}Note: Using runtime environment variables (no rebuild required)${NC}"
echo ""

# Step 4: Start the development server
echo -e "${BLUE}[4/4] Starting frontend development server...${NC}"
echo -e "${GREEN}Server will start on http://localhost:$PORT${NC}"
echo -e "${GREEN}Backend API: $API_URL${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop the server${NC}"
echo ""

# Start Next.js development server
PORT=$PORT npm run dev
