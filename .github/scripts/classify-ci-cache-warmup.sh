#!/usr/bin/env bash

set -euo pipefail

declare -A changed=(
  [docker]=false
  [executor_rust]=false
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
    .github/actions/* | .github/scripts/lib/apt-packages.sh | \
      .github/workflows/ci-cache-warmup.yml)
      mark_all
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
    .github/claude-code-cli/* | frontend/src/* | package.json | \
      pnpm-workspace.yaml | \
      frontend/package.json | wework/package.json | packages/*/package.json)
      changed[node]=true
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
    docker/wework-e2e/desktop.Dockerfile)
      changed[docker]=true
      changed[wework_target]=true
      ;;
    executor/*)
      changed[docker]=true
      changed[executor_rust]=true
      ;;
    frontend/e2e/fixtures/claudecode-executor/* | shared/assets/*)
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
for key in docker executor_rust node python wework_target; do
  printf '%s=%s\n' "$key" "${changed[$key]}" >> "$output_file"
done
