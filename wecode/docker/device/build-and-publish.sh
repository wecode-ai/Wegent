#!/usr/bin/env bash
set -euo pipefail

# Internal GitLab policy for building and publishing the public device image.
DEVICE_IMAGE_REPOSITORY="${DEVICE_IMAGE_REPOSITORY:-registry.api.weibo.com/ci/wegent-device}"
DEVICE_IMAGE_PUSH_REPOSITORY="${DEVICE_IMAGE_PUSH_REPOSITORY:-pushregistry.api.weibo.com/ci/wegent-device}"
BUILDKIT_IMAGE="${BUILDKIT_IMAGE:-registry.api.weibo.com/ci/moby/buildkit:buildx-stable-1}"
EXECUTOR_VERSION="$(sed -n 's/^version = "\([^"]*\)"/\1/p' executor/Cargo.toml | head -1)"
DEVICE_IMAGE_VERSION="${DEVICE_IMAGE_VERSION:-$EXECUTOR_VERSION}"

if [[ -z "$EXECUTOR_VERSION" ]]; then
  echo "Unable to read the executor version from executor/Cargo.toml" >&2
  exit 1
fi

BUILDER_NAME="wegent-device-builder-${CI_JOB_ID}"
trap 'docker buildx rm "$BUILDER_NAME" >/dev/null 2>&1 || true' EXIT

python3 - <<'PY'
import subprocess
import sys

sys.path.insert(0, "/ci")
from build.build_image import BuildImage

build_image = BuildImage()
subprocess.run(
    [
        "docker",
        "login",
        build_image.push_registry_address,
        "--username",
        build_image.registry_account,
        "--password-stdin",
    ],
    input=build_image.registry_password.encode(),
    check=True,
)
PY

docker buildx create \
  --name "$BUILDER_NAME" \
  --driver docker-container \
  --driver-opt "image=$BUILDKIT_IMAGE"
docker buildx inspect "$BUILDER_NAME" --bootstrap

push_image="${DEVICE_IMAGE_PUSH_REPOSITORY}:${DEVICE_IMAGE_VERSION}"
runtime_image="${DEVICE_IMAGE_REPOSITORY}:${DEVICE_IMAGE_VERSION}"
executor_version_push_image="${DEVICE_IMAGE_PUSH_REPOSITORY}:${EXECUTOR_VERSION}"
executor_version_runtime_image="${DEVICE_IMAGE_REPOSITORY}:${EXECUTOR_VERSION}"
docker buildx build \
  --builder "$BUILDER_NAME" \
  --platform linux/amd64 \
  --file docker/device/Dockerfile \
  --build-arg "APP_VERSION=${EXECUTOR_VERSION}" \
  --build-arg "VCS_REF=${CI_COMMIT_SHA}" \
  --build-arg "DEVICE_BASE_IMAGE=${DEVICE_BASE_IMAGE:-ubuntu:26.04}" \
  --build-arg "DEVICE_APT_MIRROR=${DEVICE_APT_MIRROR:-http://mirrors.cloud.aliyuncs.com/ubuntu}" \
  --build-arg "DEVICE_APT_PORTS_MIRROR=${DEVICE_APT_PORTS_MIRROR:-http://mirrors.cloud.aliyuncs.com/ubuntu-ports}" \
  --build-arg "RUSTUP_INIT_URL=${RUSTUP_INIT_URL:-https://rsproxy.cn/rustup-init.sh}" \
  --build-arg "RUSTUP_DIST_SERVER=${RUSTUP_DIST_SERVER:-https://rsproxy.cn}" \
  --build-arg "RUSTUP_UPDATE_ROOT=${RUSTUP_UPDATE_ROOT:-https://rsproxy.cn/rustup}" \
  --build-arg "CARGO_REGISTRIES_CRATES_IO_INDEX=${CARGO_REGISTRIES_CRATES_IO_INDEX:-sparse+https://rsproxy.cn/index/}" \
  --build-arg "CARGO_HTTPS_PROXY=${CARGO_HTTPS_PROXY:-http://wproxy.intra.weibo.com:8889}" \
  --build-arg "NODE_VERSION=${NODE_VERSION:-22.23.2}" \
  --build-arg "NODE_DIST_MIRROR=${NODE_DIST_MIRROR:-https://npmmirror.com/mirrors/node}" \
  --build-arg "NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}" \
  --build-arg "CODE_SERVER_REPOSITORY_RAW=${CODE_SERVER_REPOSITORY_RAW:-https://raw.githubusercontent.com/coder/code-server}" \
  --build-arg "CODE_SERVER_HTTPS_PROXY=${CODE_SERVER_HTTPS_PROXY:-http://wproxy.intra.weibo.com:8889}" \
  --tag "$push_image" \
  --load \
  .

actual_architecture="$(docker image inspect --format '{{.Architecture}}' "$push_image")"
actual_version="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$push_image")"
actual_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$push_image")"
if ! actual_executor_version="$(docker run --rm --platform linux/amd64 --entrypoint /app/executor "$push_image" --version 2>&1)"; then
  echo "Executor version check failed: ${actual_executor_version}" >&2
  exit 1
fi
printf 'Local image verification: architecture=%s version=%s revision=%s executor=%s\n' \
  "$actual_architecture" "$actual_version" "$actual_revision" "$actual_executor_version"
test "$actual_architecture" = "amd64"
test "$actual_version" = "$EXECUTOR_VERSION"
test "$actual_revision" = "$CI_COMMIT_SHA"
test "$actual_executor_version" = "$EXECUTOR_VERSION"

if [[ -n "${CI_COMMIT_BRANCH:-}" ]]; then
  branch_head="$(git ls-remote origin "refs/heads/${CI_COMMIT_BRANCH}" | awk '{print $1}')"
  if [[ "$branch_head" != "$CI_COMMIT_SHA" ]]; then
    echo "Skipping image publication because ${CI_COMMIT_SHA} is no longer the branch head (${branch_head})"
    exit 0
  fi
fi

push_output="$(docker push "$push_image" 2>&1)"
echo "$push_output"
pushed_digest="$(sed -n 's/.*digest: \(sha256:[0-9a-f]*\).*/\1/p' <<<"$push_output" | tail -1)"
if [[ -z "$pushed_digest" ]]; then
  echo "Unable to read the pushed image digest" >&2
  exit 1
fi

wait_for_runtime_digest() {
  local image="$1"
  local expected_digest="$2"
  local consecutive_current=0
  local observed_digest
  for attempt in $(seq 1 120); do
    observed_digest="$(
      timeout --signal=TERM --kill-after=5s 15s \
        docker buildx imagetools inspect "$image" 2>/dev/null \
        | awk '/^Digest:/ {print $2; exit}' \
        || true
    )"
    if [[ "$observed_digest" = "$expected_digest" ]]; then
      consecutive_current=$((consecutive_current + 1))
    else
      consecutive_current=0
    fi
    printf 'Runtime registry verification: image=%s attempt=%s digest=%s consecutive_current=%s\n' \
      "$image" "$attempt" "${observed_digest:-unavailable}" "$consecutive_current"
    if [[ "$consecutive_current" -ge 5 ]]; then
      return 0
    fi
    sleep 5
  done
  return 1
}

