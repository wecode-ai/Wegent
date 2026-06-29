#!/usr/bin/env bash
# Regression tests for repository policy scanning.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

encode_base64() {
    printf '%s' "$1" | base64 | tr -d '\n'
}

TARGET_REPO="$TMP_DIR/target-repo"
mkdir -p "$TARGET_REPO"
git init -q "$TARGET_REPO"
printf 'const endpoint = "https://%s%s/path";\n' \
    'target-policy-marker' \
    '.invalid' \
    > "$TARGET_REPO/unsafe.txt"

PATTERN_B64="$(encode_base64 'target-policy-marker[.]invalid')"
APPROVED_B64="$(printf '\n' | base64 | tr -d '\n')"

set +e
OUTPUT="$(
    REPOSITORY_POLICY_ROOT="$TARGET_REPO" \
    REPOSITORY_POLICY_PATTERN_B64="$PATTERN_B64" \
    REPOSITORY_POLICY_APPROVED_B64="$APPROVED_B64" \
    bash "$PROJECT_ROOT/scripts/hooks/check-repository-policy.sh" 2>&1
)"
STATUS=$?
set -e

if [ "$STATUS" -ne 1 ]; then
    echo "Expected external policy root scan to find one unapproved match."
    echo "Exit status: $STATUS"
    echo "$OUTPUT"
    exit 1
fi

if ! grep -Fq "Found 1 unapproved repository policy match(es)." <<< "$OUTPUT"; then
    echo "Expected unapproved match count in output."
    echo "$OUTPUT"
    exit 1
fi

echo "repository policy regression tests passed"
