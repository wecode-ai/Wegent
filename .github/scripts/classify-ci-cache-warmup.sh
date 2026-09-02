#!/usr/bin/env bash

set -euo pipefail

docker=false
executor_rust=false
node=false
python=false
wework_mobile_ios=false
wework_target=false

mark_all() {
  docker=true
  executor_rust=true
  node=true
  python=true
  wework_mobile_ios=true
  wework_target=true
}

classify_path() {
  local path="$1"

  case "$path" in
    .github/actions/* | .github/scripts/classify-ci-cache-warmup.sh | \
      .github/scripts/lib/apt-packages.sh | \
      .github/workflows/ci-cache-warmup.yml)
      mark_all
      ;;
    .github/scripts/resolve-executor-e2e-runtime.sh)
      docker=true
      ;;
    .github/workflows/test.yml | .github/workflows/lint.yml)
      executor_rust=true
      node=true
      python=true
      ;;
    .github/workflows/e2e-tests.yml)
      docker=true
      node=true
      python=true
      ;;
    .github/workflows/wework-e2e.yml)
      node=true
      python=true
      wework_mobile_ios=true
      wework_target=true
      ;;
    .github/scripts/build-wework-mobile-ios-app.sh | \
      .github/scripts/build-wework-mobile-ios-e2e-artifact.sh | \
      .github/scripts/create-wework-mobile-ios-simulator.sh | \
      wework-mobile/*)
      wework_mobile_ios=true
      ;;
    .github/scripts/install-executor-rust-system-dependencies.sh)
      executor_rust=true
      ;;
    .github/claude-code-cli/* | frontend/src/* | package.json | \
      pnpm-workspace.yaml | \
      frontend/package.json | wework/package.json | packages/*/package.json)
      node=true
      ;;
    pnpm-lock.yaml | wework/electron/package.json | \
      wework/electron/pnpm-lock.yaml)
      node=true
      wework_target=true
      ;;
    backend/uv.lock | executor_manager/uv.lock | \
      knowledge_engine/uv.lock | shared/uv.lock | \
      wegent-cli/requirements.txt)
      python=true
      ;;
    executor/Cargo.lock)
      docker=true
      executor_rust=true
      wework_mobile_ios=true
      wework_target=true
      ;;
    docker/wework-e2e/desktop.Dockerfile)
      docker=true
      wework_target=true
      ;;
    executor/*)
      docker=true
      executor_rust=true
      wework_mobile_ios=true
      ;;
    frontend/e2e/fixtures/claudecode-executor/*)
      docker=true
      ;;
    shared/assets/*)
      docker=true
      wework_mobile_ios=true
      ;;
    wework/codex-binaries.lock.json | \
      wework/e2e/desktop/modules/desktop-build-flows.mjs)
      wework_mobile_ios=true
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
for key in docker executor_rust node python wework_mobile_ios wework_target; do
  printf '%s=%s\n' "$key" "${!key}" >> "$output_file"
done
