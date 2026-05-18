#!/bin/bash
# Example pre-execute hook script that prepares a task workspace.
# Usage: Set WEGENT_HOOK_PRE_EXECUTE=/path/to/pre-execute-hook.sh

TASK_DIR="$1"
LOG_FILE="/tmp/wegent-pre-execute-hook.log"
SOURCE_SKILL_DIR="${WEGENT_HOOK_SOURCE_SKILL_DIR:-}"

# Log function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Initialize log file
cat > "$LOG_FILE" << EOF
========================================
Pre-execute Hook Log
Timestamp: $(date '+%Y-%m-%d %H:%M:%S')
========================================
Task Directory: $TASK_DIR
Task ID: $WEGENT_TASK_ID
Git URL: $WEGENT_GIT_URL
WEGENT_TASK_DIR: $WEGENT_TASK_DIR
========================================
EOF

# Validate task directory parameter
if [ -z "$TASK_DIR" ]; then
    log "ERROR: Task directory parameter is empty"
    exit 1
fi

if [ ! -d "$TASK_DIR" ]; then
    log "ERROR: Task directory does not exist: $TASK_DIR"
    exit 1
fi

# Optionally copy shared skills into the task workspace.
if [ -z "$SOURCE_SKILL_DIR" ]; then
    log "No source skill directory configured; skipping skill copy"
    exit 0
fi

if [ ! -d "$SOURCE_SKILL_DIR" ]; then
    log "WARNING: Source skill directory does not exist: $SOURCE_SKILL_DIR"
    log "Skipping skill copy"
    exit 0
fi

TARGET_SKILLS_DIR="$TASK_DIR/.claude/skills"
if [ ! -d "$TARGET_SKILLS_DIR" ]; then
    log "Creating target skills directory: $TARGET_SKILLS_DIR"
    mkdir -p "$TARGET_SKILLS_DIR"
    if [ $? -ne 0 ]; then
        log "ERROR: Failed to create target skills directory"
        exit 1
    fi
fi

log "Copying skills from $SOURCE_SKILL_DIR to $TARGET_SKILLS_DIR/"
cp -r "$SOURCE_SKILL_DIR" "$TARGET_SKILLS_DIR/"

if [ $? -eq 0 ]; then
    log "SUCCESS: Skills copied successfully"
else
    log "ERROR: Failed to copy skills"
    exit 1
fi

# Create optional task-local instructions for downstream execution.
CLAUDE_MD_FILE="$TASK_DIR/CLAUDE.md"
log "Creating CLAUDE.md at $CLAUDE_MD_FILE"

cat > "$CLAUDE_MD_FILE" << 'EOF'
# Task Workspace Instructions

This workspace was prepared by the Wegent pre-execute hook.

Use any copied skills or local configuration files according to the task requirements.
EOF

if [ $? -eq 0 ]; then
    log "SUCCESS: CLAUDE.md created successfully"
else
    log "ERROR: Failed to create CLAUDE.md"
    exit 1
fi

exit 0
