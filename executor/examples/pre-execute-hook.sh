#!/bin/bash
# Example pre-execute hook script for testing
# Usage: Set WEGENT_HOOK_PRE_EXECUTE=/path/to/pre-execute-hook.sh

TASK_DIR="$1"
LOG_FILE="/tmp/wegent-pre-execute-hook.log"

# Save parameters to tmp file
cat > "$LOG_FILE" << EOF
========================================"
Pre-execute Hook Log
Timestamp: $(date '+%Y-%m-%d %H:%M:%S')
========================================
Task Directory: $TASK_DIR
Task ID: $WEGENT_TASK_ID
Git URL: $WEGENT_GIT_URL
WEGENT_TASK_DIR: $WEGENT_TASK_DIR
========================================
EOF

echo "Parameters saved to $LOG_FILE"

# Also print to stdout
cat "$LOG_FILE"

exit 0
