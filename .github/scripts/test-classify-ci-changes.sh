#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
classifier="$script_dir/classify-ci-changes.sh"

assert_case() {
  local name="$1"
  local expected="$2"
  shift 2

  local output
  output="$(GITHUB_OUTPUT=/dev/stdout "$classifier" "$@")"
  if [[ "$output" != "$expected" ]]; then
    printf 'Case "%s" failed.\nExpected:\n%s\nActual:\n%s\n' "$name" "$expected" "$output" >&2
    exit 1
  fi
}

all_false=$(
  cat <<'EOF'
backend=false
executor=false
executor_manager=false
shared=false
knowledge_engine=false
frontend=false
wework=false
wegent_cli=false
EOF
)

assert_case "docs only" "$all_false" "docs/zh/index.md"

assert_case "wework only" "${all_false/wework=false/wework=true}" \
  "wework/src/App.tsx"

shared_expected=$(
  cat <<'EOF'
backend=true
executor=false
executor_manager=true
shared=true
knowledge_engine=true
frontend=false
wework=false
wegent_cli=true
EOF
)
assert_case "shared dependencies" "$shared_expected" "shared/utils/example.py"

all_true="${all_false//false/true}"
assert_case "workflow changes validate all modules" "$all_true" \
  ".github/workflows/test.yml"

printf 'CI change classifier tests passed\n'
