#!/usr/bin/env bash

set -euo pipefail

if (($# != 4)); then
  echo "usage: $0 <repository-owner> <desktop-image> <executor-image> <backend-rs-image>" >&2
  exit 2
fi

repository_owner="${1,,}"
desktop_image="$2"
executor_image="$3"
backend_rs_image="$4"
manifest="$(mktemp)"
trap 'rm -f "$manifest"' EXIT

git ls-files -s -- \
  .github/actions/build-wework-core-e2e \
  .github/actions/setup-node-workspace \
  .github/scripts/archive-wework-core-e2e-build.sh \
  .github/scripts/restore-oci-runtime-binary.sh \
  package.json \
  packages/chat-core \
  pnpm-lock.yaml \
  pnpm-workspace.yaml \
  wework \
  ':(exclude)wework/e2e/**' \
  ':(exclude)wework/test-results/**' \
  >"$manifest"

{
  printf 'desktop-image=%s\n' "$desktop_image"
  printf 'executor-image=%s\n' "$executor_image"
  printf 'backend-rs-image=%s\n' "$backend_rs_image"
} >>"$manifest"

source_digest="$(sha256sum "$manifest" | cut -d ' ' -f 1)"
reference="ghcr.io/$repository_owner/wegent-wework-core-e2e-build:v1-$source_digest"
output_file="${GITHUB_OUTPUT:-/dev/stdout}"
printf 'reference=%s\n' "$reference" >>"$output_file"
