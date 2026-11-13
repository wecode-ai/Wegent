#!/usr/bin/env bash

set -euo pipefail

declare -A changed=(
  [backend]=false
  [backend_rs]=false
  [executor]=false
  [executor_manager]=false
  [shared]=false
  [knowledge_engine]=false
  [frontend]=false
  [wework]=false
  [wegent_cli]=false
  [platform_e2e]=false
  [wework_e2e]=false
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
    # Known leaf actions select their actual consumers; unknown actions retain full validation.
    .github/ci/wework-unit-test-durations.json | .github/scripts/balance-wework-unit-tests.* | \
      wework/scripts/ci-test-sequencer.*)
      changed[wework]=true
      return
      ;;
    .github/actions/prepare-electron-installer-cache/* | \
      .github/scripts/prime-ci-electron-installer-cache.mjs)
      changed[wework]=true
      changed[wework_e2e]=true
      return
      ;;
    .github/actions/build-frontend-e2e/* | .github/scripts/frontend-e2e-build*.mjs | \
      .github/scripts/restore-frontend-ci-build.mjs)
      changed[platform_e2e]=true
      return
      ;;
    .github/actions/setup-node-workspace/*)
      changed[frontend]=true
      changed[wework]=true
      changed[platform_e2e]=true
      changed[wework_e2e]=true
      return
      ;;
    .github/actions/setup-rust-cache/* | .github/actions/setup-sccache/* | .github/ci/rust-toolchain)
      changed[backend_rs]=true
      changed[executor]=true
      changed[platform_e2e]=true
      changed[wework_e2e]=true
      return
      ;;
    .github/actions/build-wework-core-e2e/* | .github/actions/build-wework-windows-e2e/* | \
      .github/actions/setup-wework-native-test-dependencies/* | \
      .github/actions/build-wework-macos-e2e/* | .github/actions/build-minio-e2e/* | \
      .github/actions/setup-minio-e2e/* | .github/scripts/prepare-macos-inspector-e2e.sh | \
      .github/scripts/build-macos-e2e-runtimes.sh | .github/scripts/macos-e2e-source-digest.mjs | \
      .github/scripts/macos-e2e-build*.mjs | .github/scripts/restore-macos-ci-build.mjs | \
      .github/scripts/restore-macos-e2e-runtime-oci.sh | .github/scripts/publish-macos-e2e-runtime-oci.sh)
      changed[wework_e2e]=true
      return
      ;;
    .github/scripts/verified-build-oci.mjs | \
      .github/scripts/download-actions-artifact.sh | .github/scripts/restore-actions-runtime.sh | \
      .github/scripts/runtime-artifact.mjs | .github/scripts/ci-prebuilt-images.mjs | \
      .github/scripts/resolve-ci-image.mjs | .github/ci/prebuilt-images.json | \
      .github/scripts/publish-ci-prebuild.sh | .github/scripts/restore-ci-downloads.sh | \
      .github/runtime-images/*)
      changed[platform_e2e]=true
      changed[wework_e2e]=true
      return
      ;;
    # These checks execute in the unconditional CI configuration gate.
    .github/scripts/ci-scheduling.test.mjs | .github/scripts/runtime-artifact.test.mjs | \
      .github/scripts/ci-prebuilt-images.test.mjs | \
      .github/scripts/resolve-ci-image.test.mjs | \
      .github/scripts/macos-e2e-source-digest.test.mjs | .github/scripts/test-rust-cache.sh)
      return
      ;;
    .github/ci/rust-toolchain | \
      .github/workflows/lint.yml | \
      .github/workflows/test.yml | \
      .github/workflows/ci-cache-warmup.yml | \
      .github/workflows/publish-base-image.yml | \
      .github/workflows/publish-image.yml | \
      .github/workflows/snapshot-image.yml | \
      .github/workflows/wework-app.yml | \
      .github/actions/* | \
      .github/scripts/classify-ci-cache-warmup.sh | \
      .github/scripts/classify-ci-changes.sh | \
      .github/scripts/download-actions-artifact.sh | \
      .github/scripts/restore-actions-runtime.sh | \
      .github/scripts/runtime-artifact.* | \
      .github/scripts/prepare-macos-inspector-e2e.sh | \
      .github/scripts/build-macos-e2e-runtimes.sh | \
      .github/scripts/macos-e2e-source-digest.* | \
      .github/scripts/macos-e2e-build*.mjs | .github/scripts/restore-macos-ci-build.mjs | \
      .github/scripts/verified-build-oci.mjs | \
      .github/scripts/lib/apt-packages.sh | \
      .github/scripts/lib/validate-ci-cache-policy.rb | \
      .github/scripts/test-ci-cache-policy.sh | \
      .github/scripts/ci-classification-tests/* | \
      .github/scripts/test-classify-ci-changes.sh)
      mark_all
      return
      ;;
    .github/scripts/install-e2e-apt-packages.sh)
      changed[platform_e2e]=true
      changed[wework_e2e]=true
      ;;
    .github/workflows/e2e-tests.yml | \
      .github/scripts/run-attachment-replica-e2e.sh | \
      .github/scripts/run-knowledge-provider-e2e.sh | \
      .github/scripts/test-e2e-resource-reuse.mjs | \
      .github/scripts/archive-executor-e2e-runtime.sh | \
      .github/scripts/archive-frontend-e2e-build.sh | \
      .github/scripts/free-runner-disk-space-if-needed.sh | \
      .github/scripts/resolve-executor-e2e-runtime.sh | \
      .github/scripts/restore-executor-e2e-runtime.sh | \
      .github/scripts/verify-executor-e2e-image.sh | \
      .github/scripts/restore-frontend-e2e-build.sh | \
      .github/scripts/setup-dingtalk-oauth-e2e.sh | \
      .github/scripts/start-frontend-e2e-server.sh)
      changed[platform_e2e]=true
      ;;
    .github/scripts/install-executor-rust-system-dependencies.sh)
      changed[executor]=true
      changed[platform_e2e]=true
      ;;
    .github/workflows/wework-e2e.yml | docker/wework-e2e/* | \
      .github/ci/wework-native-test-ubuntu.sources | \
      .github/ci/wework-linux-checkpoint-durations.json | \
      .github/scripts/order-wework-linux-e2e.* | \
      .github/scripts/core-runner-slots.* | \
      .github/scripts/archive-wework-core-e2e-build.sh | \
      .github/scripts/wework-core-e2e-transport.* | \
      .github/scripts/classify-wework-desktop-e2e.sh | \
      .github/scripts/desktop-ci/* | \
      .github/scripts/restore-oci-runtime-binary.sh | \
      .github/scripts/restore-wework-core-e2e-build.sh)
      changed[wework_e2e]=true
      ;;
    package.json | pnpm-lock.yaml | pnpm-workspace.yaml)
      changed[frontend]=true
      changed[wework]=true
      changed[platform_e2e]=true
      changed[wework_e2e]=true
      ;;
    backend/* | chat_shell/*)
      changed[backend]=true
      changed[wegent_cli]=true
      changed[platform_e2e]=true
      ;;
    docs/*/wegent/developer-guide/collaboration-permissions.md)
      changed[backend]=true
      ;;
    backend-rs/src/cloud_projects* | backend-rs/src/loop_item_executions/device.rs | backend-rs/config/routes.toml)
      changed[backend]=true
      changed[backend_rs]=true
      changed[platform_e2e]=true
      changed[wework_e2e]=true
      ;;
    backend-rs/*)
      changed[backend_rs]=true
      changed[platform_e2e]=true
      changed[wework_e2e]=true
      ;;
    executor/* | sdk/plugin-auth/* | sdk/plugin-auth-go/* | sdk/dws-auth/* | sdk/plugin-build/* | sdk/plugin-creator/*)
      changed[executor]=true
      changed[platform_e2e]=true
      changed[wework_e2e]=true
      ;;
    executor_manager/*)
      changed[executor_manager]=true
      changed[platform_e2e]=true
      ;;
    shared/rust/*)
      changed[backend_rs]=true
      changed[executor]=true
      changed[platform_e2e]=true
      changed[wework_e2e]=true
      ;;
    shared/*)
      if [[ "$path" == shared/assets/codex-models/* ]]; then
        changed[backend_rs]=true
        changed[wework_e2e]=true
      fi
      changed[backend]=true
      changed[executor_manager]=true
      changed[shared]=true
      changed[knowledge_engine]=true
      changed[wegent_cli]=true
      changed[platform_e2e]=true
      ;;
    knowledge_engine/*)
      changed[knowledge_engine]=true
      changed[platform_e2e]=true
      ;;
    knowledge_runtime/*)
      changed[knowledge_engine]=true
      changed[platform_e2e]=true
      ;;
    frontend/*)
      changed[frontend]=true
      changed[platform_e2e]=true
      ;;
    packages/chat-core/* | packages/collaboration/*)
      changed[frontend]=true
      changed[wework]=true
      changed[platform_e2e]=true
      changed[wework_e2e]=true
      ;;
    packages/process-explorer/*)
      changed[wework]=true
      changed[wework_e2e]=true
      ;;
    wework/*)
      changed[wework]=true
      changed[wework_e2e]=true
      ;;
    wegent-cli/*)
      changed[wegent_cli]=true
      ;;
    docker/*)
      changed[platform_e2e]=true
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
for key in backend backend_rs executor executor_manager shared knowledge_engine frontend wework wegent_cli platform_e2e wework_e2e; do
  printf '%s=%s\n' "$key" "${changed[$key]}" >> "$output_file"
done
