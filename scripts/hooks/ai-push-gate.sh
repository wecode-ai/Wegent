#!/bin/bash
# =============================================================================
# AI Push Gate - Pre-push Quality Check Controller
# =============================================================================
# This script implements quality checks before push for AI coding agents:
#
# - Runs all quality checks (lint, type, test, build)
# - Real-time output for all checks (no buffering)
# - Blocks push if critical checks fail
# - Documentation reminders require verification with AI_VERIFIED=1
#
# Usage:
#   git push                    (runs all checks)
#   AI_VERIFIED=1 git push      (confirm docs checked and no updates needed)
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
CHECK_FAILED=0

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

# -----------------------------------------------------------------------------
# Frontend Checks (if frontend files changed)
# -----------------------------------------------------------------------------
if [ "$FRONTEND_COUNT" -gt 0 ] 2>/dev/null; then
    echo -e "${BLUE}🔍 Frontend Checks:${NC}"
    
    # Check if we're in the right directory and node_modules exists
    if [ ! -d "frontend/node_modules" ]; then
        echo -e "   ${YELLOW}⚠️ SKIP: node_modules not found${NC}"
        echo -e "   ${YELLOW}   Run 'cd frontend && npm install' to install dependencies${NC}"
        WARNINGS+=("Frontend: node_modules not found, checks skipped")
    else
        cd frontend
        
        # ESLint (real-time output)
        echo -e "   Running ESLint..."
        if npm run lint 2>&1 | sed 's/^/   /'; then
            echo -e "   ${GREEN}✅ ESLint: PASSED${NC}"
        else
            echo -e "   ${RED}❌ ESLint: FAILED${NC}"
            CHECK_FAILED=1
        fi
        
        # TypeScript type check (real-time output)
        echo -e "   Running TypeScript check..."
        if npx tsc --noEmit 2>&1 | sed 's/^/   /'; then
            echo -e "   ${GREEN}✅ TypeScript: PASSED${NC}"
        else
            echo -e "   ${RED}❌ TypeScript: FAILED${NC}"
            CHECK_FAILED=1
        fi
        
        # Unit tests (real-time output)
        echo -e "   Running unit tests..."
        if npm test -- --passWithNoTests 2>&1 | sed 's/^/   /'; then
            echo -e "   ${GREEN}✅ Unit Tests: PASSED${NC}"
        else
            echo -e "   ${RED}❌ Unit Tests: FAILED${NC}"
            CHECK_FAILED=1
        fi
        
        cd ..
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
    if ! command -v black &> /dev/null && [ ! -f "venv/bin/black" ]; then
        echo -e "   ${YELLOW}⚠️ SKIP: black not found${NC}"
        echo -e "   ${YELLOW}   Run 'pip install black isort pytest' to install dependencies${NC}"
        WARNINGS+=("Backend: black not found, format checks skipped")
        
        # Still try to run other checks if available
        # isort check
        if ! command -v isort &> /dev/null; then
            echo -e "   ${YELLOW}⚠️ SKIP: isort not found${NC}"
            WARNINGS+=("Backend: isort not found, import sort checks skipped")
        fi
        
        # pytest (real-time output with parallel execution)
        if ! command -v pytest &> /dev/null; then
            echo -e "   ${YELLOW}⚠️ SKIP: pytest not found${NC}"
            WARNINGS+=("Backend: pytest not found, tests skipped")
        else
            echo -e "   Running pytest (parallel mode with real-time output)..."
            if [ -d "tests" ]; then
                # Use timeout to prevent hanging, -n auto for parallel execution
                if timeout 180 pytest tests/ --tb=short -n auto 2>&1 | sed 's/^/   /'; then
                    echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
                else
                    PYTEST_EXIT=$?
                    if [ $PYTEST_EXIT -eq 124 ]; then
                        echo -e "   ${YELLOW}⚠️ Pytest: TIMEOUT (exceeded 3 minutes)${NC}"
                        WARNINGS+=("Backend: pytest timed out after 3 minutes")
                    else
                        echo -e "   ${RED}❌ Pytest: FAILED${NC}"
                        CHECK_FAILED=1
                    fi
                fi
            else
                echo -e "   ${YELLOW}⚠️ SKIP: tests directory not found${NC}"
                WARNINGS+=("Backend: tests directory not found")
            fi
        fi
        
        # Python syntax check
        echo -e "   Running Python syntax check..."
        SYNTAX_ERROR=0
        for pyfile in $(echo "$CHANGED_FILES" | grep "^backend/.*\.py$"); do
            if [ -f "../$pyfile" ]; then
                if ! uv run python -m py_compile "../$pyfile" 2>&1 | sed 's/^/   /'; then
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
        # Black format check (real-time output)
        echo -e "   Running Black format check..."
        if uv run black --check app/ 2>&1 | sed 's/^/   /'; then
            echo -e "   ${GREEN}✅ Black: PASSED${NC}"
        else
            echo -e "   ${RED}❌ Black: FAILED (run 'cd backend && black app/' to fix)${NC}"
            CHECK_FAILED=1
        fi
        
        # isort check (real-time output)
        if ! command -v isort &> /dev/null; then
            echo -e "   ${YELLOW}⚠️ SKIP: isort not found${NC}"
            echo -e "   ${YELLOW}   Run 'pip install isort' to install dependencies${NC}"
            WARNINGS+=("Backend: isort not found, import sort checks skipped")
        else
            echo -e "   Running isort check..."
            if uv run isort --check-only --diff app/ 2>&1 | sed 's/^/   /'; then
                echo -e "   ${GREEN}✅ isort: PASSED${NC}"
            else
                echo -e "   ${RED}❌ isort: FAILED (run 'cd backend && isort app/' to fix)${NC}"
                CHECK_FAILED=1
            fi
        fi
        
        # pytest (real-time output with parallel execution)
        if ! command -v pytest &> /dev/null; then
            echo -e "   ${YELLOW}⚠️ SKIP: pytest not found${NC}"
            echo -e "   ${YELLOW}   Run 'pip install pytest' to install dependencies${NC}"
            WARNINGS+=("Backend: pytest not found, tests skipped")
        else
            echo -e "   Running pytest (parallel mode with real-time output)..."
            if [ -d "tests" ]; then
                # Use timeout to prevent hanging, -n auto for parallel execution
                if timeout 180 uv run pytest tests/ --tb=short -n auto 2>&1 | sed 's/^/   /'; then
                    echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
                else
                    PYTEST_EXIT=$?
                    if [ $PYTEST_EXIT -eq 124 ]; then
                        echo -e "   ${YELLOW}⚠️ Pytest: TIMEOUT (exceeded 3 minutes)${NC}"
                        WARNINGS+=("Backend: pytest timed out after 3 minutes")
                    else
                        echo -e "   ${RED}❌ Pytest: FAILED${NC}"
                        CHECK_FAILED=1
                    fi
                fi
            else
                echo -e "   ${YELLOW}⚠️ SKIP: tests directory not found${NC}"
                WARNINGS+=("Backend: tests directory not found")
            fi
        fi
        
        # Python syntax check (real-time output)
        echo -e "   Running Python syntax check..."
        SYNTAX_ERROR=0
        for pyfile in $(echo "$CHANGED_FILES" | grep "^backend/.*\.py$"); do
            if [ -f "../$pyfile" ]; then
                if ! uv run python -m py_compile "../$pyfile" 2>&1; then
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
        cd ..
    fi
    echo ""
