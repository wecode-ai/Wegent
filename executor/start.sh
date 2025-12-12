#!/bin/bash

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Executor One-Click Startup Script (uv-based)
# Usage: ./start.sh [--port PORT] [--host HOST] [--python PYTHON_PATH] [--workspace-root PATH] [--callback-url URL]

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
DEFAULT_PORT=10001
DEFAULT_HOST="0.0.0.0"
DEFAULT_WORKSPACE_ROOT="$HOME/wegent/workspace/"
DEFAULT_CALLBACK_URL="http://127.0.0.1:8001/executor-manager/callback"
PYTHON_PATH=""

PORT=$DEFAULT_PORT
HOST=$DEFAULT_HOST
WORKSPACE_ROOT=$DEFAULT_WORKSPACE_ROOT
CALLBACK_URL=$DEFAULT_CALLBACK_URL

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
        --workspace-root)
            WORKSPACE_ROOT="$2"
            shift 2
            ;;
        --callback-url)
            CALLBACK_URL="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --port PORT              Executor server port (default: 10001)"
            echo "  --host HOST              Executor server host (default: 0.0.0.0)"
            echo "  --python PATH            Python executable path (default: auto-detect)"
            echo "  --workspace-root PATH    Workspace root directory (default: ~/wegent/workspace/)"
            echo "  --callback-url URL       Callback URL for executor manager (default: http://127.0.0.1:8001/executor-manager/callback)"
            echo "  -h, --help               Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                                      # Use default configuration"
            echo "  $0 --port 10002                         # Use custom port"
            echo "  $0 --python /usr/local/bin/python3.12   # Use specific Python"
            echo "  $0 --workspace-root /data/workspace     # Use custom workspace root"
            echo "  $0 --callback-url http://localhost:8001/executor-manager/callback  # Use custom callback URL"
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

validate_port "$PORT" "Executor port"

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
        echo -e "   ${BLUE}./start.sh --port 10002${NC}"
        echo -e "   ${BLUE}./start.sh --port 10003${NC}"
        echo ""
        echo -e "${YELLOW}For more options, run:${NC} ${BLUE}./start.sh --help${NC}"
        return 1
    fi
    return 0
}

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║       Wegent Executor One-Click Startup Script       ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}Configuration:${NC}"
echo -e "  Executor: http://$HOST:$PORT"
echo -e "  Workspace Root: $WORKSPACE_ROOT"
echo -e "  Callback URL: $CALLBACK_URL"
echo ""
echo -e "${BLUE}Tip: Use ${NC}${YELLOW}./start.sh --help${NC}${BLUE} to see all available options${NC}"
echo ""

# Check executor port
if ! check_port "$PORT" "Executor"; then
    echo ""
    echo -e "${RED}✗ Cannot start executor on port $PORT${NC}"
    exit 1
fi

# Step 1: Check Python version
echo -e "${BLUE}[1/5] Checking Python version...${NC}"

# Determine which Python to use
if [ -n "$PYTHON_PATH" ]; then
    # User specified a Python path
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
else
    # Auto-detect Python
    if ! command -v python3 &> /dev/null; then
        echo -e "${RED}Error: python3 is not installed${NC}"
        echo "Please install Python 3.10 or higher, or specify Python path with --python"
        exit 1
    fi
    PYTHON_EXEC=$(which python3)
    echo -e "${GREEN}✓ Using system Python: $PYTHON_EXEC${NC}"
fi

# Check Python version
PYTHON_VERSION=$($PYTHON_EXEC --version 2>&1 | cut -d' ' -f2 | cut -d'.' -f1,2)
REQUIRED_VERSION="3.10"

if [ "$(printf '%s\n' "$REQUIRED_VERSION" "$PYTHON_VERSION" | sort -V | head -n1)" != "$REQUIRED_VERSION" ]; then
    echo -e "${RED}Error: Python $REQUIRED_VERSION or higher is required (found $PYTHON_VERSION)${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Python $PYTHON_VERSION detected${NC}"
echo ""

# Step 2: Check uv installation
echo -e "${BLUE}[2/5] Checking uv installation...${NC}"
if ! command -v uv &> /dev/null; then
    echo -e "${YELLOW}Warning: uv is not installed${NC}"
    echo -e "${YELLOW}Installing uv...${NC}"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    
    # Source the shell configuration to make uv available
    if [ -f "$HOME/.cargo/env" ]; then
        source "$HOME/.cargo/env"
    fi
    
    if ! command -v uv &> /dev/null; then
        echo -e "${RED}Error: Failed to install uv${NC}"
        echo "Please install uv manually: https://github.com/astral-sh/uv"
        exit 1
    fi
fi

UV_VERSION=$(uv --version | cut -d' ' -f2)
echo -e "${GREEN}✓ uv $UV_VERSION detected${NC}"
echo ""

# Step 3: Install dependencies
echo -e "${BLUE}[3/5] Installing dependencies with uv...${NC}"
if [ ! -f "pyproject.toml" ]; then
    echo -e "${RED}Error: pyproject.toml not found${NC}"
    exit 1
fi

# Force clear any virtual environment variables
unset VIRTUAL_ENV
unset PYTHONHOME
export PATH=$(echo $PATH | tr ':' '\n' | grep -v '/venv/bin' | grep -v '/.venv/bin' | tr '\n' ':' | sed 's/:$//')

# Remove old venv if exists
if [ -d "venv" ]; then
    echo -e "${YELLOW}Removing old venv directory...${NC}"
    rm -rf venv
fi

# PYTHON_EXEC is already set in Step 1, use it directly
# If not specified by user, try to get the real Python path (not pyenv shim)
if [ -z "$PYTHON_PATH" ] && command -v pyenv &> /dev/null; then
    PYTHON_EXEC=$(pyenv which python3 2>/dev/null || echo "$PYTHON_EXEC")
fi

# Use uv sync to create virtual environment and install dependencies
echo "Syncing dependencies with uv using Python: $PYTHON_EXEC"
uv sync --python "$PYTHON_EXEC"
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to sync dependencies${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Virtual environment created and dependencies installed${NC}"
echo ""

# Step 4: Set PYTHONPATH
echo -e "${BLUE}[4/5] Setting up environment...${NC}"
PROJECT_ROOT=$(cd .. && pwd)
export PYTHONPATH="${PYTHONPATH}:${PROJECT_ROOT}"
echo -e "${GREEN}✓ PYTHONPATH set to include: $PROJECT_ROOT${NC}"

# Activate uv's virtual environment
if [ -d ".venv" ]; then
    source .venv/bin/activate
    echo -e "${GREEN}✓ Virtual environment activated${NC}"
elif [ -d "venv" ]; then
    source venv/bin/activate
    echo -e "${GREEN}✓ Virtual environment activated${NC}"
else
    echo -e "${RED}Error: No virtual environment found${NC}"
    exit 1
fi
echo ""

# Step 5: Start the server
echo -e "${BLUE}[5/5] Starting executor server...${NC}"
echo -e "${GREEN}Server will start on http://$HOST:$PORT${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop the server${NC}"
echo ""

# Export environment variables for the application
export PORT="$PORT"
export WORKSPACE_ROOT="$WORKSPACE_ROOT"
export CALLBACK_URL="$CALLBACK_URL"

# Create workspace directory if it doesn't exist
if [ ! -d "$WORKSPACE_ROOT" ]; then
    echo -e "${YELLOW}Creating workspace directory: $WORKSPACE_ROOT${NC}"
    mkdir -p "$WORKSPACE_ROOT"
fi

# Start with uvicorn
uvicorn main:app --reload --host "$HOST" --port "$PORT"