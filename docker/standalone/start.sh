#!/bin/bash
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Standalone startup script - starts Backend and Frontend in a single container

set -e

echo "=========================================="
echo "  Starting Wegent Standalone"
echo "=========================================="
echo ""
# Create data directory for SQLite database
mkdir -p /app/data

# Set absolute path for SQLite database
# Note: SQLite absolute path requires 4 slashes: sqlite:////path/to/db
export DATABASE_URL="sqlite:////app/data/wegent.db"

# Set default ports if not specified
BACKEND_PORT=${BACKEND_PORT:-8000}
FRONTEND_PORT=${FRONTEND_PORT:-3000}

# ========================================
# Step 1: Initialize Database
# ========================================
# Ensure we're in the correct directory for alembic
cd /app/backend

if [ ! -f /app/data/wegent.db ]; then
    echo "[1/4] Initializing SQLite database..."
    # env.py will detect fresh database and use Base.metadata.create_all()
    # then stamp to head, bypassing old MySQL-specific migrations
    alembic upgrade head
    echo "      Database initialized successfully"
else
    echo "[1/4] Database exists, checking for migrations..."
    # For existing databases, run migrations normally
    alembic upgrade head
    echo "      Database migrations applied"
fi

# ========================================
# Step 2: Start Backend
# ========================================
echo "[2/4] Starting Backend (port ${BACKEND_PORT})..."
cd /app/backend
uvicorn app.main:app \
    --host 0.0.0.0 \
    --port ${BACKEND_PORT} \
    --workers 1 \
    --timeout-graceful-shutdown ${GRACEFUL_SHUTDOWN_TIMEOUT:-600} &
BACKEND_PID=$!

# Wait for Backend to be ready
echo "      Waiting for Backend to be ready..."
for i in {1..60}; do
    if curl -s http://localhost:${BACKEND_PORT}/health > /dev/null 2>&1; then
        echo "      Backend is ready (PID: ${BACKEND_PID})"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "      ERROR: Backend failed to start within 60 seconds"
        kill $BACKEND_PID 2>/dev/null || true
        exit 1
    fi
    sleep 1
done

# ========================================
# Step 3: Start Frontend
# ========================================
echo "[3/4] Starting Frontend (port ${FRONTEND_PORT})..."
cd /app/frontend

# Set runtime environment variables for Frontend
# RUNTIME_INTERNAL_API_URL is always localhost (internal container communication)
export RUNTIME_INTERNAL_API_URL=http://localhost:${BACKEND_PORT}
# RUNTIME_SOCKET_DIRECT_URL can be overridden via docker-compose for remote access
# Only set default if not already provided
export RUNTIME_SOCKET_DIRECT_URL=${RUNTIME_SOCKET_DIRECT_URL:-http://localhost:${BACKEND_PORT}}
export NODE_ENV=production
export PORT=${FRONTEND_PORT}
export HOSTNAME="0.0.0.0"

# Limit Node.js memory to reduce overall container memory usage
# Default: 96MB max old space, can be overridden via FRONTEND_MAX_MEMORY
export NODE_OPTIONS="--max-old-space-size=${FRONTEND_MAX_MEMORY:-96}"

node server.js &
FRONTEND_PID=$!

# Wait for Frontend to be ready
echo "      Waiting for Frontend to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:${FRONTEND_PORT} > /dev/null 2>&1; then
        echo "      Frontend is ready (PID: ${FRONTEND_PID})"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "      WARNING: Frontend may not be fully ready, continuing anyway..."
    fi
    sleep 1
done

# ========================================
# Step 4: All Services Started
# ========================================
echo "[4/4] All services started!"
echo ""
echo "=========================================="
echo "  Wegent Standalone is running!"
echo "=========================================="
echo ""
echo "  Frontend: http://localhost:${FRONTEND_PORT}"
echo "  Backend:  http://localhost:${BACKEND_PORT}"
echo ""
echo "  Data directory: /app/data"
echo "  Database: /app/data/wegent.db"
echo ""
echo "=========================================="
echo ""

# ========================================
# Signal Handling for Graceful Shutdown
# ========================================
shutdown() {
    echo ""
    echo "Received shutdown signal, stopping services..."
    
    # Send SIGTERM to both processes
    if [ -n "$FRONTEND_PID" ]; then
        echo "  Stopping Frontend (PID: ${FRONTEND_PID})..."
        kill -TERM $FRONTEND_PID 2>/dev/null || true
    fi
    
    if [ -n "$BACKEND_PID" ]; then
        echo "  Stopping Backend (PID: ${BACKEND_PID})..."
        kill -TERM $BACKEND_PID 2>/dev/null || true
    fi
    
    # Wait for processes to terminate gracefully
    echo "  Waiting for services to stop..."
    wait $FRONTEND_PID 2>/dev/null || true
    wait $BACKEND_PID 2>/dev/null || true
    
    echo "  All services stopped"
    exit 0
}

# Register signal handlers
trap shutdown SIGTERM SIGINT SIGQUIT

# ========================================
# Keep Container Running
# ========================================
# Wait for any process to exit
wait -n $BACKEND_PID $FRONTEND_PID

# If we get here, one of the processes exited
EXIT_CODE=$?
echo ""
echo "WARNING: A service has exited unexpectedly (exit code: ${EXIT_CODE})"

# Check which process is still running
if kill -0 $BACKEND_PID 2>/dev/null; then
    echo "  Backend is still running"
else
    echo "  Backend has stopped"
fi

if kill -0 $FRONTEND_PID 2>/dev/null; then
    echo "  Frontend is still running"
else
    echo "  Frontend has stopped"
fi

# Cleanup and exit
shutdown
