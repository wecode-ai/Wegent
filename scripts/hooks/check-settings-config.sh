#!/bin/bash
# =============================================================================
# Settings Configuration Check
# =============================================================================
# This script checks for Settings class attributes that are used in the code
# but not defined in their respective Settings classes
#
# Usage:
#   ./scripts/hooks/check-settings-config.sh
#
# Exit codes:
#   0 - All settings are properly defined
#   1 - Found undefined settings
#   2 - Script error (missing files, etc.)
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Backend directory
BACKEND_DIR="$PROJECT_ROOT/backend"

# Check if backend directory exists
if [ ! -d "$BACKEND_DIR" ]; then
    echo -e "${RED}❌ Backend directory not found: $BACKEND_DIR${NC}"
    exit 2
fi

echo -e "${BLUE}🔍 Checking Settings configuration...${NC}"

# Function to extract settings from a config file
extract_settings() {
    local config_file="$1"
    if [ ! -f "$config_file" ]; then
        return
    fi
    grep -E "^\s+[A-Z_][A-Z0-9_]*\s*:" "$config_file" | \
        awk -F: '{print $1}' | sed 's/^[[:space:]]*//' | \
        sort | uniq
}

# Function to find usage of a specific settings instance
find_settings_usage() {
    local settings_name="$1"
    # Use word boundary to ensure exact match (e.g., "settings." not "wiki_settings.")
    grep -rho "\b${settings_name}\.[A-Z_][A-Z0-9_]*" "$BACKEND_DIR" \
        --include="*.py" \
        --exclude-dir=tests \
        --exclude-dir=alembic \
        --exclude-dir=.venv \
        2>/dev/null | \
        grep -v "app/core/.*config.py" | \
        sed "s/${settings_name}\.//" | \
        sort | uniq
}

# Function to check a specific settings configuration
check_settings_config() {
    local settings_name="$1"
    local config_file="$2"
    
    echo -e "${BLUE}📋 Checking ${settings_name}...${NC}"
    
    # Extract defined settings
    DEFINED_SETTINGS=$(extract_settings "$config_file")
    
    if [ -z "$DEFINED_SETTINGS" ]; then
        if [ -f "$config_file" ]; then
            echo -e "${YELLOW}⚠️ No settings found in $config_file${NC}"
        else
            echo -e "${YELLOW}⚠️ Config file not found: $config_file${NC}"
        fi
        return 0
    fi
    
    # Find used settings
    USED_SETTINGS=$(find_settings_usage "$settings_name")
    
    if [ -z "$USED_SETTINGS" ]; then
        echo -e "${GREEN}✅ No usage found for ${settings_name}${NC}"
        return 0
    fi
    
    # Find undefined settings
    UNDEFINED_SETTINGS=""
    while IFS= read -r used_setting; do
        if ! echo "$DEFINED_SETTINGS" | grep -q "^${used_setting}$"; then
            UNDEFINED_SETTINGS="${UNDEFINED_SETTINGS}${used_setting}\n"
        fi
    done <<< "$USED_SETTINGS"
    
    # Remove trailing newline
    UNDEFINED_SETTINGS=$(echo -e "$UNDEFINED_SETTINGS" | sed '/^$/d')
    
    if [ -z "$UNDEFINED_SETTINGS" ]; then
        echo -e "${GREEN}✅ All ${settings_name} attributes are properly defined${NC}"
        return 0
    else
        echo -e "${RED}❌ Found undefined ${settings_name} attributes:${NC}"
        UNDEFINED_COUNT=0
        while IFS= read -r undefined_setting; do
            if [ -n "$undefined_setting" ]; then
                UNDEFINED_COUNT=$((UNDEFINED_COUNT + 1))
                echo -e "${RED}   - $undefined_setting${NC}"
            fi
        done <<< "$UNDEFINED_SETTINGS"
        echo -e "${RED}   Subtotal: ${UNDEFINED_COUNT} undefined setting(s) for ${settings_name}${NC}"
        return $UNDEFINED_COUNT
    fi
}

TOTAL_UNDEFINED=0
HAS_ERRORS=0

# Check main settings
check_settings_config "settings" "$PROJECT_ROOT/backend/app/core/config.py"
RESULT=$?
if [ $RESULT -gt 0 ]; then
    TOTAL_UNDEFINED=$((TOTAL_UNDEFINED + RESULT))
    HAS_ERRORS=1
fi
echo ""

# Check wiki settings
check_settings_config "wiki_settings" "$PROJECT_ROOT/backend/app/core/wiki_config.py"
RESULT=$?
if [ $RESULT -gt 0 ]; then
    TOTAL_UNDEFINED=$((TOTAL_UNDEFINED + RESULT))
    HAS_ERRORS=1
fi
echo ""

# Add more settings configurations here as needed
# Example:
# check_settings_config "other_settings" "$PROJECT_ROOT/backend/app/core/other_config.py"

if [ $HAS_ERRORS -eq 0 ]; then
    echo -e "${GREEN}✅ All settings configurations are valid${NC}"
    exit 0
else
    echo -e "${RED}❌ Total: ${TOTAL_UNDEFINED} undefined setting(s) found across all configurations${NC}"
    exit 1
fi
