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

# A newly updated base may precede its prewarm. Consider only its recent
# first-parent history, whose images are published by the trusted main workflow.
if [[ "$(git rev-parse --is-shallow-repository)" == true && "$(git rev-list --first-parent --count --max-count=8 "$base_sha" 2>/dev/null || true)" != 8 ]]; then
  git fetch --no-tags --depth=8 origin "$base_sha" >&2 || exit 0
fi

recipe=.github/runtime-images/backend-rs-builder.Dockerfile
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
dependency_recipe="$(sed '/^FROM \${DEPS_IMAGE} AS build$/,$d' "$recipe")"
previous_image=""

while IFS= read -r revision; do
  [[ "$(git show "$revision:.github/ci/rust-toolchain" 2>/dev/null || true)" == "$(cat .github/ci/rust-toolchain)" ]] || break
  if ! prior_recipe="$(git show "$revision:$recipe" 2>/dev/null)"; then break; fi
  [[ "$(sed '/^FROM \${DEPS_IMAGE} AS build$/,$d' <<< "$prior_recipe")" == "$dependency_recipe" ]] || break

  snapshot="$temporary/$revision"
  mkdir -p "$snapshot"
  git archive "$revision" backend-rs shared/rust shared/assets/calendars \
    .github/ci/rust-toolchain "$recipe" | tar -xf - -C "$snapshot"

  # The build synchronizes the current lockfile and runs Cargo with --locked.
  # Cargo fingerprints decide which compiled dependencies are still reusable.
  dependencies="$(node --input-type=module - "$owner" "$snapshot" <<'JS'
import { prebuiltImage } from './.github/scripts/ci-prebuilt-images.mjs'
const [, , owner, directory] = process.argv
console.log(prebuiltImage('backend-rs-deps', owner, '', directory).image)
JS
)"
  if [[ "$dependencies" != "$previous_image" ]] && docker manifest inspect "$dependencies" >/dev/null 2>&1; then
    printf '%s\n' "$dependencies"
    exit 0
  fi
  previous_image="$dependencies"
  rm -rf "$snapshot"
done < <(git rev-list --first-parent --max-count=8 "$base_sha")
