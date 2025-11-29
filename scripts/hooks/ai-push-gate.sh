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

# Don't exit on error - we want to run all checks and report at the end
set +e

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Get the commits being pushed
# When run by pre-commit, stdin may not be available, so we detect changes differently
get_changed_files() {
    local files=""

    # Try to read from stdin first (direct pre-push hook provides ref info)
    if ! [ -t 0 ]; then
        # stdin is available (piped), try to read pre-push hook format
        while read local_ref local_sha remote_ref remote_sha 2>/dev/null; do
            if [ -n "$local_sha" ] && [ "$local_sha" != "0000000000000000000000000000000000000000" ]; then
                if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
                    # New branch, compare with default branch
                    files=$(git diff --name-only "origin/main...$local_sha" 2>/dev/null || true)
                else
                    # Existing branch, compare with remote
                    files=$(git diff --name-only "$remote_sha...$local_sha" 2>/dev/null || true)
                fi
                if [ -n "$files" ]; then
                    echo "$files"
                    return
                fi
            fi
        done
    fi

    # Fallback: Compare current branch with its upstream or origin/main
    local upstream=$(git rev-parse --abbrev-ref "@{upstream}" 2>/dev/null || echo "origin/main")
    files=$(git diff --name-only "$upstream"...HEAD 2>/dev/null || true)

    if [ -n "$files" ]; then
        echo "$files"
        return
    fi

    # Last resort: compare with last commit
    git diff --name-only HEAD~1 HEAD 2>/dev/null || true
}

# Get list of changed files in the commits being pushed
CHANGED_FILES=$(get_changed_files)

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
BACKEND_COUNT=$(echo "$CHANGED_FILES" | grep -c "^backend/" 2>/dev/null || echo 0)
FRONTEND_COUNT=$(echo "$CHANGED_FILES" | grep -c "^frontend/" 2>/dev/null || echo 0)
EXECUTOR_COUNT=$(echo "$CHANGED_FILES" | grep -c "^executor/" 2>/dev/null || echo 0)
EXECUTOR_MGR_COUNT=$(echo "$CHANGED_FILES" | grep -c "^executor_manager/" 2>/dev/null || echo 0)
SHARED_COUNT=$(echo "$CHANGED_FILES" | grep -c "^shared/" 2>/dev/null || echo 0)
OTHER_COUNT=$(echo "$CHANGED_FILES" | grep -cvE "^(backend|frontend|executor|executor_manager|shared)/" 2>/dev/null || echo 0)

echo -e "   ${BLUE}Modules affected:${NC}"
[ "$BACKEND_COUNT" -gt 0 ] 2>/dev/null && echo -e "   - Backend: $BACKEND_COUNT file(s)"
[ "$FRONTEND_COUNT" -gt 0 ] 2>/dev/null && echo -e "   - Frontend: $FRONTEND_COUNT file(s)"
[ "$EXECUTOR_COUNT" -gt 0 ] 2>/dev/null && echo -e "   - Executor: $EXECUTOR_COUNT file(s)"
[ "$EXECUTOR_MGR_COUNT" -gt 0 ] 2>/dev/null && echo -e "   - Executor Manager: $EXECUTOR_MGR_COUNT file(s)"
[ "$SHARED_COUNT" -gt 0 ] 2>/dev/null && echo -e "   - Shared: $SHARED_COUNT file(s)"
[ "$OTHER_COUNT" -gt 0 ] 2>/dev/null && echo -e "   - Other: $OTHER_COUNT file(s)"
echo ""

# -----------------------------------------------------------------------------
# Check: Documentation reminders
# -----------------------------------------------------------------------------
echo -e "${BLUE}📝 Documentation Check:${NC}"

# Backend API/Services changed → User guides (creating-bots, creating-teams, etc.)
BACKEND_API=$(echo "$CHANGED_FILES" | grep -E "^backend/app/(api|services)/.*\.py$" || true)
if [ -n "$BACKEND_API" ]; then
    DOC_REMINDERS+=("Backend API/Services changed → Check docs/*/guides/user/ for user guide updates")
fi

# Backend Models/Schemas changed → YAML specification reference
BACKEND_MODELS=$(echo "$CHANGED_FILES" | grep -E "^backend/app/(models|schemas)/.*\.py$" || true)
if [ -n "$BACKEND_MODELS" ]; then
    DOC_REMINDERS+=("Backend Models/Schemas changed → Check docs/*/reference/yaml-specification.md")
