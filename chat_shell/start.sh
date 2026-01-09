#!/bin/bash

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Chat Shell One-Click Startup Script (uv-based)
# Usage: ./start.sh [--port PORT] [--host HOST] [--backend-url URL] [--backend-token TOKEN]

set -e

# Trap Ctrl+C and cleanup
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down server...${NC}"
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
DEFAULT_PORT=8100
DEFAULT_HOST="0.0.0.0"
DEFAULT_BACKEND_URL="http://localhost:8000"
DEFAULT_BACKEND_TOKEN="chat-shell-token"

PORT=$DEFAULT_PORT
HOST=$DEFAULT_HOST
BACKEND_URL=$DEFAULT_BACKEND_URL
BACKEND_TOKEN=$DEFAULT_BACKEND_TOKEN

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --port)
            PORT="$2"
            shift 2
            ;;
        --host)
            HOST="$2"
            shift 2
            ;;
        --python)
            PYTHON_PATH="$2"
            shift 2
            ;;
        --backend-url)
            BACKEND_URL="$2"
            shift 2
            ;;
        --backend-token)
            BACKEND_TOKEN="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --port PORT              Chat Shell server port (default: 8100)"
            echo "  --host HOST              Chat Shell server host (default: 0.0.0.0)"
            echo "  --python PATH            Python executable path (default: auto-detect)"
            echo "  --backend-url URL        Backend internal API URL (default: http://localhost:8000/api/internal)"
            echo "  --backend-token TOKEN    Backend service token (default: chat-shell-token)"
            echo "  -h, --help               Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                                    # Use default configuration"
            echo "  $0 --port 8200                        # Use custom port"
            echo "  $0 --backend-url http://backend:8000/api/internal"
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

validate_port "$PORT" "Server port"

# Check if port is already in use
check_port() {
    local port=$1
    local name=$2

    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo -e "${YELLOW}Warning: Port $port ($name) is already in use${NC}"
        echo ""
        echo -e "${YELLOW}Options:${NC}"
        echo -e "  ${BLUE}lsof -i :$port${NC}  # Find the process"
        echo -e "  ${BLUE}kill -9 <PID>${NC}    # Stop the process"
        echo -e "  ${BLUE}./start.sh --port 8200${NC}  # Use different port"
        return 1
    fi
    return 0
}

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║       Chat Shell One-Click Startup Script             ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}Configuration:${NC}"
echo -e "  Chat Shell:  http://$HOST:$PORT"
echo -e "  Backend API: $BACKEND_URL"
echo ""

# Check port
if ! check_port "$PORT" "Chat Shell"; then
    echo ""
    echo -e "${RED}✗ Cannot start Chat Shell on port $PORT${NC}"
    exit 1
fi

REQUIRED_VERSION="3.10"

# Function to check if Python version meets requirement
# Args: python_exec, need_exit (true/false)
# Sets PYTHON_VERSION if valid
# If need_exit is true, exits with error when version is invalid
# If need_exit is false, returns 1 when version is invalid
check_python_version() {
    local python_exec="$1"
    local need_exit="${2:-false}"
    PYTHON_VERSION=$($python_exec --version 2>&1 | cut -d' ' -f2 | cut -d'.' -f1,2)
    
    if [ "$(printf '%s\n' "$REQUIRED_VERSION" "$PYTHON_VERSION" | sort -V | head -n1)" != "$REQUIRED_VERSION" ]; then
        if [ "$need_exit" = "true" ]; then
            echo -e "${RED}Error: Python $REQUIRED_VERSION or higher is required (found $PYTHON_VERSION)${NC}"
            exit 1
        fi
        return 1
    fi
    return 0
}

# Determine which Python to use
if [ -n "$PYTHON_PATH" ]; then
    # User specified a Python path - use it directly without fallback
    if [ ! -f "$PYTHON_PATH" ]; then
        echo -e "${RED}Error: Python executable not found at $PYTHON_PATH${NC}"
        exit 1
    fi
    if [ ! -x "$PYTHON_PATH" ]; then
        echo -e "${RED}Error: $PYTHON_PATH is not executable${NC}"
        exit 1
    fi
    PYTHON_EXEC="$PYTHON_PATH"
    echo -e "${GREEN}✓ Using specified Python: $PYTHON_EXEC${NC}"
    check_python_version "$PYTHON_EXEC" true
