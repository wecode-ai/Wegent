#!/usr/bin/env bash

set -euo pipefail

if (($# != 3)); then
  echo "usage: $0 <repository-owner> <executor-source-digest> <backend-rs-source-digest>" >&2
  exit 2
fi

repository_owner="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
executor_source_digest="$2"
backend_rs_source_digest="$3"
manifest="$(mktemp)"
trap 'rm -f "$manifest"' EXIT

git -c "safe.directory=$PWD" ls-files -s -- \
  .github/actions/build-wework-macos-e2e \
  .github/actions/setup-rust-cache \
  .github/ci/rust-toolchain \
  .github/scripts/archive-wework-macos-e2e-build.sh \
  .github/scripts/build-macos-e2e-runtimes.sh \
  .github/scripts/macos-e2e-build.mjs \
  .github/scripts/verified-build-oci.mjs \
  .github/scripts/restore-wework-macos-e2e-build.sh \
  .github/scripts/resolve-wework-macos-e2e-build-ref.sh \
  .npmrc \
  package.json \
  packages \
  patches \
  scripts \
  sdk \
  shared/assets \
  shared/data \
  LICENSES \
  pnpm-lock.yaml \
  pnpm-workspace.yaml \
  wework \
  ':(exclude)wework/e2e/**' \
  ':(exclude)wework/test-results/**' \
  >"$manifest"

{
  printf 'platform=darwin-arm64\n'
  printf 'executor-source=%s\n' "$executor_source_digest"
  printf 'backend-rs-source=%s\n' "$backend_rs_source_digest"
} >>"$manifest"

source_digest="$(shasum -a 256 "$manifest" | cut -d ' ' -f 1)"
reference="ghcr.io/$repository_owner/wegent-wework-macos-e2e-runtime:app-v1-$source_digest"
output_file="${GITHUB_OUTPUT:-/dev/stdout}"
printf 'reference=%s\n' "$reference" >>"$output_file"