fi

# Executor/Agent changed → Architecture and concepts docs
EXECUTOR_CODE=$(echo "$CHANGED_FILES" | grep -E "^executor/.*\.py$" || true)
if [ -n "$EXECUTOR_CODE" ]; then
    DOC_REMINDERS+=("Executor changed → Check docs/*/concepts/architecture.md")
fi

# Project config changed → Getting started and installation docs
CONFIG_FILES=$(echo "$CHANGED_FILES" | grep -E "(docker-compose|Dockerfile|requirements\.txt|package\.json)" || true)
if [ -n "$CONFIG_FILES" ]; then
    DOC_REMINDERS+=("Project config changed → Check docs/*/getting-started/ for installation/setup updates")
fi

# Any code change → Consider updating AGENTS.md and README
ANY_CODE=$(echo "$CHANGED_FILES" | grep -E "^(backend|frontend|executor|executor_manager|shared)/.*\.(py|ts|tsx)$" || true)
if [ -n "$ANY_CODE" ]; then
    DOC_REMINDERS+=("Code changed → Consider updating AGENTS.md and README.md/README_zh.md if needed")
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
# Run Quality Checks
# -----------------------------------------------------------------------------
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}📊 Running Quality Checks${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo ""

# Track overall check status
CHECK_FAILED=0

# -----------------------------------------------------------------------------
# Frontend Checks (if frontend files changed)
# -----------------------------------------------------------------------------
if [ "$FRONTEND_COUNT" -gt 0 ] 2>/dev/null; then
    echo -e "${BLUE}🔍 Frontend Checks:${NC}"
    
    # Check if we're in the right directory and node_modules exists
    if [ -d "frontend/node_modules" ]; then
        cd frontend
        
        # ESLint
        echo -e "   Running ESLint..."
        if npm run lint --silent 2>/dev/null; then
            echo -e "   ${GREEN}✅ ESLint: PASSED${NC}"
        else
            echo -e "   ${RED}❌ ESLint: FAILED${NC}"
            CHECK_FAILED=1
        fi
        
        # TypeScript type check (using next build --dry-run or tsc if available)
        echo -e "   Running TypeScript check..."
        if npx tsc --noEmit 2>/dev/null; then
            echo -e "   ${GREEN}✅ TypeScript: PASSED${NC}"
        else
            echo -e "   ${RED}❌ TypeScript: FAILED${NC}"
            CHECK_FAILED=1
        fi
        
        # Unit tests
        echo -e "   Running unit tests..."
        if npm test -- --passWithNoTests --silent 2>/dev/null; then
            echo -e "   ${GREEN}✅ Unit Tests: PASSED${NC}"
        else
            echo -e "   ${RED}❌ Unit Tests: FAILED${NC}"
            CHECK_FAILED=1
        fi
        
        # Build check
        echo -e "   Running build check..."
        if npm run build 2>/dev/null; then
            echo -e "   ${GREEN}✅ Build: PASSED${NC}"
        else
            echo -e "   ${RED}❌ Build: FAILED${NC}"
            CHECK_FAILED=1
        fi
        
        cd ..
    else
        echo -e "   ${YELLOW}⚠️ Skipping frontend checks (node_modules not found)${NC}"
        echo -e "   ${YELLOW}   Run 'cd frontend && npm install' to enable checks${NC}"
    fi
    echo ""
fi

# -----------------------------------------------------------------------------
# Backend Checks (if backend files changed)
# -----------------------------------------------------------------------------
if [ "$BACKEND_COUNT" -gt 0 ] 2>/dev/null; then
    echo -e "${BLUE}🔍 Backend Checks:${NC}"
    
    cd backend
    
    # Check if virtual environment or Python packages are available
    if command -v black &> /dev/null || [ -f "venv/bin/black" ]; then
        # Black format check
        echo -e "   Running Black format check..."
        if black --check app/ 2>/dev/null; then
            echo -e "   ${GREEN}✅ Black: PASSED${NC}"
        else
            echo -e "   ${RED}❌ Black: FAILED (run 'black app/' to fix)${NC}"
            CHECK_FAILED=1
        fi
        
        # isort check
        echo -e "   Running isort check..."
        if isort --check-only app/ 2>/dev/null; then
            echo -e "   ${GREEN}✅ isort: PASSED${NC}"
        else
            echo -e "   ${RED}❌ isort: FAILED (run 'isort app/' to fix)${NC}"
            CHECK_FAILED=1
        fi
        
        # pytest
        echo -e "   Running pytest..."
        if pytest tests/ --tb=short -q 2>/dev/null; then
            echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
        else
            # Check if tests directory exists
            if [ -d "tests" ]; then
                echo -e "   ${RED}❌ Pytest: FAILED${NC}"
                CHECK_FAILED=1
            else
                echo -e "   ${YELLOW}⚠️ Pytest: SKIPPED (no tests directory)${NC}"
            fi
        fi
        
        # Python syntax check
        echo -e "   Running Python syntax check..."
        SYNTAX_ERROR=0
        for pyfile in $(echo "$CHANGED_FILES" | grep "^backend/.*\.py$"); do
            if [ -f "../$pyfile" ]; then
                if ! python -m py_compile "../$pyfile" 2>/dev/null; then
                    echo -e "   ${RED}   Syntax error in: $pyfile${NC}"
                    SYNTAX_ERROR=1
                fi
            fi
        done
        if [ $SYNTAX_ERROR -eq 0 ]; then
            echo -e "   ${GREEN}✅ Syntax Check: PASSED${NC}"
        else
            echo -e "   ${RED}❌ Syntax Check: FAILED${NC}"
            CHECK_FAILED=1
        fi
    else
        echo -e "   ${YELLOW}⚠️ Skipping backend checks (black/isort not found)${NC}"
        echo -e "   ${YELLOW}   Run 'pip install black isort pytest' to enable checks${NC}"
    fi
    
    cd ..
    echo ""
fi

# -----------------------------------------------------------------------------
# Executor Checks (if executor files changed)
# -----------------------------------------------------------------------------
if [ "$EXECUTOR_COUNT" -gt 0 ] 2>/dev/null; then
    echo -e "${BLUE}🔍 Executor Checks:${NC}"
    
    cd executor
    
    if command -v pytest &> /dev/null; then
        echo -e "   Running pytest..."
        if pytest tests/ --tb=short -q 2>/dev/null; then
            echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
        else
            if [ -d "tests" ]; then
                echo -e "   ${RED}❌ Pytest: FAILED${NC}"
                CHECK_FAILED=1
            else
                echo -e "   ${YELLOW}⚠️ Pytest: SKIPPED (no tests directory)${NC}"
            fi
        fi
    else
        echo -e "   ${YELLOW}⚠️ Skipping executor checks (pytest not found)${NC}"
    fi
    
    cd ..
    echo ""
fi

# -----------------------------------------------------------------------------
# Executor Manager Checks (if executor_manager files changed)
# -----------------------------------------------------------------------------
if [ "$EXECUTOR_MGR_COUNT" -gt 0 ] 2>/dev/null; then
    echo -e "${BLUE}🔍 Executor Manager Checks:${NC}"
    
    cd executor_manager
    
    if command -v pytest &> /dev/null; then
        echo -e "   Running pytest..."
        if pytest tests/ --tb=short -q 2>/dev/null; then
            echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
        else
            if [ -d "tests" ]; then
                echo -e "   ${RED}❌ Pytest: FAILED${NC}"
                CHECK_FAILED=1
            else
                echo -e "   ${YELLOW}⚠️ Pytest: SKIPPED (no tests directory)${NC}"
            fi
        fi
    else
        echo -e "   ${YELLOW}⚠️ Skipping executor_manager checks (pytest not found)${NC}"
    fi
    
    cd ..
    echo ""
fi

# -----------------------------------------------------------------------------
# Check Results Summary
# -----------------------------------------------------------------------------
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}📊 Check Results Summary${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo ""

if [ $CHECK_FAILED -eq 1 ]; then
    echo -e "${RED}${BOLD}❌ Some checks failed. Please fix the issues above before pushing.${NC}"
    echo ""
    echo -e "To skip all pre-push checks (not recommended):"
    echo -e "    ${YELLOW}git push --no-verify${NC}"
    echo ""
    exit 1
fi

echo -e "${GREEN}✅ All quality checks passed!${NC}"
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
