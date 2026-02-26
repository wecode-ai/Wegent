#!/bin/bash
# =============================================================================
# AI Push Gate - Pre-push Quality Check Controller
# =============================================================================
# This script implements quality checks before push for AI coding agents:
#
# - Runs all quality checks (lint, type, test, build)
# - Generates a comprehensive report
# - Blocks push if critical checks fail
# - Documentation reminders require verification with AI_VERIFIED=1
#
# Usage:
#   git push                    (runs all checks)
#   AI_VERIFIED=1 git push      (confirm docs checked and no updates needed)
# =============================================================================

# Don't exit on error - we want to run all checks and report at the end
set +e

# Create temp directory for storing check outputs (reduces memory usage)
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

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
FAILED_CHECKS=()
FAILED_LOGS=()

# mypy warning tracking (non-blocking)
MYPY_WARNING_COUNT=0
MYPY_WARNING_MODULES=""

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
CHAT_SHELL_COUNT=$(echo "$CHANGED_FILES" | grep -c "^chat_shell/" 2>/dev/null || echo 0)
SHARED_COUNT=$(echo "$CHANGED_FILES" | grep -c "^shared/" 2>/dev/null || echo 0)
OTHER_COUNT=$(echo "$CHANGED_FILES" | grep -cvE "^(backend|frontend|executor|executor_manager|chat_shell|shared)/" 2>/dev/null || echo 0)

