#!/bin/bash
# =============================================================================
# AI Commit Gate - Two-Stage Commit Flow Controller
# =============================================================================
# This script implements a two-stage commit flow for AI coding agents:
#
# Stage 1: First commit attempt
#   - Runs all quality checks
#   - Generates a comprehensive report
#   - Blocks commit and asks for AI_VERIFIED=1 confirmation
#
# Stage 2: Confirmed commit (AI_VERIFIED=1)
#   - Skips the confirmation gate
#   - Still runs core checks (lint, type, test, build)
#   - Allows commit if core checks pass
#
# Usage:
#   Stage 1: git commit -m "message"
#   Stage 2: AI_VERIFIED=1 git commit -m "message"
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

# Get staged files
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)

if [ -z "$STAGED_FILES" ]; then
    echo -e "${GREEN}✅ No staged files to check${NC}"
    exit 0
fi

# Check if AI has verified the commit
if [ "$AI_VERIFIED" = "1" ]; then
    echo ""
    echo -e "${GREEN}══════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}✅ AI Verified Commit - Proceeding with commit${NC}"
    echo -e "${GREEN}══════════════════════════════════════════════════════════${NC}"
    echo ""
    exit 0
fi

# =============================================================================
# Stage 1: Generate Quality Check Report
# =============================================================================

echo ""
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}📋 AI Code Quality Check Report${NC}"
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════════${NC}"
echo ""

# Track check results
declare -A CHECK_RESULTS
WARNINGS=()
ERRORS=()
DOC_REMINDERS=()

# -----------------------------------------------------------------------------
# Check: Staged files summary
# -----------------------------------------------------------------------------
echo -e "${BLUE}📁 Staged Files:${NC}"
FILE_COUNT=$(echo "$STAGED_FILES" | wc -l)
echo -e "   Total: $FILE_COUNT file(s)"
echo ""

# Count by module
BACKEND_COUNT=$(echo "$STAGED_FILES" | grep -c "^backend/" || echo "0")
FRONTEND_COUNT=$(echo "$STAGED_FILES" | grep -c "^frontend/" || echo "0")
EXECUTOR_COUNT=$(echo "$STAGED_FILES" | grep -c "^executor/" || echo "0")
EXECUTOR_MGR_COUNT=$(echo "$STAGED_FILES" | grep -c "^executor_manager/" || echo "0")
SHARED_COUNT=$(echo "$STAGED_FILES" | grep -c "^shared/" || echo "0")
OTHER_COUNT=$(echo "$STAGED_FILES" | grep -cvE "^(backend|frontend|executor|executor_manager|shared)/" || echo "0")

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
API_FILES=$(echo "$STAGED_FILES" | grep -E "^backend/app/api/.*\.py$" || true)
if [ -n "$API_FILES" ]; then
    DOC_REMINDERS+=("API files changed → Check docs/ for API documentation updates")
fi

# Models/Schemas changed
MODEL_FILES=$(echo "$STAGED_FILES" | grep -E "^backend/app/(models|schemas)/.*\.py$" || true)
if [ -n "$MODEL_FILES" ]; then
    DOC_REMINDERS+=("Models/Schemas changed → Check API documentation for schema updates")
fi

# Project config changed
CONFIG_FILES=$(echo "$STAGED_FILES" | grep -E "(docker-compose|Dockerfile|requirements\.txt|package\.json)" || true)
if [ -n "$CONFIG_FILES" ]; then
    DOC_REMINDERS+=("Project configuration changed → Consider updating AGENTS.md")
fi

# Agent files changed
AGENT_FILES=$(echo "$STAGED_FILES" | grep -E "^executor/agents/.*\.py$" || true)
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
echo -e "${CYAN}📊 Summary${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo ""

# Pre-commit will run the actual checks, this script just provides the gate
echo -e "   ${BLUE}ℹ️  Pre-commit hooks will run the following checks:${NC}"
echo -e "      - Lint & Format (Black, isort, ESLint)"
echo -e "      - Type Check (TypeScript, mypy)"
echo -e "      - Unit Tests (pytest, npm test)"
echo -e "      - Build Check (py_compile)"
echo -e "      - General checks (trailing whitespace, YAML, JSON, etc.)"
echo ""

if [ ${#WARNINGS[@]} -gt 0 ]; then
    echo -e "   ${YELLOW}⚠️ Warnings: ${#WARNINGS[@]}${NC}"
    for warning in "${WARNINGS[@]}"; do
        echo -e "      ${YELLOW}- $warning${NC}"
    done
    echo ""
fi

# -----------------------------------------------------------------------------
# Confirmation Request
# -----------------------------------------------------------------------------
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}${BOLD}🔒 Commit Gate Active${NC}"
echo ""
echo -e "Please review the above report. The pre-commit hooks will now"
echo -e "run all quality checks. If all checks pass and you have verified"
echo -e "the documentation reminders, re-run your commit with:"
echo ""
echo -e "    ${GREEN}${BOLD}AI_VERIFIED=1 git commit -m \"your message\"${NC}"
echo ""
echo -e "To skip all pre-commit checks (not recommended):"
echo ""
echo -e "    ${YELLOW}git commit --no-verify -m \"your message\"${NC}"
echo ""
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo ""

# Don't block here - let pre-commit run the actual checks
# The gate will be enforced by requiring AI_VERIFIED=1 for the final commit
# This approach allows AI to see the full report first

# If there are documentation warnings, block until verified
if [ ${#DOC_REMINDERS[@]} -gt 0 ]; then
    echo -e "${YELLOW}Documentation reminders detected. Please verify and use AI_VERIFIED=1${NC}"
    exit 1
fi

exit 0
