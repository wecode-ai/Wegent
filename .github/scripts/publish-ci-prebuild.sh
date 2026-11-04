#!/usr/bin/env bash
set -euo pipefail

component="${1:?runtime component or downloads is required}"
owner="${GITHUB_REPOSITORY_OWNER:?registry owner is required}"
case "$component" in
  executor) kind=executor-deps ;;
  backend-rs) kind=backend-rs-deps ;;
  downloads) kind=downloads ;;
  *) echo "Unsupported CI prebuild: $component" >&2; exit 1 ;;
esac

metadata="$(node .github/scripts/ci-prebuilt-images.mjs "$kind" "$owner" "${BASE_IMAGE:-}")"
image="$(jq -r .image <<< "$metadata")"
dockerfile="$(jq -r .dockerfile <<< "$metadata")"
target="$(jq -r .target <<< "$metadata")"
source_label="org.opencontainers.image.source=https://github.com/${GITHUB_REPOSITORY:?repository is required}"
cache=()
if [[ "$component" == executor ]]; then
  cache_ref="${EXECUTOR_BUILD_CACHE:?Executor registry cache is required}"
  cache_ref="${cache_ref,,}"
  cache+=(--cache-from "type=registry,ref=$cache_ref")
  if [[ "${GITHUB_REF:-}" == refs/heads/main ]]; then
    cache+=(--cache-to "type=registry,ref=$cache_ref,mode=max")
  fi
fi
if ! docker buildx imagetools inspect "$image" >/dev/null 2>&1; then
  arguments=(--platform linux/amd64 --file "$dockerfile" --tag "$image" --label "$source_label")
  [[ -z "$target" ]] || arguments+=(--target "$target")
  [[ "$component" != executor ]] || arguments+=(--build-arg "BASE_IMAGE=$BASE_IMAGE")
  docker buildx build --load "${arguments[@]}" "${cache[@]}" .
  docker push "$image"
fi
echo "Published CI prebuild: $image"

if [[ "$component" == executor ]]; then
  runtime="${RUNTIME_IMAGE:?Executor runtime reference is required}"
  if ! docker buildx imagetools inspect "$runtime" >/dev/null 2>&1; then
    docker buildx build --load --platform linux/amd64 --file "$dockerfile" "${cache[@]}" \
      --build-arg "BASE_IMAGE=$BASE_IMAGE" --build-arg "DEPS_IMAGE=$image" --tag "$runtime" --label "$source_label" .
    docker push "$runtime"
  fi
  echo "Published Executor runtime: $runtime"
elif [[ "$component" == backend-rs ]]; then
  runtime="${RUNTIME_IMAGE:?Backend runtime reference is required}"
  if ! docker buildx imagetools inspect "$runtime" >/dev/null 2>&1; then
    docker buildx build --load --platform linux/amd64 --file "$dockerfile" \
      --build-arg "DEPS_IMAGE=$image" --target runtime --tag "$runtime" --label "$source_label" .
    docker push "$runtime"
  fi
  echo "Published Backend runtime: $runtime"
fi
