#!/bin/bash
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Shared shell helpers for Wegent Skill publishing scripts.

validate_skill_directory() {
    local skill_path="$1"

    if [ ! -d "$skill_path" ]; then
        echo "Error: Directory not found: $skill_path"
        exit 1
    fi

    if [ ! -f "$skill_path/SKILL.md" ]; then
        echo "Error: SKILL.md not found in $skill_path"
        echo "A valid Skill directory must contain a SKILL.md file with YAML frontmatter."
        exit 1
    fi

    if ! head -n 1 "$skill_path/SKILL.md" | grep -q "^---"; then
        echo "Warning: SKILL.md may not have valid YAML frontmatter"
    fi

    if ! sed -n '1,/^---$/{ /^---$/d; p; }' "$skill_path/SKILL.md" | head -n 50 | grep -qi "^description:"; then
        echo "Error: SKILL.md must contain a 'description' field in frontmatter"
        exit 1
    fi
}

check_auth() {
    if [ -z "${WEGENT_SKILL_IDENTITY_TOKEN:-}" ]; then
        echo "Wegent authentication token is not available."
        echo "Expected WEGENT_SKILL_IDENTITY_TOKEN to be set by the Wegent executor."
        exit 1
    fi
}

get_auth_token() {
    echo "$WEGENT_SKILL_IDENTITY_TOKEN"
}

get_api_base() {
    echo "${TASK_API_DOMAIN:-http://backend:8000}"
}

urlencode() {
    python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"
}
