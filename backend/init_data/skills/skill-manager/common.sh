#!/bin/bash
# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# common.sh - Common functions for skill-manager scripts

# Validate that a directory is a valid Skill directory
validate_skill_directory() {
    local skill_path="$1"

    # Check directory exists
    if [ ! -d "$skill_path" ]; then
        echo "❌ Error: Directory not found: $skill_path"
        exit 1
    fi

    # Check SKILL.md exists
    if [ ! -f "$skill_path/SKILL.md" ]; then
        echo "❌ Error: SKILL.md not found in $skill_path"
        echo ""
        echo "A valid Skill directory must contain a SKILL.md file with YAML frontmatter."
        echo ""
        echo "Example SKILL.md:"
        echo "---"
        echo "description: \"Brief description of the skill\""
        echo "version: \"1.0.0\""
        echo "---"
        echo ""
        echo "# Skill Title"
        echo "Your skill prompt here..."
        exit 1
    fi

    # Check SKILL.md has frontmatter
    if ! head -1 "$skill_path/SKILL.md" | grep -q "^---"; then
        echo "⚠️ Warning: SKILL.md may not have valid YAML frontmatter"
        echo "   First line should be '---'"
    fi

    # Check description field exists (case-insensitive)
    if ! grep -qi "^description:" "$skill_path/SKILL.md"; then
        echo "❌ Error: SKILL.md must contain a 'description' field in frontmatter"
        echo ""
        echo "Add 'description: \"Your skill description\"' to the frontmatter."
        exit 1
    fi

    echo "✓ Skill directory validated: $skill_path"
}

# Check authentication environment
check_auth() {
    if [ -z "$TASK_INFO" ]; then
        echo "❌ Error: TASK_INFO environment variable is not set"
        echo ""
        echo "This script must be run within a Wegent Claude Code task."
        exit 1
    fi

    # Verify auth_token is present
    local token
    token=$(echo "$TASK_INFO" | jq -r '.auth_token // empty')
    if [ -z "$token" ]; then
        echo "❌ Error: auth_token not found in TASK_INFO"
        exit 1
    fi
}

# Get auth token from TASK_INFO
get_auth_token() {
    echo "$TASK_INFO" | jq -r '.auth_token // empty'
}

# Get API base URL
get_api_base() {
    echo "${TASK_API_DOMAIN:-http://backend:8000}"
}

# Format file size for display
format_file_size() {
    local size="$1"
    if [ "$size" -lt 1024 ]; then
        echo "${size} B"
    elif [ "$size" -lt 1048576 ]; then
        echo "$(awk "BEGIN {printf \"%.1f\", $size / 1024}") KB"
    else
        echo "$(awk "BEGIN {printf \"%.1f\", $size / 1048576}") MB"
    fi
}