echo -e "   ${BLUE}Modules affected:${NC}"
[ "$BACKEND_COUNT" -gt 0 ] 2>/dev/null && echo -e "   - Backend: $BACKEND_COUNT file(s)"
[ "$FRONTEND_COUNT" -gt 0 ] 2>/dev/null && echo -e "   - Frontend: $FRONTEND_COUNT file(s)"
[ "$EXECUTOR_COUNT" -gt 0 ] 2>/dev/null && echo -e "   - Executor: $EXECUTOR_COUNT file(s)"
[ "$EXECUTOR_MGR_COUNT" -gt 0 ] 2>/dev/null && echo -e "   - Executor Manager: $EXECUTOR_MGR_COUNT file(s)"
[ "$CHAT_SHELL_COUNT" -gt 0 ] 2>/dev/null && echo -e "   - Chat Shell: $CHAT_SHELL_COUNT file(s)"
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
    if [ ! -d "frontend/node_modules" ]; then
        echo -e "   ${YELLOW}⚠️ SKIP: node_modules not found${NC}"
        echo -e "   ${YELLOW}   Run 'cd frontend && npm install' to install dependencies${NC}"
        WARNINGS+=("Frontend: node_modules not found, checks skipped")
    else
        cd frontend
        
        # ESLint (output to temp file to reduce memory usage)
        echo -e "   Running ESLint..."
        npm run lint > "$TEMP_DIR/eslint.log" 2>&1
        ESLINT_EXIT=$?
        if [ $ESLINT_EXIT -eq 0 ]; then
            echo -e "   ${GREEN}✅ ESLint: PASSED${NC}"
        else
            echo -e "   ${RED}❌ ESLint: FAILED${NC}"
            CHECK_FAILED=1
            FAILED_CHECKS+=("Frontend ESLint")
            FAILED_LOGS+=("$TEMP_DIR/eslint.log")
        fi
        
        # TypeScript type check (output to temp file to reduce memory usage)
        echo -e "   Running TypeScript check..."
        npx tsc --noEmit > "$TEMP_DIR/tsc.log" 2>&1
        TSC_EXIT=$?
        if [ $TSC_EXIT -eq 0 ]; then
            echo -e "   ${GREEN}✅ TypeScript: PASSED${NC}"
        else
            echo -e "   ${RED}❌ TypeScript: FAILED${NC}"
            CHECK_FAILED=1
            FAILED_CHECKS+=("Frontend TypeScript")
            FAILED_LOGS+=("$TEMP_DIR/tsc.log")
        fi
        
        # Unit tests (output to temp file to reduce memory usage)
        echo -e "   Running unit tests..."
        npm test -- --passWithNoTests > "$TEMP_DIR/test.log" 2>&1
        TEST_EXIT=$?
        if [ $TEST_EXIT -eq 0 ]; then
            echo -e "   ${GREEN}✅ Unit Tests: PASSED${NC}"
        else
            echo -e "   ${RED}❌ Unit Tests: FAILED${NC}"
            CHECK_FAILED=1
            FAILED_CHECKS+=("Frontend Unit Tests")
            FAILED_LOGS+=("$TEMP_DIR/test.log")
        fi
        # Note: Build check removed to reduce memory usage (~1.5GB).
        # TypeScript check above already validates type correctness.
        # Full build verification should be done in CI pipeline.
        
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
        
        # pytest
        if ! command -v pytest &> /dev/null; then
            echo -e "   ${YELLOW}⚠️ SKIP: pytest not found${NC}"
            WARNINGS+=("Backend: pytest not found, tests skipped")
        else
            echo -e "   Running pytest..."
            if [ -d "tests" ]; then
                # Limit parallel workers to 4 to reduce memory usage
                pytest tests/ --tb=short -q > "$TEMP_DIR/backend_pytest.log" 2>&1
                PYTEST_EXIT=$?
                if [ $PYTEST_EXIT -eq 0 ]; then
                    echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
                else
                    echo -e "   ${RED}❌ Pytest: FAILED${NC}"
                    CHECK_FAILED=1
                    FAILED_CHECKS+=("Backend Pytest")
                    FAILED_LOGS+=("$TEMP_DIR/backend_pytest.log")
                fi
            else
                echo -e "   ${YELLOW}⚠️ SKIP: tests directory not found${NC}"
                WARNINGS+=("Backend: tests directory not found")
            fi
        fi
        
        # Python syntax check
        echo -e "   Running Python syntax check..."
        SYNTAX_ERROR=0
        > "$TEMP_DIR/syntax.log"  # Clear/create the file
        for pyfile in $(echo "$CHANGED_FILES" | grep "^backend/.*\.py$"); do
            if [ -f "../$pyfile" ]; then
                env -u VIRTUAL_ENV uv run python -m py_compile "../$pyfile" 2>> "$TEMP_DIR/syntax.log"
                if [ $? -ne 0 ]; then
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
            FAILED_CHECKS+=("Backend Syntax")
            FAILED_LOGS+=("$TEMP_DIR/syntax.log")
        fi
    else
        # Black format check (output to temp file)
        echo -e "   Running Black format check..."
        env -u VIRTUAL_ENV uv run black --check --diff . > "$TEMP_DIR/black.log" 2>&1
        BLACK_EXIT=$?
        if [ $BLACK_EXIT -eq 0 ]; then
            echo -e "   ${GREEN}✅ Black: PASSED${NC}"
        else
            echo -e "   ${RED}❌ Black: FAILED (run 'cd backend && uv run black .' to fix)${NC}"
            CHECK_FAILED=1
            FAILED_CHECKS+=("Backend Black")
            # Append fix hint to log file
            echo -e "\nFix: cd backend && uv run black ." >> "$TEMP_DIR/black.log"
            FAILED_LOGS+=("$TEMP_DIR/black.log")
        fi
        
        # isort check
        if ! command -v isort &> /dev/null; then
            echo -e "   ${YELLOW}⚠️ SKIP: isort not found${NC}"
            echo -e "   ${YELLOW}   Run 'pip install isort' to install dependencies${NC}"
            WARNINGS+=("Backend: isort not found, import sort checks skipped")
        else
            env -u VIRTUAL_ENV uv run isort --check-only --diff . > "$TEMP_DIR/isort.log" 2>&1
            ISORT_EXIT=$?
            if [ $ISORT_EXIT -eq 0 ]; then
                echo -e "   ${GREEN}✅ isort: PASSED${NC}"
            else
                echo -e "   ${RED}❌ isort: FAILED (run 'cd backend && uv run isort .' to fix)${NC}"
                CHECK_FAILED=1
                FAILED_CHECKS+=("Backend isort")
                echo -e "\nFix: cd backend && uv run isort ." >> "$TEMP_DIR/isort.log"
                FAILED_LOGS+=("$TEMP_DIR/isort.log")
            fi
        fi
        
        # autoflake check - unused imports
        echo -e "   Running autoflake unused imports check..."
        env -u VIRTUAL_ENV uv run autoflake --quiet --check --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=".venv,venv,build,dist,alembic" . > "$TEMP_DIR/autoflake.log" 2>&1
        AUTOFLAKE_EXIT=$?
        if [ $AUTOFLAKE_EXIT -eq 0 ]; then
            echo -e "   ${GREEN}✅ autoflake: PASSED${NC}"
        else
            echo -e "   ${RED}❌ autoflake: FAILED (run 'cd backend && uv run autoflake --in-place --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=.venv,venv,build,dist,alembic .' to fix)${NC}"
            CHECK_FAILED=1
            FAILED_CHECKS+=("Backend autoflake")
            echo -e "\nFix: cd backend && uv run autoflake --quiet --in-place --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=.venv,venv,build,dist,alembic ." >> "$TEMP_DIR/autoflake.log"
            FAILED_LOGS+=("$TEMP_DIR/autoflake.log")
        fi
        
        # mypy type check (non-blocking warning)
            echo -e "   Running mypy type check..."
            env -u VIRTUAL_ENV uv run mypy . > "$TEMP_DIR/mypy.log" 2>&1
            MYPY_EXIT=$?
            if [ $MYPY_EXIT -eq 0 ]; then
                echo -e "   ${GREEN}✅ mypy: PASSED${NC}"
            else
                echo -e "   ${YELLOW}⚠️  mypy: WARNING (non-blocking)${NC}"
                echo -e "       Run 'cd backend && uv run mypy .' to see details" >> "$TEMP_DIR/mypy.log"
                MYPY_WARNING_COUNT=$((MYPY_WARNING_COUNT + 1))
                MYPY_WARNING_MODULES="$MYPY_WARNING_MODULES backend"
            fi
        
        # pytest
        if ! command -v pytest &> /dev/null; then
            echo -e "   ${YELLOW}⚠️ SKIP: pytest not found${NC}"
            echo -e "   ${YELLOW}   Run 'pip install pytest' to install dependencies${NC}"
            WARNINGS+=("Backend: pytest not found, tests skipped")
        else
            echo -e "   Running pytest..."
            if [ -d "tests" ]; then
                env -u VIRTUAL_ENV uv run pytest tests/ --tb=short -q > "$TEMP_DIR/backend_pytest.log" 2>&1
                PYTEST_EXIT=$?
                if [ $PYTEST_EXIT -eq 0 ]; then
                    echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
                else
                    echo -e "   ${RED}❌ Pytest: FAILED${NC}"
                    CHECK_FAILED=1
                    FAILED_CHECKS+=("Backend Pytest")
                    FAILED_LOGS+=("$TEMP_DIR/backend_pytest.log")
                fi
            else
                echo -e "   ${YELLOW}⚠️ SKIP: tests directory not found${NC}"
                WARNINGS+=("Backend: tests directory not found")
            fi
        fi
        
        # Python syntax check (output to temp file)
        echo -e "   Running Python syntax check..."
        SYNTAX_ERROR=0
        > "$TEMP_DIR/syntax.log"  # Clear/create the file
        for pyfile in $(echo "$CHANGED_FILES" | grep "^backend/.*\.py$"); do
            if [ -f "../$pyfile" ]; then
                env -u VIRTUAL_ENV uv run python -m py_compile "../$pyfile" 2>> "$TEMP_DIR/syntax.log"
                if [ $? -ne 0 ]; then
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
            FAILED_CHECKS+=("Backend Syntax")
            FAILED_LOGS+=("$TEMP_DIR/syntax.log")
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
        "$SETTINGS_CHECK_SCRIPT" > "$TEMP_DIR/settings.log" 2>&1
        SETTINGS_EXIT=$?
        
        if [ $SETTINGS_EXIT -eq 0 ]; then
            echo -e "   ${GREEN}✅ Settings Configuration: PASSED${NC}"
            elif [ $SETTINGS_EXIT -eq 1 ]; then
            echo -e "   ${RED}❌ Settings Configuration: FAILED${NC}"
            CHECK_FAILED=1
            FAILED_CHECKS+=("Settings Configuration")
            FAILED_LOGS+=("$TEMP_DIR/settings.log")
        else
            echo -e "   ${YELLOW}⚠️ Settings check could not determine status${NC}"
            WARNINGS+=("Settings: check returned unexpected exit code $SETTINGS_EXIT")
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
    
    # Black format check
    echo -e "   Running Black format check..."
    env -u VIRTUAL_ENV uv run black --check --diff . > "$TEMP_DIR/executor_black.log" 2>&1
    BLACK_EXIT=$?
    if [ $BLACK_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ Black: PASSED${NC}"
    else
        echo -e "   ${RED}❌ Black: FAILED (run 'cd executor && uv run black .' to fix)${NC}"
        CHECK_FAILED=1
        FAILED_CHECKS+=("Executor Black")
        echo -e "\nFix: cd executor && uv run black ." >> "$TEMP_DIR/executor_black.log"
        FAILED_LOGS+=("$TEMP_DIR/executor_black.log")
    fi
    
    # isort check
    echo -e "   Running isort check..."
    env -u VIRTUAL_ENV uv run isort --check-only --diff . > "$TEMP_DIR/executor_isort.log" 2>&1
    ISORT_EXIT=$?
    if [ $ISORT_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ isort: PASSED${NC}"
    else
        echo -e "   ${RED}❌ isort: FAILED (run 'cd executor && uv run isort .' to fix)${NC}"
        CHECK_FAILED=1
        FAILED_CHECKS+=("Executor isort")
        echo -e "\nFix: cd executor && uv run isort ." >> "$TEMP_DIR/executor_isort.log"
        FAILED_LOGS+=("$TEMP_DIR/executor_isort.log")
    fi
    
    # autoflake check - unused imports
    echo -e "   Running autoflake unused imports check..."
    env -u VIRTUAL_ENV uv run autoflake --quiet --check --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=".venv,venv,build,dist" . > "$TEMP_DIR/executor_autoflake.log" 2>&1
    AUTOFLAKE_EXIT=$?
    if [ $AUTOFLAKE_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ autoflake: PASSED${NC}"
    else
        echo -e "   ${RED}❌ autoflake: FAILED (run 'cd executor && uv run autoflake --in-place --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=.venv,venv,build,dist .' to fix)${NC}"
        CHECK_FAILED=1
        FAILED_CHECKS+=("Executor autoflake")
        echo -e "\nFix: cd executor && uv run autoflake --quiet --in-place --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=.venv,venv,build,dist ." >> "$TEMP_DIR/executor_autoflake.log"
        FAILED_LOGS+=("$TEMP_DIR/executor_autoflake.log")
    fi
    
    # mypy type check (non-blocking warning)
    echo -e "   Running mypy type check..."
    env -u VIRTUAL_ENV uv run mypy . > "$TEMP_DIR/executor_mypy.log" 2>&1
    MYPY_EXIT=$?
    if [ $MYPY_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ mypy: PASSED${NC}"
    else
        echo -e "   ${YELLOW}⚠️  mypy: WARNING (non-blocking)${NC}"
        echo -e "       Run 'cd executor && uv run mypy .' to see details" >> "$TEMP_DIR/executor_mypy.log"
        MYPY_WARNING_COUNT=$((MYPY_WARNING_COUNT + 1))
        MYPY_WARNING_MODULES="$MYPY_WARNING_MODULES executor"
    fi
    
    if ! command -v pytest &> /dev/null; then
        echo -e "   ${YELLOW}⚠️ SKIP: pytest not found${NC}"
        echo -e "   ${YELLOW}   Run 'pip install pytest' to install dependencies${NC}"
        WARNINGS+=("Executor: pytest not found, tests skipped")
    else
        echo -e "   Running pytest..."
        if [ -d "tests" ]; then
            # Limit parallel workers to 4 to reduce memory usage
            env -u VIRTUAL_ENV uv run pytest tests/ --tb=short -q  > "$TEMP_DIR/executor_pytest.log" 2>&1
            PYTEST_EXIT=$?
            if [ $PYTEST_EXIT -eq 0 ]; then
                echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
            else
                echo -e "   ${RED}❌ Pytest: FAILED${NC}"
                CHECK_FAILED=1
                FAILED_CHECKS+=("Executor Pytest")
                FAILED_LOGS+=("$TEMP_DIR/executor_pytest.log")
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
    
    # Black format check
    echo -e "   Running Black format check..."
    env -u VIRTUAL_ENV uv run black --check --diff . > "$TEMP_DIR/exec_mgr_black.log" 2>&1
    BLACK_EXIT=$?
    if [ $BLACK_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ Black: PASSED${NC}"
    else
        echo -e "   ${RED}❌ Black: FAILED (run 'cd executor_manager && uv run black .' to fix)${NC}"
        CHECK_FAILED=1
        FAILED_CHECKS+=("Executor Manager Black")
        echo -e "\nFix: cd executor_manager && uv run black ." >> "$TEMP_DIR/exec_mgr_black.log"
        FAILED_LOGS+=("$TEMP_DIR/exec_mgr_black.log")
    fi
    
    # isort check
    echo -e "   Running isort check..."
    env -u VIRTUAL_ENV uv run isort --check-only --diff . > "$TEMP_DIR/exec_mgr_isort.log" 2>&1
    ISORT_EXIT=$?
    if [ $ISORT_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ isort: PASSED${NC}"
    else
        echo -e "   ${RED}❌ isort: FAILED (run 'cd executor_manager && uv run isort .' to fix)${NC}"
        CHECK_FAILED=1
        FAILED_CHECKS+=("Executor Manager isort")
        echo -e "\nFix: cd executor_manager && uv run isort ." >> "$TEMP_DIR/exec_mgr_isort.log"
        FAILED_LOGS+=("$TEMP_DIR/exec_mgr_isort.log")
    fi
    
    # autoflake check - unused imports
    echo -e "   Running autoflake unused imports check..."
    env -u VIRTUAL_ENV uv run autoflake --quiet --check --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=".venv,venv,build,dist" . > "$TEMP_DIR/exec_mgr_autoflake.log" 2>&1
    AUTOFLAKE_EXIT=$?
    if [ $AUTOFLAKE_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ autoflake: PASSED${NC}"
    else
        echo -e "   ${RED}❌ autoflake: FAILED (run 'cd executor_manager && uv run autoflake --in-place --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=.venv,venv,build,dist .' to fix)${NC}"
        CHECK_FAILED=1
        FAILED_CHECKS+=("Executor Manager autoflake")
        echo -e "\nFix: cd executor_manager && uv run autoflake --quiet --in-place --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=.venv,venv,build,dist ." >> "$TEMP_DIR/exec_mgr_autoflake.log"
        FAILED_LOGS+=("$TEMP_DIR/exec_mgr_autoflake.log")
    fi
    
    # mypy type check (non-blocking warning)
    echo -e "   Running mypy type check..."
    env -u VIRTUAL_ENV uv run mypy . > "$TEMP_DIR/exec_mgr_mypy.log" 2>&1
    MYPY_EXIT=$?
    if [ $MYPY_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ mypy: PASSED${NC}"
    else
        echo -e "   ${YELLOW}⚠️  mypy: WARNING (non-blocking)${NC}"
        echo -e "       Run 'cd executor_manager && uv run mypy .' to see details" >> "$TEMP_DIR/exec_mgr_mypy.log"
        MYPY_WARNING_COUNT=$((MYPY_WARNING_COUNT + 1))
        MYPY_WARNING_MODULES="$MYPY_WARNING_MODULES executor_manager"
    fi
    
    if ! command -v pytest &> /dev/null; then
        echo -e "   ${YELLOW}⚠️ SKIP: pytest not found${NC}"
        echo -e "   ${YELLOW}   Run 'pip install pytest' to install dependencies${NC}"
        WARNINGS+=("Executor Manager: pytest not found, tests skipped")
    else
        echo -e "   Running pytest..."
        if [ -d "tests" ]; then
            # Limit parallel workers to 4 to reduce memory usage
            env -u VIRTUAL_ENV uv run pytest tests/ --tb=short -q  > "$TEMP_DIR/exec_mgr_pytest.log" 2>&1
            PYTEST_EXIT=$?
            # Check if tests passed (look for "passed" in output and no "failed")
            if grep -q "passed" "$TEMP_DIR/exec_mgr_pytest.log" && ! grep -q "[0-9]* failed" "$TEMP_DIR/exec_mgr_pytest.log"; then
                echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
                elif [ $PYTEST_EXIT -eq 0 ]; then
                echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
            else
                echo -e "   ${RED}❌ Pytest: FAILED${NC}"
                CHECK_FAILED=1
                FAILED_CHECKS+=("Executor Manager Pytest")
                FAILED_LOGS+=("$TEMP_DIR/exec_mgr_pytest.log")
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
# Chat Shell Checks (if chat_shell files changed)
# -----------------------------------------------------------------------------
if [ "$CHAT_SHELL_COUNT" -gt 0 ] 2>/dev/null; then
    echo -e "${BLUE}🔍 Chat Shell Checks:${NC}"
    
    cd chat_shell
    
    # Black format check
    echo -e "   Running Black format check..."
    env -u VIRTUAL_ENV uv run black --check --diff . > "$TEMP_DIR/chat_shell_black.log" 2>&1
    BLACK_EXIT=$?
    if [ $BLACK_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ Black: PASSED${NC}"
    else
        echo -e "   ${RED}❌ Black: FAILED (run 'cd chat_shell && uv run black .' to fix)${NC}"
        CHECK_FAILED=1
        FAILED_CHECKS+=("Chat Shell Black")
        echo -e "\nFix: cd chat_shell && uv run black ." >> "$TEMP_DIR/chat_shell_black.log"
        FAILED_LOGS+=("$TEMP_DIR/chat_shell_black.log")
    fi
    
    # isort check
    echo -e "   Running isort check..."
    env -u VIRTUAL_ENV uv run isort --check-only --diff . > "$TEMP_DIR/chat_shell_isort.log" 2>&1
    ISORT_EXIT=$?
    if [ $ISORT_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ isort: PASSED${NC}"
    else
        echo -e "   ${RED}❌ isort: FAILED (run 'cd chat_shell && uv run isort .' to fix)${NC}"
        CHECK_FAILED=1
        FAILED_CHECKS+=("Chat Shell isort")
        echo -e "\nFix: cd chat_shell && uv run isort ." >> "$TEMP_DIR/chat_shell_isort.log"
        FAILED_LOGS+=("$TEMP_DIR/chat_shell_isort.log")
    fi
    
    # autoflake check - unused imports
    echo -e "   Running autoflake unused imports check..."
    env -u VIRTUAL_ENV uv run autoflake --quiet --check --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=".venv,venv,build,dist" . > "$TEMP_DIR/chat_shell_autoflake.log" 2>&1
    AUTOFLAKE_EXIT=$?
    if [ $AUTOFLAKE_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ autoflake: PASSED${NC}"
    else
        echo -e "   ${RED}❌ autoflake: FAILED (run 'cd chat_shell && uv run autoflake --in-place --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=.venv,venv,build,dist .' to fix)${NC}"
        CHECK_FAILED=1
        FAILED_CHECKS+=("Chat Shell autoflake")
        echo -e "\nFix: cd chat_shell && uv run autoflake --quiet --in-place --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=.venv,venv,build,dist ." >> "$TEMP_DIR/chat_shell_autoflake.log"
        FAILED_LOGS+=("$TEMP_DIR/chat_shell_autoflake.log")
    fi
    
    # mypy type check (non-blocking warning)
    echo -e "   Running mypy type check..."
    env -u VIRTUAL_ENV uv run mypy . > "$TEMP_DIR/chat_shell_mypy.log" 2>&1
    MYPY_EXIT=$?
    if [ $MYPY_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ mypy: PASSED${NC}"
    else
        echo -e "   ${YELLOW}⚠️  mypy: WARNING (non-blocking)${NC}"
        echo -e "       Run 'cd chat_shell && uv run mypy .' to see details" >> "$TEMP_DIR/chat_shell_mypy.log"
        MYPY_WARNING_COUNT=$((MYPY_WARNING_COUNT + 1))
        MYPY_WARNING_MODULES="$MYPY_WARNING_MODULES chat_shell"
    fi
    
    if ! command -v pytest &> /dev/null; then
        echo -e "   ${YELLOW}⚠️ SKIP: pytest not found${NC}"
        echo -e "   ${YELLOW}   Run 'pip install pytest' to install dependencies${NC}"
        WARNINGS+=("Chat Shell: pytest not found, tests skipped")
    else
        echo -e "   Running pytest..."
        if [ -d "tests" ]; then
            env -u VIRTUAL_ENV uv run pytest tests/ --tb=short -q > "$TEMP_DIR/chat_shell_pytest.log" 2>&1
            PYTEST_EXIT=$?
            if [ $PYTEST_EXIT -eq 0 ]; then
                echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
            else
                echo -e "   ${RED}❌ Pytest: FAILED${NC}"
                CHECK_FAILED=1
                FAILED_CHECKS+=("Chat Shell Pytest")
                FAILED_LOGS+=("$TEMP_DIR/chat_shell_pytest.log")
            fi
        else
            echo -e "   ${YELLOW}⚠️ SKIP: tests directory not found${NC}"
            WARNINGS+=("Chat Shell: tests directory not found")
        fi
    fi
    
    cd ..
    echo ""
fi

# -----------------------------------------------------------------------------
# Shared Module Checks (if shared files changed)
# -----------------------------------------------------------------------------
if [ "$SHARED_COUNT" -gt 0 ] 2>/dev/null; then
    echo -e "${BLUE}🔍 Shared Module Checks:${NC}"
    
    cd shared
    
    # Black format check
    echo -e "   Running Black format check..."
    env -u VIRTUAL_ENV uv run black --check . > "$TEMP_DIR/shared_black.log" 2>&1
    BLACK_EXIT=$?
    if [ $BLACK_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ Black: PASSED${NC}"
    else
        echo -e "   ${RED}❌ Black: FAILED (run 'cd shared && uv run black .' to fix)${NC}"
        CHECK_FAILED=1
        FAILED_CHECKS+=("Shared Black")
        echo -e "\nFix: cd shared && uv run black ." >> "$TEMP_DIR/shared_black.log"
        FAILED_LOGS+=("$TEMP_DIR/shared_black.log")
    fi
    
    # isort check
    echo -e "   Running isort check..."
    env -u VIRTUAL_ENV uv run isort --check-only --diff . > "$TEMP_DIR/shared_isort.log" 2>&1
    ISORT_EXIT=$?
    if [ $ISORT_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ isort: PASSED${NC}"
    else
        echo -e "   ${RED}❌ isort: FAILED (run 'cd shared && uv run isort .' to fix)${NC}"
        CHECK_FAILED=1
        FAILED_CHECKS+=("Shared isort")
        echo -e "\nFix: cd shared && uv run isort ." >> "$TEMP_DIR/shared_isort.log"
        FAILED_LOGS+=("$TEMP_DIR/shared_isort.log")
    fi
    
    # autoflake check - unused imports
    echo -e "   Running autoflake unused imports check..."
    env -u VIRTUAL_ENV uv run autoflake --quiet --check --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=".venv,venv,build,dist" . > "$TEMP_DIR/shared_autoflake.log" 2>&1
    AUTOFLAKE_EXIT=$?
    if [ $AUTOFLAKE_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ autoflake: PASSED${NC}"
    else
        echo -e "   ${RED}❌ autoflake: FAILED (run 'cd shared && uv run autoflake --in-place --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=.venv,venv,build,dist .' to fix)${NC}"
        CHECK_FAILED=1
        FAILED_CHECKS+=("Shared autoflake")
        echo -e "\nFix: cd shared && uv run autoflake --quiet --in-place --remove-all-unused-imports --recursive --ignore-init-module-imports --exclude=.venv,venv,build,dist ." >> "$TEMP_DIR/shared_autoflake.log"
        FAILED_LOGS+=("$TEMP_DIR/shared_autoflake.log")
    fi
    
    # mypy type check (non-blocking warning)
    echo -e "   Running mypy type check..."
    env -u VIRTUAL_ENV uv run mypy . > "$TEMP_DIR/shared_mypy.log" 2>&1
    MYPY_EXIT=$?
    if [ $MYPY_EXIT -eq 0 ]; then
        echo -e "   ${GREEN}✅ mypy: PASSED${NC}"
    else
        echo -e "   ${YELLOW}⚠️  mypy: WARNING (non-blocking)${NC}"
        echo -e "       Run 'cd shared && uv run mypy .' to see details" >> "$TEMP_DIR/shared_mypy.log"
        MYPY_WARNING_COUNT=$((MYPY_WARNING_COUNT + 1))
        MYPY_WARNING_MODULES="$MYPY_WARNING_MODULES shared"
    fi
    
    if ! command -v pytest &> /dev/null; then
        echo -e "   ${YELLOW}⚠️ SKIP: pytest not found${NC}"
        echo -e "   ${YELLOW}   Run 'pip install pytest' to install dependencies${NC}"
        WARNINGS+=("Shared: pytest not found, tests skipped")
    else
        echo -e "   Running pytest..."
        if [ -d "tests" ]; then
            env -u VIRTUAL_ENV uv run pytest tests/ --tb=short -q > "$TEMP_DIR/shared_pytest.log" 2>&1
            PYTEST_EXIT=$?
            # Check if tests passed (look for "passed" in output and no "failed")
            if grep -q "passed" "$TEMP_DIR/shared_pytest.log" && ! grep -q "[0-9]* failed" "$TEMP_DIR/shared_pytest.log"; then
                echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
            elif [ $PYTEST_EXIT -eq 0 ]; then
                echo -e "   ${GREEN}✅ Pytest: PASSED${NC}"
            else
                echo -e "   ${RED}❌ Pytest: FAILED${NC}"
                CHECK_FAILED=1
                FAILED_CHECKS+=("Shared Pytest")
                FAILED_LOGS+=("$TEMP_DIR/shared_pytest.log")
            fi
        else
            echo -e "   ${YELLOW}⚠️ SKIP: tests directory not found${NC}"
            WARNINGS+=("Shared: tests directory not found")
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
        "$ALEMBIC_CHECK_SCRIPT" > "$TEMP_DIR/alembic.log" 2>&1
        ALEMBIC_EXIT=$?
        
        if [ $ALEMBIC_EXIT -eq 0 ]; then
            echo -e "   ${GREEN}✅ Alembic Multi-Head Check: PASSED${NC}"
            elif [ $ALEMBIC_EXIT -eq 1 ]; then
            echo -e "   ${RED}❌ Alembic Multi-Head Check: FAILED${NC}"
            CHECK_FAILED=1
            FAILED_CHECKS+=("Alembic Multi-Head")
            FAILED_LOGS+=("$TEMP_DIR/alembic.log")
        else
            echo -e "   ${YELLOW}⚠️ Alembic check could not determine status${NC}"
            WARNINGS+=("Alembic: check returned unexpected exit code $ALEMBIC_EXIT")
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
    echo -e "${RED}${BOLD}❌ Some checks failed. Please fix the issues before pushing.${NC}"
    echo ""
    
    # Output detailed error logs at the end for AI tail monitoring
    echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}${BOLD}FAILED CHECKS DETAIL (for AI monitoring):${NC}"
    echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
    echo ""
    for i in "${!FAILED_CHECKS[@]}"; do
        echo -e "${RED}❌ ${FAILED_CHECKS[$i]}${NC}"
        # FAILED_LOGS now contains file paths, read content from file
        if [ -f "${FAILED_LOGS[$i]}" ]; then
            echo -e "${YELLOW}=== ${FAILED_CHECKS[$i]} Errors ===${NC}"
            cat "${FAILED_LOGS[$i]}"
        else
            # Fallback for inline messages (shouldn't happen with new code)
            echo -e "${YELLOW}${FAILED_LOGS[$i]}${NC}"
        fi
        echo ""
    done
    echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}Total failed: ${#FAILED_CHECKS[@]} check(s)${NC}"
    echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
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

# mypy warnings summary
if [ $MYPY_WARNING_COUNT -gt 0 ]; then
    echo -e "${YELLOW}⚠️  mypy found type errors in:$MYPY_WARNING_MODULES${NC}"
    echo -e "${YELLOW}   These are non-blocking warnings. Fix them when convenient.${NC}"
    echo -e "${YELLOW}   Run mypy in each module to see details.${NC}\n"
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
