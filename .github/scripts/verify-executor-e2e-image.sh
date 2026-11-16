#!/usr/bin/env bash
set -euo pipefail

image="${1:?Executor image is required}"
source_ref="${2:?Executor source reference is required}"
artifact_dir="${3:-.ci-artifacts}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary="$(mktemp -d)"
container_id=""
cleanup() {
  local status=$?
  if [[ -n "$container_id" ]]; then docker rm -f "$container_id" >/dev/null || status=1; fi
  rm -rf "$temporary" || status=1
  exit "$status"
}
trap cleanup EXIT

cp "$artifact_dir/executor-runtime-manifest.json" "$temporary/"
container_id="$(docker create "$image")"
test -n "$container_id"
docker cp "$container_id:/app/executor" "$temporary/wegent-executor"
node "$script_dir/runtime-artifact.mjs" verify "$temporary" executor "$source_ref" wegent-executor
