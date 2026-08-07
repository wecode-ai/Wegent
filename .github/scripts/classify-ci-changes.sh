#!/usr/bin/env bash

set -euo pipefail

declare -A changed=(
  [backend]=false
  [executor]=false
  [executor_manager]=false
  [shared]=false
  [knowledge_engine]=false
  [frontend]=false
  [wework]=false
  [wework_rust]=false
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
    .github/workflows/lint.yml | \
      .github/workflows/test.yml | \
      .github/workflows/ci-cache-warmup.yml | \
      .github/workflows/publish-image.yml | \
      .github/workflows/snapshot-image.yml | \
      .github/workflows/wework-app.yml | \
      .github/actions/* | \
      .github/scripts/classify-ci-cache-warmup.sh | \
      .github/scripts/classify-ci-changes.sh | \
      .github/scripts/lib/apt-packages.sh | \
      .github/scripts/test-ci-cache-policy.sh | \
      .github/scripts/test-classify-ci-changes.sh)
      mark_all
      return
      ;;
    .github/workflows/e2e-tests.yml | \
      .github/scripts/archive-executor-e2e-runtime.sh | \
      .github/scripts/archive-frontend-e2e-build.sh | \
      .github/scripts/free-runner-disk-space-if-needed.sh | \
      .github/scripts/restore-executor-e2e-runtime.sh | \
      .github/scripts/restore-frontend-e2e-build.sh | \
      .github/scripts/start-frontend-e2e-server.sh)
      changed[platform_e2e]=true
      ;;
    .github/scripts/install-executor-rust-system-dependencies.sh)
      changed[executor]=true
      changed[platform_e2e]=true
      ;;
    .github/workflows/wework-e2e.yml | \
      .github/scripts/archive-wework-core-e2e-build.sh | \
      .github/scripts/classify-wework-desktop-e2e.sh | \
      .github/scripts/install-wework-tauri-system-dependencies.sh | \
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
    executor/*)
      changed[executor]=true
      changed[platform_e2e]=true
      changed[wework_e2e]=true
      ;;
    executor_manager/*)
      changed[executor_manager]=true
      changed[platform_e2e]=true
      ;;
    shared/*)
      changed[backend]=true
      changed[executor_manager]=true
      changed[shared]=true
      changed[knowledge_engine]=true
      changed[wegent_cli]=true
      changed[platform_e2e]=true
      ;;
    knowledge_engine/*)
      changed[knowledge_engine]=true
      ;;
    frontend/*)
      changed[frontend]=true
      changed[platform_e2e]=true
      ;;
    packages/chat-core/*)
      changed[frontend]=true
      changed[wework]=true
      changed[platform_e2e]=true
      changed[wework_e2e]=true
      ;;
    wework/src-tauri/*)
      changed[wework]=true
      changed[wework_rust]=true
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
for key in backend executor executor_manager shared knowledge_engine frontend wework wework_rust wegent_cli platform_e2e wework_e2e; do
  printf '%s=%s\n' "$key" "${changed[$key]}" >> "$output_file"
done
