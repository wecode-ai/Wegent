#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW="$PROJECT_ROOT/.github/workflows/publish-image.yml"

release_step="$(
    awk '
        /^      - name: Create GitHub Release$/ {
            in_step = 1
        }
        in_step && /^      - name:/ && $0 !~ /Create GitHub Release$/ {
            exit
        }
        in_step {
            print
        }
    ' "$WORKFLOW"
)"

if [ -z "$release_step" ]; then
    echo "Create GitHub Release step was not found."
    exit 1
fi

if ! grep -Fq "make_latest: false" <<< "$release_step"; then
    echo "Wegent releases must not be marked as the latest GitHub release."
    exit 1
fi

echo "publish-image release policy regression test passed"