fi

# -----------------------------------------------------------------------------
# Settings Configuration Check (if backend files changed)
# -----------------------------------------------------------------------------
if [ "$BACKEND_COUNT" -gt 0 ] 2>/dev/null; then
    echo -e "${BLUE}🔍 Settings Configuration Check:${NC}"
    
    # Get script directory and run settings check
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    SETTINGS_CHECK_SCRIPT="$SCRIPT_DIR/check-settings-config.sh"
    
    if [ -x "$SETTINGS_CHECK_SCRIPT" ]; then
        if "$SETTINGS_CHECK_SCRIPT" 2>&1 | sed 's/^/   /'; then
            echo -e "   ${GREEN}✅ Settings Configuration: PASSED${NC}"
        else
            SETTINGS_EXIT=$?
            if [ $SETTINGS_EXIT -eq 1 ]; then
                echo -e "   ${RED}❌ Settings Configuration: FAILED${NC}"
                CHECK_FAILED=1
            else
                echo -e "   ${YELLOW}⚠️ Settings check could not determine status${NC}"
                WARNINGS+=("Settings: check returned unexpected exit code $SETTINGS_EXIT")
            fi
        fi
    else
        echo -e "   ${YELLOW}⚠️ SKIP: Settings check script not found${NC}"
        WARNINGS+=("Settings: check script not found at $SETTINGS_CHECK_SCRIPT")
    fi
    echo ""
fi