else
    # Auto-detect Python with fallback logic
    PYTHON_EXEC=""

    if ! command -v python3 &> /dev/null && ! command -v python &> /dev/null; then
        echo -e "${RED}Error: python3 or python is not installed${NC}"
        echo "Please install Python 3.10 or higher, or specify Python path with --python"
        exit 1
    fi
    
    # First try 'python'
    if command -v python &> /dev/null; then
        PYTHON_CANDIDATE=$(which python)
        if check_python_version "$PYTHON_CANDIDATE" false; then
            PYTHON_EXEC="$PYTHON_CANDIDATE"
            echo -e "${GREEN}✓ Using system Python: $PYTHON_EXEC${NC}"
        fi
    fi
    
    # If 'python' doesn't meet requirement, try 'python3'
    if [ -z "$PYTHON_EXEC" ]; then
        if command -v python3 &> /dev/null; then
            PYTHON_CANDIDATE=$(which python3)
            if check_python_version "$PYTHON_CANDIDATE" true; then
                PYTHON_EXEC="$PYTHON_CANDIDATE"
                echo -e "${GREEN}✓ Using system Python3: $PYTHON_EXEC${NC}"
            fi
        fi
    fi
    
    # If neither works, exit with error
    if [ -z "$PYTHON_EXEC" ]; then
        echo -e "${RED}Error: No suitable Python found. Python $REQUIRED_VERSION or higher is required.${NC}"
        echo "Please install Python 3.10 or higher, or specify Python path with --python"
        exit 1
    fi
fi

echo -e "${GREEN}✓ Python $PYTHON_VERSION detected${NC}"
echo ""

# Step 2: Check uv installation
echo -e "${BLUE}[2/4] Checking uv installation...${NC}"
if ! command -v uv &> /dev/null; then
    echo -e "${YELLOW}Warning: uv is not installed${NC}"
    echo -e "${YELLOW}Installing uv...${NC}"
    curl -LsSf https://astral.sh/uv/install.sh | sh

    if [ -f "$HOME/.cargo/env" ]; then
        source "$HOME/.cargo/env"
    fi

    if ! command -v uv &> /dev/null; then
        echo -e "${RED}Error: Failed to install uv${NC}"
        exit 1
    fi
fi

UV_VERSION=$(uv --version | cut -d' ' -f2)
echo -e "${GREEN}✓ uv $UV_VERSION detected${NC}"
echo ""

# Step 3: Install dependencies
echo -e "${BLUE}[3/4] Installing dependencies with uv...${NC}"
if [ ! -f "pyproject.toml" ]; then
    echo -e "${RED}Error: pyproject.toml not found${NC}"
    exit 1
fi

# Create virtual environment if needed
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    uv venv
fi

# Sync dependencies
uv sync
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to install dependencies${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Dependencies installed${NC}"
echo ""

# Step 4: Start the server
echo -e "${BLUE}[4/4] Starting Chat Shell server...${NC}"

# Set environment variables
export CHAT_SHELL_MODE="http"
export CHAT_SHELL_STORAGE_TYPE="remote"
export CHAT_SHELL_REMOTE_STORAGE_URL="$BACKEND_URL/api/internal"
export CHAT_SHELL_REMOTE_STORAGE_TOKEN="$BACKEND_TOKEN"

# Pass web search configuration if set
if [ -n "$WEB_SEARCH_ENABLED" ]; then
    export CHAT_SHELL_WEB_SEARCH_ENABLED="$WEB_SEARCH_ENABLED"
fi
if [ -n "$WEB_SEARCH_ENGINES" ]; then
    export CHAT_SHELL_WEB_SEARCH_ENGINES="$WEB_SEARCH_ENGINES"
fi

echo -e "${GREEN}Environment:${NC}"
echo -e "  CHAT_SHELL_MODE=$CHAT_SHELL_MODE"
echo -e "  CHAT_SHELL_STORAGE_TYPE=$CHAT_SHELL_STORAGE_TYPE"
echo -e "  CHAT_SHELL_REMOTE_STORAGE_URL=$CHAT_SHELL_REMOTE_STORAGE_URL"
if [ -n "$WEB_SEARCH_ENABLED" ]; then
    echo -e "  CHAT_SHELL_WEB_SEARCH_ENABLED=$CHAT_SHELL_WEB_SEARCH_ENABLED"
fi
echo ""

echo -e "${GREEN}Server will start on http://$HOST:$PORT${NC}"
echo -e "${GREEN}API documentation: http://localhost:$PORT/docs${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop the server${NC}"
echo ""

# Start uvicorn
.venv/bin/python -m uvicorn chat_shell.main:app --host "$HOST" --port "$PORT" --reload
