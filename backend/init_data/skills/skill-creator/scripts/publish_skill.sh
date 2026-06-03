#!/bin/bash
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Publish a Skill directory to Wegent through the Skill upload API.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

SKILL_PATH=""
SKILL_NAME=""
NAMESPACE="default"
OVERWRITE=""

POSITIONAL=()
for arg in "$@"; do
    if [ "$arg" = "--overwrite" ]; then
        OVERWRITE="true"
    else
        POSITIONAL+=("$arg")
    fi
done

SKILL_PATH="${POSITIONAL[0]:-}"
SKILL_NAME="${POSITIONAL[1]:-}"
if [ -n "${POSITIONAL[2]:-}" ]; then
    NAMESPACE="${POSITIONAL[2]}"
fi

if [ -z "$SKILL_PATH" ] || [ -z "$SKILL_NAME" ]; then
    echo "Error: skill_path and skill_name are required"
    echo ""
    echo "Usage: publish_skill.sh <skill_path> <skill_name> [namespace] [--overwrite]"
    echo ""
    echo "Parameters:"
    echo "  skill_path   Path to the Skill directory, which must contain SKILL.md"
    echo "  skill_name   Name for the Skill in Wegent"
    echo "  namespace    Namespace, default for personal or a group namespace"
    echo "  --overwrite  Replace an existing Skill with the same name"
    exit 1
fi

SKILL_PATH="$(cd "$SKILL_PATH" 2>/dev/null && pwd)" || {
    echo "Error: Cannot resolve path: ${POSITIONAL[0]}"
    exit 1
}

validate_skill_directory "$SKILL_PATH"
check_auth

AUTH_TOKEN="$(get_auth_token)"
API_BASE="$(get_api_base)"
TMP_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "Packaging skill: $SKILL_NAME"

SKILL_DIR_NAME="$(basename "$SKILL_PATH")"
ZIP_FILE="$TMP_DIR/${SKILL_NAME}.zip"

if [ "$SKILL_DIR_NAME" != "$SKILL_NAME" ]; then
    mkdir -p "$TMP_DIR/pkg/$SKILL_NAME"
    cp -R "$SKILL_PATH"/. "$TMP_DIR/pkg/$SKILL_NAME/"
    cd "$TMP_DIR/pkg"
    zip -rq "$ZIP_FILE" "$SKILL_NAME"
else
    cd "$(dirname "$SKILL_PATH")"
    zip -rq "$ZIP_FILE" "$SKILL_NAME"
fi

echo "Checking for existing skill..."

ENCODED_NAME="$(urlencode "$SKILL_NAME")"
ENCODED_NAMESPACE="$(urlencode "$NAMESPACE")"
CHECK_URL="$API_BASE/api/v1/kinds/skills?name=${ENCODED_NAME}&namespace=${ENCODED_NAMESPACE}&exact_match=true"
EXISTING="$(
    curl -s \
        --connect-timeout 10 \
        --max-time 30 \
        -H "Authorization: Bearer $AUTH_TOKEN" \
        "$CHECK_URL" 2>/dev/null || echo '{"items":[]}'
)"
EXISTING_ID="$(echo "$EXISTING" | jq -r '.items[0].metadata.labels.id // .items[0].id // empty')"

ACTION="created"
if [ -n "$EXISTING_ID" ] && [ "$EXISTING_ID" != "null" ]; then
    if [ "$OVERWRITE" != "true" ]; then
        echo "Skill '$SKILL_NAME' already exists in namespace '$NAMESPACE'."
        echo "Use --overwrite to replace it, or choose a different skill name."
        exit 1
    fi

    echo "Updating existing skill: $EXISTING_ID"
    RESPONSE="$(
        curl -s -X PUT \
            --connect-timeout 10 \
            --max-time 60 \
            -H "Authorization: Bearer $AUTH_TOKEN" \
            -F "file=@$ZIP_FILE" \
            "$API_BASE/api/v1/kinds/skills/$EXISTING_ID"
    )"
    ACTION="updated"
else
    echo "Publishing skill to Wegent..."
    RESPONSE="$(
        curl -s -X POST \
            --connect-timeout 10 \
            --max-time 60 \
            -H "Authorization: Bearer $AUTH_TOKEN" \
            -F "file=@$ZIP_FILE" \
            -F "name=$SKILL_NAME" \
            -F "namespace=$NAMESPACE" \
            "$API_BASE/api/v1/kinds/skills/upload"
    )"
fi

NEW_ID="$(echo "$RESPONSE" | jq -r '.metadata.labels.id // .id // empty')"

if [ -n "$NEW_ID" ] && [ "$NEW_ID" != "null" ]; then
    echo ""
    echo "Skill published successfully."
    echo "Name: $SKILL_NAME"
    echo "Namespace: $NAMESPACE"
    echo "Skill ID: $NEW_ID"
    echo "Status: $ACTION"
else
    ERROR="$(echo "$RESPONSE" | jq -r '.detail // .message // "Unknown error"')"
    echo "Publish failed: $ERROR"
    if [ "${VERBOSE:-}" = "1" ]; then
        echo "Response: $RESPONSE"
    fi
    exit 1
fi
