#!/usr/bin/env bash
# =============================================================================
# Alembic Multi-Head Detection Script
# =============================================================================
# This script detects multiple heads in Alembic migrations by parsing Python
# migration files. It builds a dependency graph and identifies all head
# revisions (those not referenced by any down_revision).
#
# Usage:
#   ./scripts/hooks/check-alembic-heads.sh
#
# Exit codes:
#   0 - Single head detected (OK)
#   1 - Multiple heads detected (FAIL)
#   2 - No migration files found or parsing error
# =============================================================================

# Colors for output (matching ai-push-gate.sh style)
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Find the project root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ALEMBIC_VERSIONS_DIR="$PROJECT_ROOT/backend/alembic/versions"

# =============================================================================
# Functions
# =============================================================================

# Print section header
print_header() {
    echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}${BOLD}$1${NC}"
    echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════════${NC}"
}

# Extract revision ID from a migration file
get_revision() {
    local file="$1"
    grep -E "^revision\s*[:=]" "$file" | head -1 | sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/"
}

# Extract down_revision from a migration file (handles single, None, and tuple)
get_down_revision() {
    local file="$1"
    local down_rev_line
    local down_rev_value

    # Get the down_revision line(s) - handle multi-line tuple format
    down_rev_line=$(grep -A 3 "^down_revision" "$file" | head -4)

    # Extract only the value part after the equals sign
    down_rev_value=$(echo "$down_rev_line" | sed -n 's/.*=\s*//p' | head -1)

    # Check if value is None (not in type annotation)
    if [[ "$down_rev_value" == "None" ]]; then
        echo "None"
        return
    fi

    # Check if it's a tuple (multiple parents - merge migration)
    if echo "$down_rev_line" | grep -qE "=\s*\("; then
        # Extract all revision IDs from the tuple
        echo "$down_rev_line" | grep -oE "['\"][^'\"]+['\"]" | sed "s/['\"]//g" | tr '\n' ' '
        return
    fi

    # Single parent case - extract string value
    echo "$down_rev_line" | grep -oE "['\"][^'\"]+['\"]" | head -1 | sed "s/['\"]//g"
}

# Check if revision ID follows standard format (12-char hex)
is_standard_revision_format() {
    local rev="$1"
    if [[ "$rev" =~ ^[0-9a-f]{12}$ ]]; then
        return 0
    fi
    return 1
}

# =============================================================================
# Main Logic
# =============================================================================

echo ""
print_header "🔍 Alembic Multi-Head Detection"
echo ""

# Check if versions directory exists
if [ ! -d "$ALEMBIC_VERSIONS_DIR" ]; then
    echo -e "${YELLOW}⚠️  Alembic versions directory not found: $ALEMBIC_VERSIONS_DIR${NC}"
    echo -e "${YELLOW}   Skipping multi-head detection.${NC}"
    exit 0
fi

# Find all migration files
MIGRATION_FILES=$(find "$ALEMBIC_VERSIONS_DIR" -name "*.py" -type f ! -name "__pycache__" | sort)

if [ -z "$MIGRATION_FILES" ]; then
    echo -e "${YELLOW}⚠️  No migration files found in $ALEMBIC_VERSIONS_DIR${NC}"
    exit 0
fi

# Build arrays to track revisions
# Note: Using simple arrays for Bash 3.x compatibility (macOS default)
# Format: "key:value" pairs stored in arrays, searched with grep
REVISIONS=""          # revision_id:filename pairs (newline separated)
DOWN_REVISIONS=""     # revision_id:down_revision pairs (newline separated)
IS_REFERENCED=""      # referenced revision IDs (newline separated)
NON_STANDARD_IDS=""   # Non-standard revision IDs (newline separated)
ALL_REVISIONS=""      # List of all revision IDs (newline separated)

# Helper function to get value from key:value pairs
get_value() {
    local data="$1"
    local key="$2"
    echo "$data" | grep "^${key}:" | head -1 | cut -d':' -f2-
}

# Helper function to check if key exists in list
key_exists() {
    local data="$1"
    local key="$2"
    echo "$data" | grep -q "^${key}$"
}

# Parse all migration files
echo -e "${BLUE}📁 Parsing migration files...${NC}"
FILE_COUNT=0

