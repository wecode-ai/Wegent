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
  [wegent_cli]=false
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
      .github/scripts/classify-ci-changes.sh | \
      .github/scripts/test-classify-ci-changes.sh)
      mark_all
      return
      ;;
    package.json | pnpm-lock.yaml | pnpm-workspace.yaml)
      changed[frontend]=true
      changed[wework]=true
      ;;
    backend/* | chat_shell/*)
      changed[backend]=true
      changed[wegent_cli]=true
      ;;
    executor/*)
      changed[executor]=true
      ;;
    executor_manager/*)
      changed[executor_manager]=true
      ;;
    shared/*)
      changed[backend]=true
      changed[executor_manager]=true
      changed[shared]=true
      changed[knowledge_engine]=true
      changed[wegent_cli]=true
      ;;
    knowledge_engine/*)
      changed[knowledge_engine]=true
      ;;
    frontend/*)
      changed[frontend]=true
      ;;
    packages/chat-core/*)
      changed[frontend]=true
      changed[wework]=true
      ;;
    wework/*)
      changed[wework]=true
      ;;
    wegent-cli/*)
      changed[wegent_cli]=true
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
for key in backend executor executor_manager shared knowledge_engine frontend wework wegent_cli; do
  printf '%s=%s\n' "$key" "${changed[$key]}" >> "$output_file"
done
