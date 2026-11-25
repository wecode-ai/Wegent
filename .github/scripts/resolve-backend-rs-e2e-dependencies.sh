#!/usr/bin/env bash
set -euo pipefail

owner="${GITHUB_REPOSITORY_OWNER:?registry owner is required}"
metadata="$(node .github/scripts/ci-prebuilt-images.mjs backend-rs-deps "$owner")"
dependencies="$(jq -r .restoreImage <<< "$metadata")"
if docker manifest inspect "$dependencies" >/dev/null 2>&1; then
  printf '%s\n' "$dependencies"
  exit 0
fi

base_sha="${BASE_SHA:-}"
if [[ ! "$base_sha" =~ ^[a-f0-9]{40}$ ]]; then exit 0; fi
if ! git cat-file -e "$base_sha^{commit}" 2>/dev/null; then
  git fetch --no-tags --depth=1 origin "$base_sha" >&2 || exit 0
fi

recipe=.github/runtime-images/backend-rs-builder.Dockerfile
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
git archive "$base_sha" backend-rs shared/rust shared/assets/calendars \
  .github/ci/rust-toolchain "$recipe" | tar -xf - -C "$temporary"

if ! cmp -s .github/ci/rust-toolchain "$temporary/.github/ci/rust-toolchain" ||
  ! cmp -s backend-rs/Cargo.lock "$temporary/backend-rs/Cargo.lock" ||
  ! diff -q <(sed '/^FROM \${DEPS_IMAGE} AS build$/,$d' "$recipe") \
    <(sed '/^FROM \${DEPS_IMAGE} AS build$/,$d' "$temporary/$recipe") >&2; then
  exit 0
fi

dependencies="$(node --input-type=module - "$owner" "$temporary" <<'JS'
import { prebuiltImage } from './.github/scripts/ci-prebuilt-images.mjs'
const [, , owner, directory] = process.argv
console.log(prebuiltImage('backend-rs-deps', owner, '', directory).image)
JS
)"
if docker manifest inspect "$dependencies" >/dev/null 2>&1; then
  printf '%s\n' "$dependencies"
fi
