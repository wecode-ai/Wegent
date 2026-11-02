#!/usr/bin/env bash
set -euo pipefail

artifact="${1:?artifact name is required}"
component="${2:?runtime component is required}"
binary="${3:?binary name is required}"
source_ref="${4:?content-addressed source is required}"
destination="${5:?destination is required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

case "$component" in
  executor) export ACTIONS_ARTIFACT_JOB='Prepare Executor E2E Runtime' ;;
  backend-rs) export ACTIONS_ARTIFACT_JOB='Build Backend Rust E2E Runtime' ;;
  *) echo "Unsupported runtime component: $component" >&2; exit 1 ;;
esac

"$script_dir/download-actions-artifact.sh" "$artifact" "$temporary"
RUNTIME_HEAD_SHA="${ACTIONS_ARTIFACT_HEAD_SHA:?source SHA is required}" \
  node "$script_dir/runtime-artifact.mjs" verify \
    "$temporary" "$component" "$source_ref" "$binary"
mkdir -p "$(dirname "$destination")"
install -m 0755 "$temporary/$binary" "$temporary/verified-runtime"
mv "$temporary/verified-runtime" "${destination}.restore.$$"
mv -f "${destination}.restore.$$" "$destination"
