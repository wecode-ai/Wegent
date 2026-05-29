#!/bin/bash
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# list_publish_targets.sh - List Skill publish targets for the current Wegent user.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

emit_personal_only() {
    local warning="${1:-}"

    if [ -n "$warning" ]; then
        jq -n --arg warning "$warning" '{
            targets: [
                {
                    label: "Personal Skill Library",
                    namespace: "default",
                    type: "personal"
                }
            ],
            custom_allowed: true,
            warnings: [$warning]
        }'
    else
        jq -n '{
            targets: [
                {
                    label: "Personal Skill Library",
                    namespace: "default",
                    type: "personal"
                }
            ],
            custom_allowed: true,
            warnings: []
        }'
    fi
}

check_auth

AUTH_TOKEN="$(get_auth_token)"
API_BASE="$(get_api_base)"
GROUPS_URL="$API_BASE/api/groups?limit=100"

GROUPS_RESPONSE="$(
    curl -s \
        --connect-timeout 10 \
        --max-time 30 \
        -H "Authorization: Bearer $AUTH_TOKEN" \
        "$GROUPS_URL" 2>/dev/null || true
)"

if [ -z "$GROUPS_RESPONSE" ] || ! echo "$GROUPS_RESPONSE" | jq -e '.items | type == "array"' >/dev/null 2>&1; then
    emit_personal_only "Unable to load group publish targets from /api/groups"
    exit 0
fi

echo "$GROUPS_RESPONSE" | jq '{
    targets: (
        [
            {
                label: "Personal Skill Library",
                namespace: "default",
                type: "personal"
            }
        ]
        + (
            (.items // [])
            | map(
                select(.my_role == "Owner" or .my_role == "Maintainer")
                | {
                    label: (
                        if ((.display_name // "") != "" and .display_name != .name)
                        then (.display_name + " (" + .name + ")")
                        else .name
                        end
                    ),
                    namespace: .name,
                    type: "group",
                    role: .my_role
                }
            )
        )
    ),
    custom_allowed: true,
    warnings: []
}'
