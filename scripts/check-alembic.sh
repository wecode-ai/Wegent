#!/bin/bash
# =============================================================================
# Alembic Status Check and Fix Utility
# =============================================================================
# A convenience script for checking and managing Alembic migrations.
#
# Usage:
#   ./scripts/check-alembic.sh        # Check alembic status
#   ./scripts/check-alembic.sh --fix  # Auto-fix multiple heads
#
# Exit codes:
#   0 - OK or fix successful
#   1 - Error or multiple heads detected (without --fix)
# =============================================================================

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Find the project root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend"
ALEMBIC_VERSIONS_DIR="$BACKEND_DIR/alembic/versions"

# Check for --fix flag
FIX_MODE=0
if [ "$1" == "--fix" ]; then
    FIX_MODE=1
fi

# Print section header
print_header() {
    echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}${BOLD}$1${NC}"
    echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════════${NC}"
}

echo ""
print_header "📊 Alembic Migration Status"
echo ""

# Check if backend directory exists
if [ ! -d "$BACKEND_DIR" ]; then
    echo -e "${RED}❌ Backend directory not found: $BACKEND_DIR${NC}"
    exit 1
fi

# Check if alembic versions directory exists
if [ ! -d "$ALEMBIC_VERSIONS_DIR" ]; then
    echo -e "${YELLOW}⚠️  No alembic versions directory found${NC}"
    exit 0
fi

# =============================================================================
# Run multi-head detection script
# =============================================================================

echo -e "${BLUE}🔍 Running multi-head detection...${NC}"
echo ""

"$SCRIPT_DIR/hooks/check-alembic-heads.sh"
DETECTION_EXIT=$?

echo ""

# =============================================================================
# Show recent migration history
# =============================================================================

print_header "📜 Recent Migration History (Last 5)"
echo ""

# Get recent migrations by modification time
RECENT_FILES=$(ls -t "$ALEMBIC_VERSIONS_DIR"/*.py 2>/dev/null | head -5)

if [ -z "$RECENT_FILES" ]; then
    echo -e "${YELLOW}   No migration files found${NC}"
else
    echo -e "${BLUE}   File                                              Revision${NC}"
    echo -e "   ────────────────────────────────────────────────  ────────────────────"
    for file in $RECENT_FILES; do
        filename=$(basename "$file")
        # Extract revision from file
        revision=$(grep -E "^revision\s*[:=]" "$file" | head -1 | sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/")
        printf "   %-50s %s\n" "$filename" "$revision"
    done
fi

echo ""

# =============================================================================
# Auto-fix mode
# =============================================================================

if [ $DETECTION_EXIT -eq 1 ] && [ $FIX_MODE -eq 1 ]; then
    print_header "🔧 Auto-Fix Mode"
    echo ""

    # Change to backend directory
    cd "$BACKEND_DIR" || exit 1

    # Check if uv is available
    if command -v uv &> /dev/null; then
        ALEMBIC_CMD="uv run alembic"
    elif [ -f ".venv/bin/alembic" ]; then
        ALEMBIC_CMD=".venv/bin/alembic"
    else
        ALEMBIC_CMD="alembic"
    fi

    echo -e "${BLUE}   Getting current heads...${NC}"
    HEADS=$($ALEMBIC_CMD heads 2>/dev/null | grep -oE "^[a-zA-Z0-9_]+" | tr '\n' ' ')

    if [ -z "$HEADS" ]; then
        echo -e "${RED}❌ Could not retrieve heads using alembic command${NC}"
        echo -e "${YELLOW}   Please ensure alembic is installed and database is accessible${NC}"
        exit 1
    fi

    HEAD_COUNT=$(echo "$HEADS" | wc -w)

    if [ "$HEAD_COUNT" -le 1 ]; then
        echo -e "${GREEN}✅ Only single head detected. No merge needed.${NC}"
        exit 0
    fi

    echo -e "${YELLOW}   Found $HEAD_COUNT heads: $HEADS${NC}"
    echo ""
    echo -e "${BLUE}   Creating merge migration...${NC}"

    # Run alembic merge
    $ALEMBIC_CMD merge -m "merge heads" $HEADS

    if [ $? -eq 0 ]; then
        echo ""
        echo -e "${GREEN}✅ Merge migration created successfully!${NC}"
        echo ""
        echo -e "${BLUE}Next steps:${NC}"
        echo -e "   1. Review the new merge migration file in backend/alembic/versions/"
        echo -e "   2. Apply migration: ${GREEN}cd backend && alembic upgrade head${NC}"
        echo -e "   3. Commit the changes: ${GREEN}git add backend/alembic/versions/ && git commit${NC}"
        exit 0
    else
        echo -e "${RED}❌ Failed to create merge migration${NC}"
        echo -e "${YELLOW}   Please run the merge command manually:${NC}"
        echo -e "   ${GREEN}cd backend && alembic merge -m \"merge heads\" $HEADS${NC}"
        exit 1
    fi
fi

# =============================================================================
# Summary
# =============================================================================

echo ""
if [ $DETECTION_EXIT -eq 0 ]; then
    echo -e "${GREEN}✅ Alembic status: OK${NC}"
    exit 0
elif [ $DETECTION_EXIT -eq 1 ]; then
    echo -e "${RED}❌ Multiple heads detected. Run with --fix to auto-merge:${NC}"
    echo -e "   ${GREEN}./scripts/check-alembic.sh --fix${NC}"
    exit 1
else
    echo -e "${YELLOW}⚠️  Could not determine alembic status${NC}"
    exit $DETECTION_EXIT
fi
