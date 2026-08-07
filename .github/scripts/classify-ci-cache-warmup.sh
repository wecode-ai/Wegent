#!/usr/bin/env bash

set -euo pipefail

declare -A changed=(
  [docker]=false
  [executor_rust]=false
  [node]=false
  [python]=false
  [wework_rust]=false
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
    .github/actions/* | .github/scripts/lib/apt-packages.sh | \
      .github/workflows/ci-cache-warmup.yml)
      mark_all
      ;;
    .github/workflows/test.yml | .github/workflows/lint.yml)
      changed[executor_rust]=true
      changed[node]=true
      changed[python]=true
      changed[wework_rust]=true
      ;;
    .github/workflows/e2e-tests.yml)
      changed[docker]=true
      changed[node]=true
      changed[python]=true
      ;;
    .github/workflows/wework-e2e.yml | \
      .github/scripts/install-wework-tauri-system-dependencies.sh)
      changed[node]=true
      changed[python]=true
      changed[wework_rust]=true
      changed[wework_target]=true
      ;;
    .github/scripts/install-executor-rust-system-dependencies.sh)
      changed[executor_rust]=true
      ;;
    .github/scripts/install-playwright-browser.sh | \
      frontend/src/* | package.json | pnpm-lock.yaml | pnpm-workspace.yaml | \
      frontend/package.json | wework/package.json | packages/*/package.json)
      changed[node]=true
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
    executor/*)
      changed[docker]=true
      changed[executor_rust]=true
      ;;
    frontend/e2e/fixtures/claudecode-executor/* | shared/assets/*)
      changed[docker]=true
      ;;
    wework/src-tauri/Cargo.lock)
      changed[wework_rust]=true
      changed[wework_target]=true
      ;;
    wework/src-tauri/*)
      changed[wework_rust]=true
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
for key in docker executor_rust node python wework_rust wework_target; do
  printf '%s=%s\n' "$key" "${changed[$key]}" >> "$output_file"
done
