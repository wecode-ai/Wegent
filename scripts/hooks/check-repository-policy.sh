#!/usr/bin/env bash
# Check for unapproved repository policy matches.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
POLICY_ROOT="${REPOSITORY_POLICY_ROOT:-$PROJECT_ROOT}"

if ! command -v git >/dev/null 2>&1; then
    echo "git is required to scan repository references." >&2
    exit 2
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

PATTERN_FILE="$TMP_DIR/pattern.txt"
APPROVED_MATCHES="$TMP_DIR/approved-matches.txt"
RAW_MATCHES="$TMP_DIR/raw-matches.txt"
CURRENT_MATCHES="$TMP_DIR/current-matches.txt"
UNAPPROVED_MATCHES="$TMP_DIR/unapproved-matches.txt"
STALE_APPROVALS="$TMP_DIR/stale-approvals.txt"

decode_base64_config() {
    local value="$1"
    local output_file="$2"
    local label="$3"

    if [ -z "$value" ]; then
        echo "$label is not configured." >&2
        exit 2
    fi

    if printf '%s' "$value" | base64 --decode > "$output_file" 2>/dev/null; then
        return
    fi
    if printf '%s' "$value" | base64 -d > "$output_file" 2>/dev/null; then
        return
    fi
    if printf '%s' "$value" | base64 -D > "$output_file" 2>/dev/null; then
        return
    fi

    echo "$label is not valid base64." >&2
    exit 2
}

decode_base64_config "${REPOSITORY_POLICY_PATTERN_B64:-}" "$PATTERN_FILE" "REPOSITORY_POLICY_PATTERN_B64"
decode_base64_config "${REPOSITORY_POLICY_APPROVED_B64:-}" "$APPROVED_MATCHES" "REPOSITORY_POLICY_APPROVED_B64"

if [ ! -s "$PATTERN_FILE" ]; then
    echo "Repository policy pattern is empty." >&2
    exit 2
fi

if [ ! -d "$POLICY_ROOT" ]; then
    echo "Repository policy root does not exist: $POLICY_ROOT" >&2
    exit 2
fi

cd "$POLICY_ROOT"

set +e
git grep --full-name -n -E --untracked --exclude-standard -f "$PATTERN_FILE" -- . \
    ':(exclude)scripts/hooks/check-repository-policy.sh' \
    > "$RAW_MATCHES"
GREP_STATUS=$?
set -e

if [ "$GREP_STATUS" -gt 1 ]; then
    echo "Failed to scan repository references." >&2
    exit 2
fi

if [ -s "$RAW_MATCHES" ]; then
    awk '{
        raw = $0
        file = raw
        sub(/:[0-9]+:.*/, "", file)
        if (substr(file, 1, 2) != "./") {
            file = "./" file
        }
        content = raw
        sub(/^[^:]+:[0-9]+:/, "", content)
        key = file " :: " content
        print key
    }' "$RAW_MATCHES" | sort > "$CURRENT_MATCHES"
else
    : > "$CURRENT_MATCHES"
fi

sort "$APPROVED_MATCHES" -o "$APPROVED_MATCHES"
comm -23 "$CURRENT_MATCHES" "$APPROVED_MATCHES" > "$UNAPPROVED_MATCHES"
comm -13 "$CURRENT_MATCHES" "$APPROVED_MATCHES" > "$STALE_APPROVALS"

if [ -s "$UNAPPROVED_MATCHES" ]; then
    UNAPPROVED_COUNT="$(wc -l < "$UNAPPROVED_MATCHES" | tr -d '[:space:]')"
    echo "Found $UNAPPROVED_COUNT unapproved repository policy match(es)."
    echo ""
    echo "Remove these references or update the approved reference list in GitHub Actions settings."
    exit 1
fi

if [ -s "$STALE_APPROVALS" ]; then
    echo "Warning: approved repository policy matches were not found in the current tree."
    echo "Review the approved reference list in GitHub Actions settings."
fi

echo "No unapproved repository policy matches found."