wait_for_runtime_digest "$runtime_image" "$pushed_digest"

docker pull --platform linux/amd64 "$runtime_image"
published_architecture="$(docker image inspect --format '{{.Architecture}}' "$runtime_image")"
published_version="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$runtime_image")"
published_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$runtime_image")"
if ! published_executor_version="$(docker run --rm --platform linux/amd64 --entrypoint /app/executor "$runtime_image" --version 2>&1)"; then
  echo "Published Executor version check failed: ${published_executor_version}" >&2
  exit 1
fi
printf 'Published image verification: architecture=%s version=%s revision=%s executor=%s\n' \
  "$published_architecture" "$published_version" "$published_revision" "$published_executor_version"
test "$published_architecture" = "amd64"
test "$published_version" = "$EXECUTOR_VERSION"
test "$published_revision" = "$CI_COMMIT_SHA"
test "$published_executor_version" = "$EXECUTOR_VERSION"

if [[ "${CI_COMMIT_BRANCH:-}" = "${MASTER_BRANCH:-main}" \
  && "$DEVICE_IMAGE_VERSION" != "$EXECUTOR_VERSION" ]]; then
  docker tag "$push_image" "$executor_version_push_image"
  docker push "$executor_version_push_image"
  wait_for_runtime_digest "$executor_version_runtime_image" "$pushed_digest"
  printf 'Published main-branch compatibility tag: %s\n' "$executor_version_runtime_image"
fi
