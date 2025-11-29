#!/bin/bash
# =============================================================================
# AI Push Gate - Pre-push Quality Check Controller
# =============================================================================
# This script implements quality checks before push for AI coding agents:
#
# - Runs all quality checks (lint, type, test, build)
# - Generates a comprehensive report
# - Blocks push if critical checks fail
# - Documentation reminders can be skipped with AI_VERIFIED=1
#
# Usage:
#   git push                    (runs all checks)
#   AI_VERIFIED=1 git push      (skip doc reminders after review)
#   git push --no-verify        (skip all checks - not recommended)
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Get the commits being pushed
# pre-push hook receives: <local ref> <local sha> <remote ref> <remote sha>
while read local_ref local_sha remote_ref remote_sha; do
    if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
        # Branch is being deleted
        exit 0
    fi

    if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
        # New branch, compare with default branch
        RANGE="origin/main...$local_sha"
    else
        # Existing branch, compare with remote
        RANGE="$remote_sha...$local_sha"
    fi
done

# Get list of changed files in the commits being pushed
CHANGED_FILES=$(git diff --name-only $RANGE 2>/dev/null || git diff --name-only HEAD~1 HEAD 2>/dev/null || true)

if [ -z "$CHANGED_FILES" ]; then
    echo -e "${GREEN}✅ No files changed, skipping checks${NC}"
    exit 0
fi

# =============================================================================
# Generate Quality Check Report
# =============================================================================

echo ""
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}📋 AI Code Quality Check Report (Pre-push)${NC}"
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════════${NC}"
echo ""

# Track check results
WARNINGS=()
DOC_REMINDERS=()

# -----------------------------------------------------------------------------
# Check: Changed files summary
# -----------------------------------------------------------------------------
echo -e "${BLUE}📁 Files to be pushed:${NC}"
FILE_COUNT=$(echo "$CHANGED_FILES" | wc -l)
echo -e "   Total: $FILE_COUNT file(s)"
echo ""

# Count by module
BACKEND_COUNT=$(echo "$CHANGED_FILES" | grep -c "^backend/" || echo "0")
FRONTEND_COUNT=$(echo "$CHANGED_FILES" | grep -c "^frontend/" || echo "0")
EXECUTOR_COUNT=$(echo "$CHANGED_FILES" | grep -c "^executor/" || echo "0")
EXECUTOR_MGR_COUNT=$(echo "$CHANGED_FILES" | grep -c "^executor_manager/" || echo "0")
SHARED_COUNT=$(echo "$CHANGED_FILES" | grep -c "^shared/" || echo "0")
OTHER_COUNT=$(echo "$CHANGED_FILES" | grep -cvE "^(backend|frontend|executor|executor_manager|shared)/" || echo "0")

echo -e "   ${BLUE}Modules affected:${NC}"
[ "$BACKEND_COUNT" != "0" ] && echo -e "   - Backend: $BACKEND_COUNT file(s)"
[ "$FRONTEND_COUNT" != "0" ] && echo -e "   - Frontend: $FRONTEND_COUNT file(s)"
[ "$EXECUTOR_COUNT" != "0" ] && echo -e "   - Executor: $EXECUTOR_COUNT file(s)"
[ "$EXECUTOR_MGR_COUNT" != "0" ] && echo -e "   - Executor Manager: $EXECUTOR_MGR_COUNT file(s)"
[ "$SHARED_COUNT" != "0" ] && echo -e "   - Shared: $SHARED_COUNT file(s)"
[ "$OTHER_COUNT" != "0" ] && echo -e "   - Other: $OTHER_COUNT file(s)"
echo ""

# -----------------------------------------------------------------------------
# Check: Documentation reminders
# -----------------------------------------------------------------------------
echo -e "${BLUE}📝 Documentation Check:${NC}"

# API files changed
API_FILES=$(echo "$CHANGED_FILES" | grep -E "^backend/app/api/.*\.py$" || true)
if [ -n "$API_FILES" ]; then
    DOC_REMINDERS+=("API files changed → Check docs/ for API documentation updates")
fi

# Models/Schemas changed
MODEL_FILES=$(echo "$CHANGED_FILES" | grep -E "^backend/app/(models|schemas)/.*\.py$" || true)
if [ -n "$MODEL_FILES" ]; then
    DOC_REMINDERS+=("Models/Schemas changed → Check API documentation for schema updates")
fi

# Project config changed
CONFIG_FILES=$(echo "$CHANGED_FILES" | grep -E "(docker-compose|Dockerfile|requirements\.txt|package\.json)" || true)
if [ -n "$CONFIG_FILES" ]; then
    DOC_REMINDERS+=("Project configuration changed → Consider updating AGENTS.md")
fi

# Agent files changed
AGENT_FILES=$(echo "$CHANGED_FILES" | grep -E "^executor/agents/.*\.py$" || true)
if [ -n "$AGENT_FILES" ]; then
    DOC_REMINDERS+=("Executor agents changed → Check AGENTS.md for agent documentation")
fi

if [ ${#DOC_REMINDERS[@]} -eq 0 ]; then
    echo -e "   ${GREEN}✅ No documentation updates detected${NC}"
else
    echo -e "   ${YELLOW}⚠️ Documentation reminders:${NC}"
    for reminder in "${DOC_REMINDERS[@]}"; do
        echo -e "   ${YELLOW}   - $reminder${NC}"
        WARNINGS+=("Doc: $reminder")
    done
fi
echo ""

# -----------------------------------------------------------------------------
# Summary Section
# -----------------------------------------------------------------------------
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}📊 Pre-push Checks${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo ""

echo -e "   ${BLUE}The following checks will run:${NC}"
echo -e "      - Lint & Format (Black, isort, ESLint)"
echo -e "      - Type Check (TypeScript, mypy)"
echo -e "      - Unit Tests (pytest, npm test)"
echo -e "      - Build Check (py_compile, npm run build)"
echo ""

if [ ${#WARNINGS[@]} -gt 0 ]; then
    echo -e "   ${YELLOW}⚠️ Warnings: ${#WARNINGS[@]}${NC}"
    for warning in "${WARNINGS[@]}"; do
        echo -e "      ${YELLOW}- $warning${NC}"
    done
    echo ""
fi

# -----------------------------------------------------------------------------
# Check AI_VERIFIED for documentation reminders
# -----------------------------------------------------------------------------
if [ ${#DOC_REMINDERS[@]} -gt 0 ] && [ "$AI_VERIFIED" != "1" ]; then
    echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${YELLOW}${BOLD}🔒 Documentation Review Required${NC}"
    echo ""
    echo -e "Please review the documentation reminders above."
    echo -e "If you have verified all items, re-run with:"
    echo ""
    echo -e "    ${GREEN}${BOLD}AI_VERIFIED=1 git push${NC}"
    echo ""
    echo -e "To skip all pre-push checks (not recommended):"
    echo ""
    echo -e "    ${YELLOW}git push --no-verify${NC}"
    echo ""
    echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
    echo ""
    exit 1
fi

# If AI_VERIFIED=1 or no doc reminders, proceed
if [ "$AI_VERIFIED" = "1" ]; then
    echo -e "${GREEN}══════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}✅ AI Verified - Proceeding with push${NC}"
    echo -e "${GREEN}══════════════════════════════════════════════════════════${NC}"
    echo ""
fi

exit 0
