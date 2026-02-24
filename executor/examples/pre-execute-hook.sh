#!/bin/bash
# Pre-execute hook script that copies browser skills to task workspace
# Usage: Set WEGENT_HOOK_PRE_EXECUTE=/path/to/pre-execute-hook.sh

TASK_DIR="$1"
LOG_FILE="/tmp/wegent-pre-execute-hook.log"
SOURCE_SKILL_DIR="/Users/yunpeng7/.wegent-executor/workspace/204145/.claude/skills/browser"

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

# Check if source skill directory exists
if [ ! -d "$SOURCE_SKILL_DIR" ]; then
    log "WARNING: Source skill directory does not exist: $SOURCE_SKILL_DIR"
    log "Skipping skill copy"
    exit 0
fi

# Create target .claude/skills directory if it doesn't exist
TARGET_SKILLS_DIR="$TASK_DIR/.claude/skills"
if [ ! -d "$TARGET_SKILLS_DIR" ]; then
    log "Creating target skills directory: $TARGET_SKILLS_DIR"
    mkdir -p "$TARGET_SKILLS_DIR"
    if [ $? -ne 0 ]; then
        log "ERROR: Failed to create target skills directory"
        exit 1
    fi
fi

# Copy browser skill folder to target
log "Copying browser skills from $SOURCE_SKILL_DIR to $TARGET_SKILLS_DIR/"
cp -r "$SOURCE_SKILL_DIR" "$TARGET_SKILLS_DIR/"

if [ $? -eq 0 ]; then
    log "SUCCESS: Browser skills copied successfully"
else
    log "ERROR: Failed to copy browser skills"
    exit 1
fi

# Create CLAUDE.md with browser automation instructions
CLAUDE_MD_FILE="$TASK_DIR/CLAUDE.md"
log "Creating CLAUDE.md at $CLAUDE_MD_FILE"

cat > "$CLAUDE_MD_FILE" << 'EOF'
---
Browser Automation Agent

You are an automation agent that accomplishes user goals through browser interactions and system tools.

Mandatory Requirements

1. Calendar Integration: When querying time-sensitive events (e.g., livestream schedules), use system tools to create entries in the macOS calendar.
2. Tab Cleanup: Close all browser tabs opened during task execution once the task is complete.

Core Rules

1. 如果搜索微博之夜，直接打开 https://s.weibo.com 来搜索包括 #微博之夜阵容官宣# 等。  如果你看到了 #微博之夜第五波阵容官宣# 那请继续搜索 #微博之夜第二波阵容官宣# 等 第X波。注意没有第一波。
2. Verify page state before acting. Use snapshot when structure is unclear.
3. Prefer minimal, reliable actions. Avoid unnecessary clicks, scrolling, or repeated retries.
4. On failure (e.g., element not found), inspect with snapshot or screenshot, then adapt.
5. Execute one action at a time.
6. Report outcome clearly when the goal is achieved or cannot be completed.
7. 微博之夜2025年会在2026年举办，特别注意

Priority

Correctness and reliability over speed.
EOF

if [ $? -eq 0 ]; then
    log "SUCCESS: CLAUDE.md created successfully"
else
    log "ERROR: Failed to create CLAUDE.md"
    exit 1
fi

exit 0