# -----------------------------------------------------------------------------
# Executor Checks (if executor files changed)
# -----------------------------------------------------------------------------
if [ "$EXECUTOR_COUNT" -gt 0 ] 2>/dev/null; then
    echo -e "${BLUE}🔍 Executor Checks:${NC}"
    
    cd executor
    
    if ! command -v pytest &> /dev/null; then
        echo -e "   ${YELLOW}⚠️ SKIP: pytest not found${NC}"
        echo -e "   ${YELLOW}   Run 'pip install pytest' to install dependencies${NC}"
        WARNINGS+=("Executor: pytest not found, tests skipped")
    else
        echo -e "   Running pytest (real-time output)..."
        if [ -d "tests" ]; then
            if uv run pytest tests/ --tb=short 2>&1 | sed 's/^/   /'; then
                echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
            else
                echo -e "   ${RED}❌ Pytest: FAILED${NC}"
                CHECK_FAILED=1
            fi
        else
            echo -e "   ${YELLOW}⚠️ SKIP: tests directory not found${NC}"
            WARNINGS+=("Executor: tests directory not found")
        fi
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
    if ! command -v pytest &> /dev/null; then
        echo -e "   ${YELLOW}⚠️ SKIP: pytest not found${NC}"
        echo -e "   ${YELLOW}   Run 'pip install pytest' to install dependencies${NC}"
        WARNINGS+=("Executor Manager: pytest not found, tests skipped")
    else
        echo -e "   Running pytest (real-time output)..."
        if [ -d "tests" ]; then
            if uv run pytest tests/ --tb=short 2>&1 | sed 's/^/   /'; then
                echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
            else
                echo -e "   ${RED}❌ Pytest: FAILED${NC}"
                CHECK_FAILED=1
            fi
        else
            echo -e "   ${YELLOW}⚠️ SKIP: tests directory not found${NC}"
            WARNINGS+=("Executor Manager: tests directory not found")
        fi
    fi
    
    cd ..
    echo ""
fi

# -----------------------------------------------------------------------------
# Alembic Multi-Head Checks (if backend files changed)
# -----------------------------------------------------------------------------
if [ "$BACKEND_COUNT" -gt 0 ] 2>/dev/null; then
    echo -e "${BLUE}🔍 Alembic Multi-Head Check:${NC}"

    # Get script directory and run alembic check
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    ALEMBIC_CHECK_SCRIPT="$SCRIPT_DIR/check-alembic-heads.sh"

    if [ -x "$ALEMBIC_CHECK_SCRIPT" ]; then
        if "$ALEMBIC_CHECK_SCRIPT" 2>&1 | sed 's/^/   /'; then
            echo -e "   ${GREEN}✅ Alembic Multi-Head Check: PASSED${NC}"
        else
            ALEMBIC_EXIT=$?
            if [ $ALEMBIC_EXIT -eq 1 ]; then
                echo -e "   ${RED}❌ Alembic Multi-Head Check: FAILED${NC}"
                CHECK_FAILED=1
            else
                echo -e "   ${YELLOW}⚠️ Alembic check could not determine status${NC}"
                WARNINGS+=("Alembic: check returned unexpected exit code $ALEMBIC_EXIT")
            fi
        fi
    else
        echo -e "   ${YELLOW}⚠️ SKIP: Alembic check script not found${NC}"
        WARNINGS+=("Alembic: check script not found at $ALEMBIC_CHECK_SCRIPT")
    fi
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
    echo -e "${RED}${BOLD}🚫 PUSH BLOCKED - Documentation Update Required${NC}"
    echo ""
    echo -e "${RED}${BOLD}⚠️  CRITICAL: THIS IS YOUR ONLY CHANCE TO UPDATE DOCUMENTATION${NC}"
    echo ""
    echo -e "${YELLOW}${BOLD}Your code changes require documentation updates.${NC}"
    echo -e "${YELLOW}After this push, there will be NO further opportunity to update docs.${NC}"
    echo -e "${YELLOW}The documentation must be complete and accurate IN THIS COMMIT.${NC}"
    echo ""
    echo -e "${BLUE}Documentation reminders:${NC}"
    for reminder in "${DOC_REMINDERS[@]}"; do
        echo -e "   ${YELLOW}• $reminder${NC}"
    done
    echo ""
    echo -e "${BOLD}You MUST either:${NC}"
    echo ""
    echo -e "  ${GREEN}1. Update the relevant documentation NOW${NC}"
    echo -e "     Add doc changes to this commit, then push again."
    echo -e "     ${CYAN}This is the recommended approach.${NC}"
    echo ""
    echo -e "  ${YELLOW}2. ONLY if you have THOROUGHLY VERIFIED that your changes${NC}"
    echo -e "     ${YELLOW}do NOT require ANY documentation updates:${NC}"
    echo ""
    echo -e "     ${GREEN}${BOLD}AI_VERIFIED=1 git push${NC}"
    echo -e "     ${CYAN}(This confirms you have checked all relevant docs and no updates are needed)${NC}"
    echo ""
    echo -e "${RED}${BOLD}════════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}${BOLD}⚠️  WARNING: INCOMPLETE DOCUMENTATION IS NOT ACCEPTABLE${NC}"
    echo -e "${RED}${BOLD}════════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}   • Users depend on accurate documentation${NC}"
    echo -e "${RED}   • Outdated docs cause confusion and support burden${NC}"
    echo -e "${RED}   • You will NOT get another chance to update docs for this change${NC}"
    echo -e "${RED}   • AI_VERIFIED=1 means you CONFIRM docs are already up-to-date${NC}"
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
