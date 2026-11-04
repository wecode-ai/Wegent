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

target=linux-x64
profile=release
case "$artifact:$component" in
  executor-e2e-binary:executor) export ACTIONS_ARTIFACT_JOB='Prepare Executor E2E Runtime' ;;
  backend-rs-e2e-runtime:backend-rs) export ACTIONS_ARTIFACT_JOB='Build Backend Rust E2E Runtime' ;;
  macos-executor-e2e-binary:executor|macos-backend-rs-e2e-runtime:backend-rs)
    export ACTIONS_ARTIFACT_JOB='Wework Desktop macOS E2E'
    target=darwin-arm64
    [[ "$component" != backend-rs ]] || profile=dev
    ;;
  *) echo "Unsupported runtime artifact/component: $artifact/$component" >&2; exit 1 ;;
esac

"$script_dir/download-actions-artifact.sh" "$artifact" "$temporary"
verification_started=$SECONDS
RUNTIME_HEAD_SHA="${ACTIONS_ARTIFACT_HEAD_SHA:?source SHA is required}" \
  RUNTIME_TARGET="$target" RUNTIME_PROFILE="$profile" \
  node "$script_dir/runtime-artifact.mjs" verify \
    "$temporary" "$component" "$source_ref" "$binary"
mkdir -p "$(dirname "$destination")"
install -m 0755 "$temporary/$binary" "$temporary/verified-runtime"
mv "$temporary/verified-runtime" "${destination}.restore.$$"
mv -f "${destination}.restore.$$" "$destination"
printf '[actions-runtime] component=%s phase=verify-install seconds=%s\n' \
  "$component" "$((SECONDS - verification_started))" >&2
