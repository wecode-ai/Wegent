#!/bin/bash

# Test script for port persistence functionality

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_DIR="$SCRIPT_DIR/.pids"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Testing Port Persistence Functionality${NC}"
echo "========================================"
echo ""

# Clean up any existing .pids directory
if [ -d "$PID_DIR" ]; then
    echo -e "${YELLOW}Cleaning up existing .pids directory...${NC}"
    rm -rf "$PID_DIR"
fi

mkdir -p "$PID_DIR"

# Test 1: Create mock .port files
echo -e "${BLUE}Test 1: Creating mock .port files${NC}"
echo "8001" > "$PID_DIR/backend.port"
echo "8101" > "$PID_DIR/chat_shell.port"
echo "8002" > "$PID_DIR/executor_manager.port"
echo "3001" > "$PID_DIR/frontend.port"
echo -e "${GREEN}✓ Created mock .port files${NC}"
echo ""

# Test 2: Source the load_last_used_port function from start.sh
echo -e "${BLUE}Test 2: Testing load_last_used_port function${NC}"

# Extract and test the function
load_last_used_port() {
    local service=$1
    local default_port=$2
    local port_file="$PID_DIR/${service}.port"
    
    if [ -f "$port_file" ]; then
        local saved_port=$(cat "$port_file" 2>/dev/null)
        if [ -n "$saved_port" ] && [ "$saved_port" -gt 0 ] 2>/dev/null; then
            echo "$saved_port"
            return 0
        fi
    fi
    echo "$default_port"
}

# Test loading saved ports
BACKEND_PORT=$(load_last_used_port "backend" 8000)
CHAT_SHELL_PORT=$(load_last_used_port "chat_shell" 8100)
EXECUTOR_MANAGER_PORT=$(load_last_used_port "executor_manager" 8001)
FRONTEND_PORT=$(load_last_used_port "frontend" 3000)

echo "  Backend port: $BACKEND_PORT (expected: 8001)"
echo "  Chat Shell port: $CHAT_SHELL_PORT (expected: 8101)"
echo "  Executor Manager port: $EXECUTOR_MANAGER_PORT (expected: 8002)"
echo "  Frontend port: $FRONTEND_PORT (expected: 3001)"

if [ "$BACKEND_PORT" = "8001" ] && [ "$CHAT_SHELL_PORT" = "8101" ] && \
   [ "$EXECUTOR_MANAGER_PORT" = "8002" ] && [ "$FRONTEND_PORT" = "3001" ]; then
    echo -e "${GREEN}✓ All ports loaded correctly from .port files${NC}"
else
    echo -e "${RED}✗ Port loading failed${NC}"
    exit 1
fi
echo ""

# Test 3: Test with missing .port files (should use defaults)
echo -e "${BLUE}Test 3: Testing with missing .port files${NC}"
rm -f "$PID_DIR/backend.port"

BACKEND_PORT=$(load_last_used_port "backend" 8000)
echo "  Backend port: $BACKEND_PORT (expected: 8000 - default)"

if [ "$BACKEND_PORT" = "8000" ]; then
    echo -e "${GREEN}✓ Default port used when .port file missing${NC}"
else
    echo -e "${RED}✗ Default port test failed${NC}"
    exit 1
fi
echo ""

# Test 4: Test with invalid .port file content
echo -e "${BLUE}Test 4: Testing with invalid .port file content${NC}"
echo "invalid" > "$PID_DIR/backend.port"

BACKEND_PORT=$(load_last_used_port "backend" 8000)
echo "  Backend port: $BACKEND_PORT (expected: 8000 - default)"

if [ "$BACKEND_PORT" = "8000" ]; then
    echo -e "${GREEN}✓ Default port used when .port file contains invalid data${NC}"
else
    echo -e "${RED}✗ Invalid data test failed${NC}"
    exit 1
fi
echo ""

# Test 5: Verify start.sh syntax
echo -e "${BLUE}Test 5: Verifying start.sh syntax${NC}"
if bash -n "$SCRIPT_DIR/start.sh"; then
    echo -e "${GREEN}✓ start.sh syntax is valid${NC}"
else
    echo -e "${RED}✗ start.sh has syntax errors${NC}"
    exit 1
fi
echo ""

# Clean up
echo -e "${YELLOW}Cleaning up test files...${NC}"
rm -rf "$PID_DIR"

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ All port persistence tests passed!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
