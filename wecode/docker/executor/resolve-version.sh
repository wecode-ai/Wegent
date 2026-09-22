#!/usr/bin/env bash
set -euo pipefail

VERSION_URL="https://ai-state-machine.intra.weibo.com/ai-tool-box/wegent-executor-linux-amd64/update.json"

is_stable_version() {
  local version="$1"
  local major minor patch

  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS='.' read -r major minor patch <<< "$version"
  for part in "$major" "$minor" "$patch"; do
    if [[ "${#part}" -gt 1 && "$part" == 0* ]]; then
      return 1
    fi
  done
}

fetch_update_version() {
  local response version

  response="$(
    curl --fail --silent --show-error --location \
      --connect-timeout 10 \
      --max-time 30 \
      "$VERSION_URL"
  )" || return 1
  version="$(
    python3 -c \
      'import json, sys; value = json.load(sys.stdin).get("version"); print(value if isinstance(value, str) else "")' \
      <<< "$response"
  )" || return 1
  is_stable_version "$version" || return 1
  printf '%s\n' "$version"
}

resolve_branch_name() {
  if [[ -n "${CI_MERGE_REQUEST_SOURCE_BRANCH_NAME:-}" ]]; then
    printf '%s\n' "$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME"
    return
  fi
  if [[ -n "${CI_COMMIT_BRANCH:-}" ]]; then
    printf '%s\n' "$CI_COMMIT_BRANCH"
    return
  fi
  printf '%s\n' "${CI_COMMIT_REF_NAME:-}"
}

normalize_branch_name() {
  LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

if ! executor_version="$(fetch_update_version)"; then
  echo "Unable to resolve a valid Executor version from $VERSION_URL" >&2
  exit 1
fi

main_branch="${MASTER_BRANCH:-main}"
current_branch="$(resolve_branch_name)"
if [[ -z "$current_branch" ]]; then
  echo "Unable to resolve the current branch for the Executor version" >&2
  exit 1
fi

if [[ "$current_branch" != "$main_branch" ]]; then
  branch_slug="$(printf '%s' "$current_branch" | normalize_branch_name)"
  if [[ -z "$branch_slug" ]]; then
    echo "Unable to normalize branch '$current_branch' for the Executor version" >&2
    exit 1
  fi
  executor_version="${executor_version}-${branch_slug}"
fi

printf 'Resolved Executor version: branch=%s version=%s source=%s\n' \
  "$current_branch" "$executor_version" "update-json" >&2
printf '%s\n' "$executor_version"
