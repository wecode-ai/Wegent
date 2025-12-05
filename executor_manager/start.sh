#!/bin/bash

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Executor Manager One-Click Startup Script
# Usage: ./start.sh [--port PORT] [--host HOST] [--executor-image IMAGE] [--python PYTHON_PATH]

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
DEFAULT_PORT=8001
DEFAULT_HOST="0.0.0.0"
DEFAULT_EXECUTOR_IMAGE="ghcr.io/wecode-ai/wegent-executor:1.0.16"
DEFAULT_TASK_API_DOMAIN="http://localhost:8000"
PYTHON_PATH=""

PORT=$DEFAULT_PORT
HOST=$DEFAULT_HOST
EXECUTOR_IMAGE=$DEFAULT_EXECUTOR_IMAGE
TASK_API_DOMAIN=$DEFAULT_TASK_API_DOMAIN

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
        --executor-image)
            EXECUTOR_IMAGE="$2"
            shift 2
            ;;
        --task-api-domain)
            TASK_API_DOMAIN="$2"
            shift 2
            ;;
        --python)
            PYTHON_PATH="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --port PORT              Executor Manager port (default: 8001)"
            echo "  --host HOST              Executor Manager host (default: 0.0.0.0)"
            echo "  --executor-image IMAGE   Executor Docker image (default: ghcr.io/wecode-ai/wegent-executor:1.0.16)"
            echo "  --task-api-domain URL    Backend API domain (default: http://localhost:8000)"
            echo "  --python PATH            Python executable path (default: auto-detect)"
            echo "  -h, --help               Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                                    # Use default configuration"
            echo "  $0 --port 8002                        # Use custom port"
            echo "  $0 --executor-image custom:latest     # Use custom executor image"
            echo "  $0 --task-api-domain http://backend:8000  # Use custom backend URL"
            echo "  $0 --python /usr/local/bin/python3.12 # Use specific Python"
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

validate_port "$PORT" "Executor Manager port"

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
        echo -e "   ${BLUE}./start.sh --port 8002${NC}"
        echo -e "   ${BLUE}./start.sh --port 9001${NC}"
        echo ""
        echo -e "${YELLOW}For more options, run:${NC} ${BLUE}./start.sh --help${NC}"
        return 1
    fi
    return 0
}

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Wegent Executor Manager One-Click Startup Script   ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}Configuration:${NC}"
echo -e "  Executor Manager: http://$HOST:$PORT"
echo -e "  Backend API:      $TASK_API_DOMAIN"
echo -e "  Executor Image:   $EXECUTOR_IMAGE"
echo ""
echo -e "${BLUE}Tip: Use ${NC}${YELLOW}./start.sh --help${NC}${BLUE} to see all available options${NC}"
echo ""

# Check port
if ! check_port "$PORT" "Executor Manager"; then
    echo ""
    echo -e "${RED}✗ Cannot start Executor Manager on port $PORT${NC}"
    exit 1
fi

# Step 1: Check Python version
echo -e "${BLUE}[1/7] Checking Python version...${NC}"

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
echo -e "${BLUE}[2/7] Checking uv installation...${NC}"
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
echo -e "${BLUE}[3/7] Installing dependencies with uv...${NC}"
if [ ! -f "pyproject.toml" ]; then
    echo -e "${RED}Error: pyproject.toml not found${NC}"
    exit 1
fi

# Create virtual environment with uv if it doesn't exist
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment with uv using: $PYTHON_EXEC"
    uv venv --python "$PYTHON_EXEC"
    if [ $? -ne 0 ]; then
        echo -e "${RED}Error: Failed to create virtual environment${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Virtual environment created with Python: $PYTHON_EXEC${NC}"
fi

# Use uv sync to create virtual environment and install dependencies
echo "Syncing dependencies with uv using Python: $PYTHON_EXEC"
uv sync --python "$PYTHON_EXEC"
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to install dependencies${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Dependencies installed${NC}"
echo ""

# Step 4: Check Docker
echo -e "${BLUE}[4/7] Checking Docker...${NC}"
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed${NC}"
    echo "Executor Manager requires Docker to run executors"
    echo "Please install Docker: https://docs.docker.com/get-docker/"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo -e "${RED}Error: Docker daemon is not running${NC}"
    echo "Please start Docker and try again"
    exit 1
fi

DOCKER_VERSION=$(docker --version | cut -d' ' -f3 | tr -d ',')
echo -e "${GREEN}✓ Docker $DOCKER_VERSION detected and running${NC}"
echo ""

# Step 5: Check Docker network
echo -e "${BLUE}[5/7] Checking Docker network...${NC}"
NETWORK_NAME="wegent-network"
if ! docker network inspect $NETWORK_NAME &> /dev/null; then
    echo -e "${YELLOW}Warning: Docker network '$NETWORK_NAME' does not exist${NC}"
    echo -e "${YELLOW}Creating network...${NC}"
    docker network create $NETWORK_NAME
    echo -e "${GREEN}✓ Network created${NC}"
else
    echo -e "${GREEN}✓ Network '$NETWORK_NAME' exists${NC}"
fi
echo ""

# Step 6: Set PYTHONPATH
echo -e "${BLUE}[6/7] Setting up environment...${NC}"
PROJECT_ROOT=$(cd .. && pwd)
export PYTHONPATH="${PYTHONPATH}:${PROJECT_ROOT}"
echo -e "${GREEN}✓ PYTHONPATH set to include: $PROJECT_ROOT${NC}"

# Get Docker host IP
# Different methods for different OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    DOCKER_HOST_ADDR=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "host.docker.internal")
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    DOCKER_HOST_ADDR=$(hostname -I | awk '{print $1}')
else
    # Windows or other
    DOCKER_HOST_ADDR="host.docker.internal"
fi

if [ -z "$DOCKER_HOST_ADDR" ] || [ "$DOCKER_HOST_ADDR" == "host.docker.internal" ]; then
    DOCKER_HOST_ADDR="host.docker.internal"
    echo -e "${YELLOW}Note: Using Docker host address: $DOCKER_HOST_ADDR${NC}"
else
    echo -e "${GREEN}✓ Docker host address: $DOCKER_HOST_ADDR${NC}"
fi
echo ""

# Step 7: Start the server
echo -e "${BLUE}[7/7] Starting Executor Manager...${NC}"
echo -e "${GREEN}Server will start on http://$HOST:$PORT${NC}"
echo -e "${GREEN}API documentation: http://localhost:$PORT/docs${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop the server${NC}"
echo ""

# Export environment variables
export EXECUTOR_IMAGE="$EXECUTOR_IMAGE"
export DOCKER_HOST_ADDR="$DOCKER_HOST_ADDR"
export TASK_API_DOMAIN="$TASK_API_DOMAIN"
export PORT="$PORT"
export NETWORK="$NETWORK_NAME"

# Start with uvicorn directly (using uv's virtual environment)
source .venv/bin/activate 2>/dev/null || true
uvicorn main:app --host "$HOST" --port "$PORT" --reload