for file in $MIGRATION_FILES; do
    # Skip __pycache__ directory
    if [[ "$file" == *"__pycache__"* ]]; then
        continue
    fi

    filename=$(basename "$file")
    revision=$(get_revision "$file")
    down_revision=$(get_down_revision "$file")

    if [ -z "$revision" ]; then
        echo -e "${YELLOW}   ⚠️  Could not parse revision from: $filename${NC}"
        continue
    fi

    # Store revision data
    REVISIONS="${REVISIONS}${revision}:${filename}"$'\n'
    DOWN_REVISIONS="${DOWN_REVISIONS}${revision}:${down_revision}"$'\n'
    ALL_REVISIONS="${ALL_REVISIONS}${revision}"$'\n'
    FILE_COUNT=$((FILE_COUNT + 1))

    # Check revision ID format
    if ! is_standard_revision_format "$revision"; then
        NON_STANDARD_IDS="${NON_STANDARD_IDS}${revision} (${filename})"$'\n'
    fi

    # Mark down_revisions as referenced
    for down_rev in $down_revision; do
        if [ "$down_rev" != "None" ] && [ -n "$down_rev" ]; then
            if ! key_exists "$IS_REFERENCED" "$down_rev"; then
                IS_REFERENCED="${IS_REFERENCED}${down_rev}"$'\n'
            fi
        fi
    done
done

echo -e "   Found ${FILE_COUNT} migration file(s)"
echo ""

# Find all heads (revisions not referenced by any down_revision)
HEADS=""
while IFS= read -r rev; do
    [ -z "$rev" ] && continue
    if ! key_exists "$IS_REFERENCED" "$rev"; then
        HEADS="${HEADS}${rev}"$'\n'
    fi
done <<< "$ALL_REVISIONS"

# Count heads (remove empty lines)
HEAD_COUNT=$(echo "$HEADS" | grep -c .)

# =============================================================================
# Report Results
# =============================================================================

# Check revision ID format warnings
NON_STANDARD_COUNT=$(echo "$NON_STANDARD_IDS" | grep -c . || true)
if [ "$NON_STANDARD_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}⚠️  Non-standard revision ID format detected:${NC}"
    while IFS= read -r id; do
        [ -z "$id" ] && continue
        echo -e "   ${YELLOW}• $id${NC}"
    done <<< "$NON_STANDARD_IDS"
    echo ""
    echo -e "${YELLOW}   Recommendation: Use 'alembic revision --autogenerate' to generate${NC}"
    echo -e "${YELLOW}   standard 12-character hexadecimal revision IDs.${NC}"
    echo ""
fi

# Report heads
if [ "$HEAD_COUNT" -eq 0 ]; then
    echo -e "${RED}❌ No head revisions found. Check migration file structure.${NC}"
    exit 2
elif [ "$HEAD_COUNT" -eq 1 ]; then
    SINGLE_HEAD=$(echo "$HEADS" | grep . | head -1)
    SINGLE_HEAD_FILE=$(get_value "$REVISIONS" "$SINGLE_HEAD")
    echo -e "${GREEN}✅ Alembic Multi-Head Check: PASSED${NC}"
    echo -e "   Single head detected: ${BOLD}${SINGLE_HEAD}${NC}"
    echo -e "   File: ${SINGLE_HEAD_FILE}"
    echo ""
    exit 0
else
    echo -e "${RED}❌ Alembic Multi-Head Check: FAILED${NC}"
    echo ""
    echo -e "${RED}${BOLD}   Multiple heads detected (${HEAD_COUNT}):${NC}"
    while IFS= read -r head; do
        [ -z "$head" ] && continue
        head_file=$(get_value "$REVISIONS" "$head")
        echo -e "   ${RED}• ${head}${NC} (${head_file})"
    done <<< "$HEADS"
    echo ""

    # Provide fix instructions
    echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}${BOLD}📋 How to Fix Multiple Heads${NC}"
    echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${BOLD}Step 1: Verify current heads${NC}"
    echo -e "   ${GREEN}cd backend && alembic heads${NC}"
    echo ""
    echo -e "${BOLD}Step 2: Merge the heads${NC}"

    # Generate merge command with all heads
    MERGE_HEADS=$(echo "$HEADS" | grep . | tr '\n' ' ')
    echo -e "   ${GREEN}alembic merge -m \"merge heads\" ${MERGE_HEADS}${NC}"
    echo ""
    echo -e "${BOLD}Step 3: Apply the merge migration${NC}"
    echo -e "   ${GREEN}alembic upgrade head${NC}"
    echo ""
    echo -e "${BOLD}Step 4: Commit the merge migration${NC}"
    echo -e "   ${GREEN}git add backend/alembic/versions/\n   git commit -m \"chore: merge alembic heads\"${NC}"
    echo ""
    echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}💡 Prevention Tips:${NC}"
    echo -e "   • Always pull latest main before creating new migrations"
    echo -e "   • Run './scripts/check-alembic.sh' before committing"
    echo -e "   • Coordinate with team when multiple migration PRs are open"
    echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
    echo ""

    exit 1
fi
