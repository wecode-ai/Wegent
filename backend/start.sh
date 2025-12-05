#!/bin/bash

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Backend One-Click Startup Script (uv-based)
# Usage: ./start.sh [--port PORT] [--host HOST] [--db-host DB_HOST] [--db-port DB_PORT] [--redis-host REDIS_HOST] [--redis-port REDIS_PORT] [--python PYTHON_PATH]

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
DEFAULT_PORT=8000
DEFAULT_HOST="0.0.0.0"
DEFAULT_DB_HOST="localhost"
DEFAULT_DB_PORT=3306
DEFAULT_REDIS_HOST="127.0.0.1"
DEFAULT_REDIS_PORT=6379
PYTHON_PATH=""

PORT=$DEFAULT_PORT
HOST=$DEFAULT_HOST
DB_HOST=$DEFAULT_DB_HOST
DB_PORT=$DEFAULT_DB_PORT
REDIS_HOST=$DEFAULT_REDIS_HOST
REDIS_PORT=$DEFAULT_REDIS_PORT

# Parse command line arguments
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
        --db-host)
            DB_HOST="$2"
            shift 2
            ;;
        --db-port)
            DB_PORT="$2"
            shift 2
            ;;
        --redis-host)
            REDIS_HOST="$2"
            shift 2
            ;;
        --redis-port)
            REDIS_PORT="$2"
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
            echo "  --port PORT          Backend server port (default: 8000)"
            echo "  --host HOST          Backend server host (default: 0.0.0.0)"
            echo "  --db-host HOST       MySQL host (default: localhost)"
            echo "  --db-port PORT       MySQL port (default: 3306)"
            echo "  --redis-host HOST    Redis host (default: 127.0.0.1)"
            echo "  --redis-port PORT    Redis port (default: 6379)"
            echo "  --python PATH        Python executable path (default: auto-detect)"
            echo "  -h, --help           Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                                      # Use default configuration"
            echo "  $0 --port 8080                          # Use custom backend port"
            echo "  $0 --db-host 192.168.1.100 --db-port 3307   # Use remote MySQL"
            echo "  $0 --redis-host redis.example.com       # Use remote Redis"
            echo "  $0 --python /usr/local/bin/python3.12   # Use specific Python"
            exit 0
            ;;
        *)
            echo -e "${RED}Error: Unknown option $1${NC}"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done
# Validate port numbers
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

validate_port "$PORT" "Backend port"
validate_port "$DB_PORT" "Database port"
validate_port "$REDIS_PORT" "Redis port"

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
        echo -e "   ${BLUE}./start.sh --port 8080${NC}"
        echo -e "   ${BLUE}./start.sh --port 8888${NC}"
        echo ""
        echo -e "${YELLOW}For more options, run:${NC} ${BLUE}./start.sh --help${NC}"
        return 1
    fi
    return 0
}

echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Wegent Backend One-Click Startup Script          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}Configuration:${NC}"
echo -e "  Backend:  http://$HOST:$PORT"
echo -e "  Database: $DB_HOST:$DB_PORT"
echo -e "  Redis:    $REDIS_HOST:$REDIS_PORT"
echo ""
echo -e "${BLUE}Tip: Use ${NC}${YELLOW}./start.sh --help${NC}${BLUE} to see all available options${NC}"
echo ""

# Check backend port
if ! check_port "$PORT" "Backend"; then
    echo ""
    echo -e "${RED}✗ Cannot start backend on port $PORT${NC}"
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

# Step 4: Configure environment variables
echo -e "${BLUE}[4/7] Configuring environment variables...${NC}"
if [ ! -f ".env" ]; then
    if [ ! -f ".env.example" ]; then
        echo -e "${RED}Error: .env.example not found${NC}"
        exit 1
    fi
    cp .env.example .env
    echo -e "${GREEN}✓ Created .env from .env.example${NC}"
    
    # Update ports in .env
    # Update database and Redis configuration in .env
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s|mysql+pymysql://root:123456@[^:]*:[0-9]*/|mysql+pymysql://root:123456@$DB_HOST:$DB_PORT/|g" .env
        sed -i '' "s|redis://[^:]*:[0-9]*/|redis://$REDIS_HOST:$REDIS_PORT/|g" .env
    else
        # Linux
        sed -i "s|mysql+pymysql://root:123456@[^:]*:[0-9]*/|mysql+pymysql://root:123456@$DB_HOST:$DB_PORT/|g" .env
        sed -i "s|redis://[^:]*:[0-9]*/|redis://$REDIS_HOST:$REDIS_PORT/|g" .env
    fi
    echo -e "${YELLOW}Note: Please review and update .env file with your actual configuration${NC}"
else
    echo -e "${GREEN}✓ .env file already exists${NC}"
fi
echo ""

# Step 5: Check database connection
echo -e "${BLUE}[5/7] Checking database connection...${NC}"
DB_USER=$(grep DATABASE_URL .env | cut -d'/' -f3 | cut -d':' -f1)
DB_NAME=$(grep DATABASE_URL .env | cut -d'/' -f4)

if command -v mysql &> /dev/null; then
    if mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -e "SELECT 1" &> /dev/null; then
        echo -e "${GREEN}✓ Database connection successful${NC}"
        
        # Check if database exists
        if mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -e "USE $DB_NAME" &> /dev/null; then
            echo -e "${GREEN}✓ Database '$DB_NAME' exists${NC}"
        else
            echo -e "${YELLOW}Warning: Database '$DB_NAME' does not exist${NC}"
            echo -e "${YELLOW}Creating database...${NC}"
            mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -e "CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
            echo -e "${GREEN}✓ Database created${NC}"
        fi
    else
        echo -e "${YELLOW}Warning: Cannot connect to MySQL database${NC}"
        echo -e "${YELLOW}Please ensure MySQL is running on port $DB_PORT${NC}"
        echo -e "${YELLOW}Database migrations will run automatically on first startup (development mode)${NC}"
    fi
else
    echo -e "${YELLOW}Warning: mysql client not found, skipping database check${NC}"
    echo -e "${YELLOW}Please ensure MySQL is running and accessible${NC}"
fi
echo ""

# Step 6: Check Redis connection
echo -e "${BLUE}[6/7] Checking Redis connection...${NC}"
if command -v redis-cli &> /dev/null; then
    if redis-cli -p "$REDIS_PORT" ping &> /dev/null; then
        echo -e "${GREEN}✓ Redis connection successful${NC}"
    else
        echo -e "${YELLOW}Warning: Cannot connect to Redis on port $REDIS_PORT${NC}"
        echo -e "${YELLOW}Please ensure Redis is running${NC}"
    fi
else
    echo -e "${YELLOW}Warning: redis-cli not found, skipping Redis check${NC}"
    echo -e "${YELLOW}Please ensure Redis is running on port $REDIS_PORT${NC}"
fi
echo ""

# Step 7: Start the server
echo -e "${BLUE}[7/7] Starting backend server...${NC}"

# Set PYTHONPATH to include project root
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

echo -e "${GREEN}Server will start on http://$HOST:$PORT${NC}"
echo -e "${GREEN}API documentation: http://localhost:$PORT/api/docs${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop the server${NC}"
echo ""

# Start uvicorn
uvicorn app.main:app --reload --host "$HOST" --port "$PORT"