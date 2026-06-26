#!/usr/bin/env bash
# Check for unapproved restricted domain references.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if ! command -v rg >/dev/null 2>&1; then
    echo "ripgrep (rg) is required to scan restricted domain references." >&2
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

decode_base64_config "${RESTRICTED_DOMAIN_PATTERN_B64:-}" "$PATTERN_FILE" "RESTRICTED_DOMAIN_PATTERN_B64"
decode_base64_config "${APPROVED_DOMAIN_REFERENCES_B64:-}" "$APPROVED_MATCHES" "APPROVED_DOMAIN_REFERENCES_B64"

if [ ! -s "$PATTERN_FILE" ]; then
    echo "Restricted domain pattern is empty." >&2
    exit 2
fi

cd "$PROJECT_ROOT"

set +e
rg --hidden --no-heading --line-number --color never --file "$PATTERN_FILE" . \
    --glob '!**/.git/**' \
    --glob '!**/node_modules/**' \
    --glob '!**/.next/**' \
    --glob '!**/dist/**' \
    --glob '!**/build/**' \
    --glob '!scripts/hooks/check-restricted-domain-links.sh' \
    > "$RAW_MATCHES"
RG_STATUS=$?
set -e

if [ "$RG_STATUS" -gt 1 ]; then
    echo "Failed to scan restricted domain references." >&2
    exit 2
fi

if [ -s "$RAW_MATCHES" ]; then
    awk '{
        raw = $0
        file = raw
        sub(/:[0-9]+:.*/, "", file)
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
    echo "Found $UNAPPROVED_COUNT unapproved restricted domain reference(s)."
    echo ""
    echo "Remove these references or update the approved reference list in GitHub Actions settings."
    exit 1
fi

if [ -s "$STALE_APPROVALS" ]; then
    echo "Warning: approved restricted domain references not found in the current tree."
    echo "Review the approved reference list in GitHub Actions settings."
fi

echo "No unapproved restricted domain references found."
