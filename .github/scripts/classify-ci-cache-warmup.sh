#!/usr/bin/env bash

set -euo pipefail

declare -A changed=(
  [docker]=false
  [executor_rust]=false
  [backend_rs_rust]=false
  [node]=false
  [python]=false
  [wework_target]=false
)

mark_all() {
  local key
  for key in "${!changed[@]}"; do
    changed["$key"]=true
  done
}

classify_path() {
  local path="$1"

  case "$path" in
    .github/scripts/verified-build-oci.mjs)
      changed[node]=true
      changed[wework_target]=true
      ;;
    .github/actions/build-frontend-e2e/* | .github/scripts/frontend-e2e-build*.mjs | \
      .github/scripts/restore-frontend-ci-build.mjs | \
      .github/scripts/archive-frontend-e2e-build.sh | .github/scripts/restore-frontend-e2e-build.sh)
      changed[node]=true
      ;;
    .github/ci/rust-toolchain | .github/actions/* | .github/scripts/lib/apt-packages.sh | \
      .github/workflows/ci-cache-warmup.yml)
      mark_all
      ;;
    .github/runtime-images/* | .github/scripts/ci-prebuilt-images.* | LICENSES/Apache-2.0.txt | \
      .github/ci/prebuilt-images.json | .github/scripts/resolve-ci-image.* | \
      .github/scripts/publish-ci-prebuild.sh | .github/scripts/restore-ci-downloads.sh | \
      .github/scripts/wework-windows-e2e-build-key.mjs | \
      .github/scripts/archive-wework-core-e2e-build.sh | \
      .github/scripts/restore-wework-core-e2e-build.sh | \
      .github/scripts/wework-core-e2e-transport.* | \
      .github/scripts/download-actions-artifact.sh | \
      .github/scripts/restore-actions-runtime.sh | \
      .github/scripts/runtime-artifact.* | \
      .github/scripts/prepare-macos-inspector-e2e.sh | \
      .github/scripts/build-macos-e2e-runtimes.sh | \
      .github/scripts/macos-e2e-source-digest.* | \
      .github/scripts/macos-e2e-build*.mjs | .github/scripts/restore-macos-ci-build.mjs | \
      .github/scripts/verified-build-oci.mjs | \
      .github/scripts/restore-macos-e2e-runtime-oci.sh | .github/scripts/publish-macos-e2e-runtime-oci.sh | \
      .github/scripts/publish-wework-core-e2e-build-oci.sh | \
      .github/scripts/resolve-backend-rs-e2e-runtime.sh | \
      .github/scripts/resolve-wework-core-e2e-build-ref.sh | \
      .github/scripts/restore-oci-runtime-binary.sh | \
      .github/scripts/restore-wework-core-e2e-build-oci.sh | \
      .github/runtime-images/backend-rs-e2e.Dockerfile)
      changed[wework_target]=true
      ;;
    .github/scripts/resolve-executor-e2e-runtime.sh)
      changed[docker]=true
      ;;
    .github/workflows/test.yml | .github/workflows/lint.yml)
      changed[executor_rust]=true
      changed[node]=true
      changed[python]=true
      ;;
    .github/workflows/e2e-tests.yml)
      changed[docker]=true
      changed[node]=true
      changed[python]=true
      ;;
    .github/workflows/wework-e2e.yml)
      changed[node]=true
      changed[python]=true
      changed[wework_target]=true
      ;;
    .github/scripts/install-executor-rust-system-dependencies.sh)
      changed[executor_rust]=true
      ;;
    frontend/e2e/fixtures/claudecode-executor/*)
      changed[docker]=true
      ;;
    .github/claude-code-cli/* | frontend/* | .npmrc | patches/* | package.json | \
      pnpm-workspace.yaml | \
      frontend/package.json | wework/package.json | packages/*)
      changed[node]=true
      changed[wework_target]=true
      ;;
    pnpm-lock.yaml | wework/electron/package.json | \
      wework/electron/pnpm-lock.yaml)
      changed[node]=true
      changed[wework_target]=true
      ;;
    backend/uv.lock | executor_manager/uv.lock | \
      knowledge_engine/uv.lock | shared/uv.lock | \
      wegent-cli/requirements.txt)
      changed[python]=true
      ;;
    executor/Cargo.lock)
      changed[docker]=true
      changed[executor_rust]=true
      changed[wework_target]=true
      ;;
    wework/e2e/* | wework/test-results/*)
      ;;
    backend-rs/*)
      changed[backend_rs_rust]=true
      changed[wework_target]=true
      ;;
    shared/rust/*)
      changed[docker]=true
      changed[executor_rust]=true
      changed[backend_rs_rust]=true
      changed[wework_target]=true
      ;;
    .cargo/*)
      changed[executor_rust]=true
      changed[backend_rs_rust]=true
      changed[wework_target]=true
      ;;
    wework/*)
      changed[wework_target]=true
      ;;
    docker/wework-e2e/desktop.Dockerfile)
      changed[docker]=true
      changed[wework_target]=true
      ;;
    executor/* | sdk/plugin-auth/* | sdk/plugin-creator/*)
      changed[docker]=true
      changed[executor_rust]=true
      changed[wework_target]=true
      ;;
    shared/protocol/*)
      changed[wework_target]=true
      changed[docker]=true
      ;;
    shared/assets/*)
      changed[node]=true
      changed[wework_target]=true
      changed[docker]=true
      ;;
  esac
}

if [[ "${1:-}" == "--all" ]]; then
  mark_all
elif (($# > 0)); then
  for path in "$@"; do
    classify_path "$path"
  done
else
  while IFS= read -r path; do
    [[ -n "$path" ]] && classify_path "$path"
  done
fi

output_file="${GITHUB_OUTPUT:-/dev/stdout}"
for key in docker executor_rust backend_rs_rust node python wework_target; do
  printf '%s=%s\n' "$key" "${changed[$key]}" >> "$output_file"
done
