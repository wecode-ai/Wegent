#!/bin/bash
# =============================================================================
# Documentation Update Check Script
# =============================================================================
# This script checks if documentation might need to be updated based on
# changed files and outputs reminders (does not block commits).
#
# Trigger conditions:
# - API files changed -> remind to check API docs
# - Models/Schemas changed -> remind to check API docs
# - Project structure changes -> remind to update AGENTS.md
# - New module directories -> remind to create documentation
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get list of staged files
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)

if [ -z "$STAGED_FILES" ]; then
    exit 0
fi

DOC_REMINDERS=()

# -----------------------------------------------------------------------------
# Check 1: API files changed
# -----------------------------------------------------------------------------
API_FILES=$(echo "$STAGED_FILES" | grep -E "^backend/app/api/.*\.py$" || true)
if [ -n "$API_FILES" ]; then
    DOC_REMINDERS+=("  - backend/app/api/ files changed → Check docs/en/guides/ for API documentation updates")
fi

# -----------------------------------------------------------------------------
# Check 2: Models or Schemas changed
# -----------------------------------------------------------------------------
MODEL_FILES=$(echo "$STAGED_FILES" | grep -E "^backend/app/(models|schemas)/.*\.py$" || true)
if [ -n "$MODEL_FILES" ]; then
    DOC_REMINDERS+=("  - Models/Schemas changed → Check API documentation for schema updates")
fi

# -----------------------------------------------------------------------------
# Check 3: Project structure files changed
# -----------------------------------------------------------------------------
STRUCTURE_FILES=$(echo "$STAGED_FILES" | grep -E "(docker-compose|Dockerfile|requirements\.txt|package\.json|pyproject\.toml)" || true)
if [ -n "$STRUCTURE_FILES" ]; then
    DOC_REMINDERS+=("  - Project configuration changed → Consider updating AGENTS.md (CLAUDE.md)")
fi

# -----------------------------------------------------------------------------
# Check 4: New directories created in key modules
# -----------------------------------------------------------------------------
NEW_DIRS=$(echo "$STAGED_FILES" | grep -E "^(backend|frontend|executor|executor_manager|shared)/" | \
           xargs -I{} dirname {} 2>/dev/null | sort -u || true)

for dir in $NEW_DIRS; do
    # Check if this is a new directory (not previously tracked)
    if ! git ls-tree -d HEAD "$dir" >/dev/null 2>&1; then
        # Check if it's a feature/module directory (has __init__.py or index.ts)
        if echo "$STAGED_FILES" | grep -qE "^$dir/(__init__|index)\.(py|ts|tsx)$"; then
            DOC_REMINDERS+=("  - New module directory: $dir → Consider creating documentation")
        fi
    fi
done

# -----------------------------------------------------------------------------
# Check 5: Frontend features changed
# -----------------------------------------------------------------------------
FEATURE_FILES=$(echo "$STAGED_FILES" | grep -E "^frontend/src/features/.*\.(ts|tsx)$" || true)
if [ -n "$FEATURE_FILES" ]; then
    DOC_REMINDERS+=("  - Frontend features changed → Check if user guides need updates")
fi

# -----------------------------------------------------------------------------
# Check 6: Executor agent types changed
# -----------------------------------------------------------------------------
AGENT_FILES=$(echo "$STAGED_FILES" | grep -E "^executor/agents/.*\.py$" || true)
if [ -n "$AGENT_FILES" ]; then
    DOC_REMINDERS+=("  - Executor agents changed → Check AGENTS.md for agent documentation updates")
fi

# -----------------------------------------------------------------------------
# Output reminders if any
# -----------------------------------------------------------------------------
if [ ${#DOC_REMINDERS[@]} -gt 0 ]; then
    echo ""
    echo -e "${YELLOW}══════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}📝 Documentation Update Reminders${NC}"
    echo -e "${YELLOW}══════════════════════════════════════════════════════════${NC}"
    echo ""
    for reminder in "${DOC_REMINDERS[@]}"; do
        echo -e "${BLUE}$reminder${NC}"
    done
    echo ""
    echo -e "${YELLOW}These are reminders only and will not block your commit.${NC}"
    echo -e "${YELLOW}══════════════════════════════════════════════════════════${NC}"
    echo ""

    # Export reminders for use by ai-commit-gate.sh
    export DOC_UPDATE_REMINDERS="${DOC_REMINDERS[*]}"
fi

exit 0
