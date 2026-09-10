#!/usr/bin/env bash

set -euo pipefail

plugin_auth_sdk=false

classify_path() {
  local path="$1"

  case "$path" in
    sdk/plugin-auth/* | \
      sdk/plugin-creator/* | \
      sdk/plugin-auth-go/* | \
      sdk/dws-auth/* | \
      sdk/plugin-build/* | \
      shared/plugin_build.py | \
      shared/tests/test_plugin_build.py | \
      executor/src/plugin_account_auth/* | \
      executor/src/local/plugin_creator.rs | \
      executor/src/process/mod.rs | \
      executor/tests/plugin_account_auth_contract.rs | \
      .github/scripts/classify-plugin-auth-sdk.sh | \
      .github/workflows/plugin-auth-sdk.yml)
      plugin_auth_sdk=true
      ;;
  esac
}

if [[ "${1:-}" == "--all" ]]; then
  plugin_auth_sdk=true
elif (($# > 0)); then
  for path in "$@"; do
    classify_path "$path"
  done
else
  while IFS= read -r path; do
    [[ -n "$path" ]] && classify_path "$path"
  done
fi

printf 'plugin_auth_sdk=%s\n' "$plugin_auth_sdk" \
  >> "${GITHUB_OUTPUT:-/dev/stdout}"
