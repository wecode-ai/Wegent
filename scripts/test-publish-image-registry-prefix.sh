#!/usr/bin/env bash
# Regression test for fork-safe GHCR image owner normalization.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PUBLISH_WORKFLOW="$PROJECT_ROOT/.github/workflows/publish-image.yml"
SNAPSHOT_WORKFLOW="$PROJECT_ROOT/.github/workflows/snapshot-image.yml"

require_line() {
    local file="$1"
    local pattern="$2"
    local description="$3"

    if ! grep -Fq "$pattern" "$file"; then
        echo "Expected ${description}: ${pattern}"
        exit 1
    fi
}

reject_line() {
    local file="$1"
    local pattern="$2"
    local description="$3"

    if grep -Fq "$pattern" "$file"; then
        echo "Unexpected ${description}: ${pattern}"
        exit 1
    fi
}

verify_no_uppercase_owner_prefix() {
    local file="$1"

    reject_line "$file" 'ghcr.io/${{ github.repository_owner }}' "raw repository owner in GHCR image prefix"
    reject_line "$file" '${{ env.IMAGE_PREFIX }}' "workflow env IMAGE_PREFIX reference"
}

verify_publish_workflow() {
    verify_no_uppercase_owner_prefix "$PUBLISH_WORKFLOW"

    require_line "$PUBLISH_WORKFLOW" "github.event.pull_request.merge_commit_sha || github.sha" "workflow_dispatch checkout ref"
    require_line "$PUBLISH_WORKFLOW" 'image_prefix: ${{ steps.get_version.outputs.image_prefix }}' "prepare-release image prefix output"
    require_line "$PUBLISH_WORKFLOW" 'OWNER_LOWER="${GITHUB_REPOSITORY_OWNER,,}"' "lowercase owner derivation"
    require_line "$PUBLISH_WORKFLOW" 'echo "image_prefix=${REGISTRY}/${OWNER_LOWER}" >> "$GITHUB_OUTPUT"' "lowercase image prefix output"
    require_line "$PUBLISH_WORKFLOW" '${{ needs.prepare-release.outputs.image_prefix }}/wegent-backend' "publish image tag prefix"
    require_line "$PUBLISH_WORKFLOW" 'IMAGE_PREFIX: ${{ needs.prepare-release.outputs.image_prefix }}' "manifest image prefix env"
}

verify_snapshot_workflow() {
    verify_no_uppercase_owner_prefix "$SNAPSHOT_WORKFLOW"

    require_line "$SNAPSHOT_WORKFLOW" 'image_prefix: ${{ steps.meta.outputs.image_prefix }}' "prepare-snapshot image prefix output"
    require_line "$SNAPSHOT_WORKFLOW" 'OWNER_LOWER="${GITHUB_REPOSITORY_OWNER,,}"' "lowercase owner derivation"
    require_line "$SNAPSHOT_WORKFLOW" 'IMAGE_PREFIX="${REGISTRY}/${OWNER_LOWER}"' "lowercase image prefix assignment"
    require_line "$SNAPSHOT_WORKFLOW" 'echo "image_prefix=${IMAGE_PREFIX}" >> "$GITHUB_OUTPUT"' "lowercase image prefix output"
    require_line "$SNAPSHOT_WORKFLOW" '${{ needs.prepare-snapshot.outputs.image_prefix }}/${{ matrix.image.name }}' "snapshot image tag prefix"
    require_line "$SNAPSHOT_WORKFLOW" 'IMAGE_PREFIX: ${{ needs.prepare-snapshot.outputs.image_prefix }}' "snapshot manifest image prefix env"
}

verify_publish_workflow
verify_snapshot_workflow

echo "publish image registry prefix regression test passed"
