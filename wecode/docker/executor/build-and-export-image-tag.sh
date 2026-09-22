#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build_log="$(mktemp)"
trap 'rm -f "$build_log"' EXIT

EXECUTOR_VERSION="$(bash "$script_dir/resolve-version.sh")"
export EXECUTOR_VERSION

build_image 2>&1 | tee "$build_log"

executor_image_tag="$(
  sed -n \
    's/.*image: ci\/wegent-executor:\([A-Za-z0-9_][A-Za-z0-9_.-]*\).*/\1/p' \
    "$build_log" \
    | tail -1
)"
if [[ -z "$executor_image_tag" || "${#executor_image_tag}" -gt 128 ]]; then
  echo "Unable to read a valid wegent-executor image tag from build_image output" >&2
  exit 1
fi

{
  printf 'EXECUTOR_IMAGE_TAG=%s\n' "$executor_image_tag"
  printf 'EXECUTOR_VERSION=%s\n' "$EXECUTOR_VERSION"
} > executor-image.env
printf 'Exported wegent-executor image tag: %s version: %s\n' \
  "$executor_image_tag" "$EXECUTOR_VERSION"
