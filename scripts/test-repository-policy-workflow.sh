#!/usr/bin/env bash
# Regression test for repository policy workflows.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
POLICY_WORKFLOW="$PROJECT_ROOT/.github/workflows/repository-policy.yml"
LINT_WORKFLOW="$PROJECT_ROOT/.github/workflows/lint.yml"

require_file() {
    local file="$1"

    if [ ! -f "$file" ]; then
        echo "Expected workflow file to exist: $file"
        exit 1
    fi
}

require_line() {
    local file="$1"
    local pattern="$2"
    local description="$3"

    if ! grep -Fq "$pattern" "$file"; then
        echo "Expected ${description}: ${pattern}"
        exit 1
    fi
}

require_file "$POLICY_WORKFLOW"
require_line "$POLICY_WORKFLOW" "pull_request_target:" "trusted fork PR trigger"
require_line "$POLICY_WORKFLOW" "merge_group:" "merge queue trigger"
require_line "$POLICY_WORKFLOW" "checks_requested" "merge queue checks activity"
require_line "$POLICY_WORKFLOW" "contents: read" "read-only repository permission"
require_line "$POLICY_WORKFLOW" "path: trusted-policy" "trusted script checkout path"
require_line "$POLICY_WORKFLOW" "path: policy-target" "PR content checkout path"
# GitHub expressions are matched literally in workflow source.
# shellcheck disable=SC2016
require_line "$POLICY_WORKFLOW" 'repository: ${{ github.event.pull_request.head.repo.full_name }}' "PR head repository checkout"
# shellcheck disable=SC2016
require_line "$POLICY_WORKFLOW" 'ref: ${{ github.event.pull_request.head.sha }}' "immutable PR head SHA checkout"
require_line "$POLICY_WORKFLOW" "Checkout merge group" "merge group checkout step"
# shellcheck disable=SC2016
require_line "$POLICY_WORKFLOW" 'ref: ${{ github.sha }}' "merge group SHA checkout"
require_line "$POLICY_WORKFLOW" "REPOSITORY_POLICY_ROOT: \${{ github.workspace }}/policy-target" "target repository scan root"
require_line "$POLICY_WORKFLOW" "trusted-policy/scripts/hooks/check-repository-policy.sh" "trusted policy script execution"

require_line "$LINT_WORKFLOW" "github.event.pull_request.head.repo.full_name == github.repository" "lint policy check fork guard"

echo "repository policy workflow regression tests passed"
