#!/bin/bash
# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# publish-skill.sh - Publish a Skill to the user's Wegent Skill library

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# Parse arguments
SKILL_PATH=""
SKILL_NAME=""
NAMESPACE="default"
OVERWRITE=""

# Parse positional and flag arguments
POSITIONAL=()
for arg in "$@"; do
    if [ "$arg" = "--overwrite" ]; then
        OVERWRITE="true"
    else
        POSITIONAL+=("$arg")
    fi
done

# Assign positional arguments
SKILL_PATH="${POSITIONAL[0]:-}"
SKILL_NAME="${POSITIONAL[1]:-}"
if [ -n "${POSITIONAL[2]:-}" ]; then
    NAMESPACE="${POSITIONAL[2]}"
fi

# Check required parameters
if [ -z "$SKILL_PATH" ] || [ -z "$SKILL_NAME" ]; then
    echo "❌ Error: skill_path and skill_name are required"
    echo ""
    echo "Usage: publish-skill.sh <skill_path> <skill_name> [namespace] [--overwrite]"
    echo ""
    echo "Parameters:"
    echo "  skill_path   - Path to the Skill directory (must contain SKILL.md)"
    echo "  skill_name   - Name for the Skill in Wegent (unique identifier)"
    echo "  namespace    - Namespace (default: 'default' for personal, or group name)"
    echo "  --overwrite  - Overwrite if Skill with same name exists"
    echo ""
    echo "Example:"
    echo "  bash ~/.claude/skills/skill-manager/publish-skill.sh /home/user/my-skill code-reviewer"
    echo "  bash ~/.claude/skills/skill-manager/publish-skill.sh /home/user/my-skill code-reviewer my-team"
    echo "  bash ~/.claude/skills/skill-manager/publish-skill.sh /home/user/my-skill code-reviewer --overwrite"
    exit 1
fi

# Resolve to absolute path
SKILL_PATH="$(cd "$SKILL_PATH" 2>/dev/null && pwd)" || {
    echo "❌ Error: Cannot resolve path: ${POSITIONAL[0]}"
    exit 1
}

# Validate skill directory
validate_skill_directory "$SKILL_PATH"

# Check authentication
check_auth

# Get auth token
AUTH_TOKEN=$(get_auth_token)
if [ -z "$AUTH_TOKEN" ]; then
    echo "❌ Error: Could not extract auth_token from TASK_INFO"
    exit 1
fi

API_BASE=$(get_api_base)

# Create temporary directory for packaging
TMP_DIR=$(mktemp -d)

# Cleanup function
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "📦 Packaging skill: $SKILL_NAME"

# Rename directory to match skill_name if different
SKILL_DIR_NAME=$(basename "$SKILL_PATH")
ZIP_FILE="$TMP_DIR/${SKILL_NAME}.zip"

if [ "$SKILL_DIR_NAME" != "$SKILL_NAME" ]; then
    # Create package directory with correct name
    # Use /. to include hidden files (dotfiles)
    mkdir -p "$TMP_DIR/pkg/$SKILL_NAME"
    cp -r "$SKILL_PATH"/. "$TMP_DIR/pkg/$SKILL_NAME/"
    cd "$TMP_DIR/pkg"
    zip -rq "$ZIP_FILE" "$SKILL_NAME"
else
    cd "$(dirname "$SKILL_PATH")"
    zip -rq "$ZIP_FILE" "$SKILL_NAME"
fi

echo "🔍 Checking for existing skill..."

# Check if skill already exists (URL-encode parameters to handle special characters)
ENCODED_NAME=$(urlencode "$SKILL_NAME")
ENCODED_NS=$(urlencode "$NAMESPACE")
CHECK_URL="$API_BASE/api/v1/kinds/skills?name=${ENCODED_NAME}&namespace=${ENCODED_NS}&exact_match=true"
EXISTING=$(curl -s --connect-timeout 10 --max-time 30 -H "Authorization: Bearer $AUTH_TOKEN" "$CHECK_URL" 2>/dev/null || echo '{"items":[]}')
EXISTING_ID=$(echo "$EXISTING" | jq -r '.items[0].metadata.labels.id // empty')

ACTION="created"

if [ -n "$EXISTING_ID" ] && [ "$EXISTING_ID" != "null" ]; then
    if [ "$OVERWRITE" = "true" ]; then
        echo "📝 Updating existing skill (ID: $EXISTING_ID)..."
        # Update existing skill via PUT endpoint
        UPDATE_URL="$API_BASE/api/v1/kinds/skills/$EXISTING_ID"
        RESPONSE=$(curl -s -X PUT \
            --connect-timeout 10 --max-time 60 \
            -H "Authorization: Bearer $AUTH_TOKEN" \
            -F "file=@$ZIP_FILE" \
            "$UPDATE_URL")
        ACTION="updated"
    else
        echo ""
        echo "❌ Skill '$SKILL_NAME' already exists in namespace '$NAMESPACE'."
        echo ""
        echo "Options:"
        echo "  - Use --overwrite flag to replace it"
        echo "  - Choose a different skill name"
        exit 1
    fi
else
    echo "📤 Publishing skill to Wegent..."

    # Upload skill via API
    UPLOAD_URL="$API_BASE/api/v1/kinds/skills/upload"
    RESPONSE=$(curl -s -X POST \
        --connect-timeout 10 --max-time 60 \
        -H "Authorization: Bearer $AUTH_TOKEN" \
        -F "file=@$ZIP_FILE" \
        -F "name=$SKILL_NAME" \
        -F "namespace=$NAMESPACE" \
        "$UPLOAD_URL")
fi

# Parse response
NEW_ID=$(echo "$RESPONSE" | jq -r '.metadata.labels.id // .id // empty')

if [ -n "$NEW_ID" ] && [ "$NEW_ID" != "null" ]; then
    # Get display namespace
    if [ "$NAMESPACE" = "default" ]; then
        NS_DISPLAY="default (Personal)"
    else
        NS_DISPLAY="$NAMESPACE"
    fi

    # Capitalize action
    ACTION_DISPLAY=$(echo "$ACTION" | sed 's/./\U&/')

    echo ""
    echo "✅ Skill published successfully!"
    echo ""
    echo "📦 **$SKILL_NAME**"
    echo "   - Skill ID: $NEW_ID"
    echo "   - Namespace: $NS_DISPLAY"
    echo "   - Status: $ACTION_DISPLAY"
    echo ""
    echo "You can now use this Skill when creating Agents in Wegent Settings."
else
    ERROR=$(echo "$RESPONSE" | jq -r '.detail // .message // "Unknown error"')
    echo "❌ Publish failed: $ERROR"
    if [ "${VERBOSE:-}" = "1" ]; then
        echo ""
        echo "Response: $RESPONSE"
    fi
    exit 1
fi
