#!/bin/bash

# Test script for port conflict detection and auto-adjustment

echo "Testing port conflict detection and auto-adjustment..."
echo ""

# Start a simple HTTP server on port 8000 to simulate conflict
echo "Starting test server on port 8000 to simulate conflict..."
python3 -m http.server 8000 > /dev/null 2>&1 &
TEST_PID=$!
sleep 2

echo "Test server PID: $TEST_PID"
echo ""

# Check if port 8000 is in use
if lsof -Pi :8000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "✓ Port 8000 is now occupied (as expected)"
else
    echo "✗ Failed to occupy port 8000"
    kill $TEST_PID 2>/dev/null
    exit 1
fi

echo ""
echo "Now run: ./start.sh"
echo "The script should automatically detect the conflict and use port 8001 for backend"
echo ""
echo "To clean up the test server, run: kill $TEST_PID"
echo "Or press Ctrl+C and the cleanup will happen automatically"

# Wait for user interrupt
trap "echo ''; echo 'Cleaning up...'; kill $TEST_PID 2>/dev/null; echo 'Test server stopped'; exit 0" INT TERM

wait $TEST_PID
