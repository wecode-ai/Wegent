#!/usr/bin/env bash
# Regression test for standalone image verification gates in publish-image workflow.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW="$PROJECT_ROOT/.github/workflows/publish-image.yml"

extract_job() {
    local arch="$1"
    awk -v start="  build-standalone-${arch}:" '
        $0 == start {
            in_block = 1
            print
            next
        }
        in_block && $0 ~ /^  [A-Za-z0-9_-]+:$/ {
            exit
        }
        in_block {
            print
        }
    ' "$WORKFLOW"
}

require_line() {
    local block="$1"
    local pattern="$2"
    local description="$3"

    if ! grep -Fq "$pattern" <<< "$block"; then
        echo "Expected ${description}: ${pattern}"
        exit 1
    fi
}

line_number() {
    local block="$1"
    local pattern="$2"

    awk -v pattern="$pattern" 'index($0, pattern) { print NR; exit }' <<< "$block"
}

verify_arch_gate() {
    local arch="$1"
    local block
    block="$(extract_job "$arch")"

    require_line "$block" "Build standalone image for verification (${arch})" "${arch} verification build step"
    require_line "$block" "load: true" "${arch} local Docker load"
    require_line "$block" "Verify standalone image startup (${arch})" "${arch} startup verification step"
    require_line "$block" 'run: bash scripts/verify-standalone-image.sh "$IMAGE"' "${arch} verification script call"
    require_line "$block" "Push verified standalone image (${arch})" "${arch} verified push step"

    local build_line verify_line push_line
    build_line="$(line_number "$block" "Build standalone image for verification (${arch})")"
    verify_line="$(line_number "$block" "Verify standalone image startup (${arch})")"
    push_line="$(line_number "$block" "Push verified standalone image (${arch})")"

    if [ "$build_line" -ge "$verify_line" ] || [ "$verify_line" -ge "$push_line" ]; then
        echo "Expected ${arch} standalone job order to be build, verify, then push."
        exit 1
    fi
}

verify_arch_gate "amd64"
verify_arch_gate "arm64"

echo "publish-image standalone gate regression test passed"
