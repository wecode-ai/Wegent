#!/usr/bin/env bash

set -euo pipefail

cli_dir="${1:-.github/claude-code-cli}/node_modules/.bin"

verify_cli() {
  local name="$1"
  local expected="$2"
  local actual

  if [[ ! -x "$cli_dir/$name" ]]; then
    printf 'Local harness CLI is not executable: %s\n' "$cli_dir/$name" >&2
    exit 1
  fi

  actual="$("$cli_dir/$name" --version)"
  if [[ "$actual" != "$expected" && "$actual" != "$expected "* ]]; then
    printf 'Unexpected %s version: expected %s, got %s\n' \
      "$name" "$expected" "$actual" >&2
    exit 1
  fi
}

verify_cli claude 2.1.199
verify_cli kimi 0.35.0
verify_cli opencode 1.18.16

printf 'Local harness CLI versions verified\n'
