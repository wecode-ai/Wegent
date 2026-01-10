#!/bin/bash
# =============================================================================
# Block GitHub Push - Pre-push Hook
# =============================================================================
# This script blocks pushes to GitHub repositories.
# It checks the remote URL and prevents pushing if it matches github.com.
#
# Usage:
#   This script is called by the pre-push hook automatically.
#   To bypass (NOT RECOMMENDED): ALLOW_GITHUB_PUSH=1 git push
# =============================================================================

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Get remote name and URL from pre-push hook parameters
remote="$1"
url="$2"

# If URL is not provided, try to get it from the remote name
if [ -z "$url" ] && [ -n "$remote" ]; then
    url=$(git remote get-url "$remote" 2>/dev/null || echo "")
fi

# If still no URL, try to get from origin
if [ -z "$url" ]; then
    url=$(git remote get-url origin 2>/dev/null || echo "")
fi

# Check if bypass is enabled
if [ "$ALLOW_GITHUB_PUSH" = "1" ]; then
    echo -e "${YELLOW}⚠️  ALLOW_GITHUB_PUSH=1 detected - bypassing GitHub push block${NC}"
    exit 0
fi

# Check if the URL contains github.com
if echo "$url" | grep -qiE "(github\.com|github\.io)"; then
    echo ""
    echo -e "${RED}${BOLD}══════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}${BOLD}🚫 PUSH BLOCKED - GitHub Repository Detected${NC}"
    echo -e "${RED}${BOLD}══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${YELLOW}Remote: ${remote:-origin}${NC}"
    echo -e "${YELLOW}URL: $url${NC}"
    echo ""
    echo -e "${RED}Pushing to GitHub repositories is not allowed.${NC}"
    echo -e "${RED}This policy is enforced to prevent accidental code leaks.${NC}"
    echo ""
    echo -e "${YELLOW}If you need to push to a different remote, use:${NC}"
    echo -e "${GREEN}  git push <other-remote> <branch>${NC}"
    echo ""
    echo -e "${RED}${BOLD}══════════════════════════════════════════════════════════${NC}"
    echo ""
    exit 1
fi

# URL is not GitHub, allow push
exit 0
