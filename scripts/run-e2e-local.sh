#!/bin/bash
# E2E Test Local Runner
# This script starts all required services and runs E2E tests locally
#
# Usage:
#   ./scripts/run-e2e-local.sh [mode]
#
# Modes:
#   run      - Run tests headless (default)
#   ui       - Run with Playwright UI mode
#   debug    - Run with debugger
#   headed   - Run tests with visible browser
#   report   - Show test report

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get the project root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Log directory
LOG_DIR="$PROJECT_ROOT/logs/e2e"
mkdir -p "$LOG_DIR"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Wegent E2E Test Local Runner${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "${YELLOW}Logs will be saved to: $LOG_DIR${NC}"

# Function to cleanup on exit
cleanup() {
    echo -e "\n${YELLOW}Cleaning up...${NC}"
    
    # Kill background processes
    if [ ! -z "$BACKEND_PID" ]; then
        echo "Stopping backend (PID: $BACKEND_PID)..."
        kill $BACKEND_PID 2>/dev/null || true
    fi
    
    if [ ! -z "$FRONTEND_PID" ]; then
        echo "Stopping frontend (PID: $FRONTEND_PID)..."
        kill $FRONTEND_PID 2>/dev/null || true
    fi
    
    # Stop docker services if we started them
    if [ "$STARTED_DOCKER" = "true" ]; then
        echo "Stopping Docker services..."
        cd "$PROJECT_ROOT"
        docker-compose stop mysql redis 2>/dev/null || true
    fi
    
    echo -e "${GREEN}Cleanup complete.${NC}"
}

trap cleanup EXIT

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}Error: Docker is not running. Please start Docker first.${NC}"
    exit 1
fi

# Step 1: Start MySQL and Redis via docker-compose
echo -e "\n${YELLOW}Step 1: Starting MySQL and Redis...${NC}"
cd "$PROJECT_ROOT"

# Check if services are already running
MYSQL_RUNNING=$(docker-compose ps mysql 2>/dev/null | grep -c "Up" || echo "0")
REDIS_RUNNING=$(docker-compose ps redis 2>/dev/null | grep -c "Up" || echo "0")

if [ "$MYSQL_RUNNING" = "0" ] || [ "$REDIS_RUNNING" = "0" ]; then
    docker-compose up -d mysql redis
    STARTED_DOCKER=true
    echo "Waiting for MySQL to be ready..."
    sleep 10
else
    echo "MySQL and Redis are already running."
    STARTED_DOCKER=false
fi

# Step 2: Install shared module
echo -e "\n${YELLOW}Step 2: Installing shared module...${NC}"
cd "$PROJECT_ROOT/shared"

# Check if uv is installed
if ! command -v uv &> /dev/null; then
    echo "Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    source $HOME/.cargo/env
fi

echo "Installing shared module..."
uv venv 2>/dev/null || true
source .venv/bin/activate 2>/dev/null || true
uv pip install -e .

# Step 3: Start Backend
echo -e "\n${YELLOW}Step 3: Starting Backend...${NC}"
cd "$PROJECT_ROOT/backend"

# Set environment variables for backend
export DATABASE_URL="mysql+pymysql://root:123456@127.0.0.1:3306/task_manager"
export REDIS_URL="redis://127.0.0.1:6379"
export ENVIRONMENT="development"
export DB_AUTO_MIGRATE="True"
export INIT_DATA_ENABLED="True"
export INIT_DATA_DIR="$PROJECT_ROOT/backend/init_data"
export PYTHONPATH="$PROJECT_ROOT"

# Sync dependencies
echo "Syncing backend dependencies..."
uv sync

# Install shared module in backend venv
echo "Installing shared module in backend venv..."
source .venv/bin/activate
uv pip install -e ../shared

# Start backend in background (output to log file)
echo "Starting backend server (logs: $BACKEND_LOG)..."
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 > "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

# Step 4: Start Frontend
echo -e "\n${YELLOW}Step 4: Starting Frontend...${NC}"
cd "$PROJECT_ROOT/frontend"

# Set environment variables for frontend
export NEXT_PUBLIC_API_URL="http://localhost:8000"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies..."
    npm ci
fi

# Install Playwright browsers if needed
if [ ! -d "$HOME/.cache/ms-playwright" ]; then
    echo "Installing Playwright browsers..."
    npx playwright install chromium --with-deps
fi

# Start frontend in dev mode (faster for local development, output to log file)
echo "Starting frontend in dev mode (logs: $FRONTEND_LOG)..."
npm run dev > "$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

# Step 5: Wait for services to be ready
echo -e "\n${YELLOW}Step 5: Waiting for services to be ready...${NC}"

echo "Waiting for backend..."
for i in {1..60}; do
    if curl -s http://localhost:8000/api/health > /dev/null 2>&1 || curl -s http://localhost:8000/ > /dev/null 2>&1; then
        echo -e "${GREEN}Backend is ready!${NC}"
        break
    fi
    if [ $i -eq 60 ]; then
        echo -e "${RED}Backend failed to start within 120 seconds${NC}"
        exit 1
    fi
    echo "Waiting for backend... ($i/60)"
    sleep 2
done

echo "Waiting for frontend..."
for i in {1..30}; do
    if curl -s http://localhost:3000 > /dev/null 2>&1; then
        echo -e "${GREEN}Frontend is ready!${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}Frontend failed to start within 60 seconds${NC}"
        exit 1
    fi
    echo "Waiting for frontend... ($i/30)"
    sleep 2
done

# Step 6: Run E2E tests
echo -e "\n${YELLOW}Step 6: Running E2E tests...${NC}"
cd "$PROJECT_ROOT/frontend"

export E2E_BASE_URL="http://localhost:3000"

# Parse command line arguments
E2E_MODE="${1:-run}"

case "$E2E_MODE" in
    "ui")
        echo "Running E2E tests in UI mode..."
        npx playwright test --ui
        ;;
    "debug")
        echo "Running E2E tests in debug mode..."
        npx playwright test --debug
        ;;
    "headed")
        echo "Running E2E tests with visible browser..."
        npx playwright test --headed
        ;;
    "report")
        echo "Opening E2E test report..."
        npx playwright show-report
        ;;
    *)
        echo "Running E2E tests (headless)..."
        npx playwright test
        ;;
esac

E2E_EXIT_CODE=$?

echo -e "\n${GREEN}========================================${NC}"
if [ $E2E_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}  E2E Tests Completed Successfully!${NC}"
else
    echo -e "${RED}  E2E Tests Failed (exit code: $E2E_EXIT_CODE)${NC}"
fi
echo -e "${GREEN}========================================${NC}"

exit $E2E_EXIT_CODE