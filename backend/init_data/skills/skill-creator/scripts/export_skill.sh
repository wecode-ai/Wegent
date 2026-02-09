#!/bin/bash
# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# export_skill.sh - Export a Skill directory as ZIP and upload as attachment for user download

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

SKILL_PATH="$1"
OUTPUT_NAME="${2:-$(basename "$SKILL_PATH")}"

# Check required parameters
if [ -z "$SKILL_PATH" ]; then
    echo "❌ Error: skill_path is required"
    echo ""
    echo "Usage: export_skill.sh <skill_path> [output_name]"
    echo ""
    echo "Parameters:"
    echo "  skill_path   - Path to the Skill directory (must contain SKILL.md)"
    echo "  output_name  - Name for the exported ZIP file (without .zip extension)"
    echo ""
    echo "Example:"
    echo "  bash scripts/export_skill.sh /home/user/my-skill"
    echo "  bash scripts/export_skill.sh /home/user/my-skill custom-name"
    exit 1
fi

# Resolve to absolute path
SKILL_PATH="$(cd "$SKILL_PATH" 2>/dev/null && pwd)" || {
    echo "❌ Error: Cannot resolve path: $1"
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

# Create temporary directory for packaging
TMP_DIR=$(mktemp -d)
ZIP_FILE="$TMP_DIR/${OUTPUT_NAME}.zip"

# Cleanup function
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "📦 Packaging skill: $OUTPUT_NAME"

# Package the skill directory
# The ZIP should contain: skill-name/SKILL.md, skill-name/other-files...
cd "$(dirname "$SKILL_PATH")"
zip -rq "$ZIP_FILE" "$(basename "$SKILL_PATH")"

echo "📤 Uploading to Wegent..."

# Upload as attachment via Backend API
API_BASE=$(get_api_base)
UPLOAD_URL="$API_BASE/api/attachments/upload"

RESPONSE=$(curl -s -X POST \
    --connect-timeout 10 --max-time 60 \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -F "file=@$ZIP_FILE" \
    "$UPLOAD_URL")

# Parse response
ATTACHMENT_ID=$(echo "$RESPONSE" | jq -r '.id // empty')
FILE_SIZE=$(echo "$RESPONSE" | jq -r '.file_size // 0')

if [ -n "$ATTACHMENT_ID" ] && [ "$ATTACHMENT_ID" != "null" ]; then
    # Format file size for display
    SIZE_STR=$(format_file_size "$FILE_SIZE")

    echo ""
    echo "✅ Skill exported successfully!"
    echo ""
    echo "📦 **${OUTPUT_NAME}.zip** ($SIZE_STR)"
    echo ""
    echo "[Click to Download](/api/attachments/$ATTACHMENT_ID/download)"
    echo ""
    echo "You can save this file locally and:"
    echo "- Share it with other users"
    echo "- Upload it to another Wegent account via Settings > Skills"
else
    ERROR=$(echo "$RESPONSE" | jq -r '.detail // .message // "Unknown error"')
    echo "❌ Export failed: $ERROR"
    if [ "${VERBOSE:-}" = "1" ]; then
        echo ""
        echo "Response: $RESPONSE"
    fi
    exit 1
fi
