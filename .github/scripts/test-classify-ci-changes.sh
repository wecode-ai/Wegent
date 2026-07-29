#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
classifier="$script_dir/classify-ci-changes.sh"
desktop_classifier="$script_dir/classify-wework-desktop-e2e.sh"

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
platform_e2e=false
wework_e2e=false
EOF
)

assert_case "docs only" "$all_false" "docs/zh/index.md"

wework_expected="${all_false/wework=false/wework=true}"
wework_expected="${wework_expected/wework_e2e=false/wework_e2e=true}"
assert_case "wework only" "$wework_expected" "wework/src/App.tsx"

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
platform_e2e=true
wework_e2e=false
EOF
)
assert_case "shared dependencies" "$shared_expected" "shared/utils/example.py"

all_true="${all_false//false/true}"
assert_case "explicit all modules" "$all_true" --all

assert_case "workflow changes validate all modules" "$all_true" \
  ".github/workflows/test.yml"

assert_case "ci:all label forces all modules" "$all_true" --all

platform_e2e_expected="${all_false/platform_e2e=false/platform_e2e=true}"
assert_case "docker changes run platform E2E" "$platform_e2e_expected" \
  "docker/docker-compose.yml"

wework_e2e_expected="${all_false/wework_e2e=false/wework_e2e=true}"
assert_case "Wework workflow changes run Wework E2E" "$wework_e2e_expected" \
  ".github/workflows/wework-e2e.yml"

assert_desktop_case() {
  local name="$1"
  local expected="$2"
  shift 2

  local output
  output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$@")"
  if [[ "$output" != "$expected" ]]; then
    printf 'Desktop case "%s" failed.\nExpected:\n%s\nActual:\n%s\n' \
      "$name" "$expected" "$output" >&2
    exit 1
  fi
}

assert_desktop_case "conversation files select one core segment" \
  'wework_desktop_e2e=true
wework_desktop_e2e_matrix={"include":[{"id":"core-conversation-state","name":"Core / conversation-state","command":"e2e:desktop","segment":"conversation-state"}]}' \
  "wework/src/features/workbench/runtimeConversationCache.ts"

assert_desktop_case "independent features select the union of minimum segments" \
  'wework_desktop_e2e=true
wework_desktop_e2e_matrix={"include":[{"id":"core-goal-lifecycle","name":"Core / goal-lifecycle","command":"e2e:desktop","segment":"goal-lifecycle"},{"id":"core-rendering-extensions","name":"Core / rendering-extensions","command":"e2e:desktop","segment":"rendering-extensions"}]}' \
  "wework/src/lib/runtime-goal.ts" \
  "wework/src/components/chat/blocks/ToolBlockItem.tsx"

assert_desktop_case "runner coverage does not broaden a classified feature" \
  'wework_desktop_e2e=true
wework_desktop_e2e_matrix={"include":[{"id":"core-conversation-state","name":"Core / conversation-state","command":"e2e:desktop","segment":"conversation-state"},{"id":"core-rendering-extensions","name":"Core / rendering-extensions","command":"e2e:desktop","segment":"rendering-extensions"}]}' \
  "wework/e2e/desktop/task-flow.e2e.mjs" \
  "wework/src/components/chat/MessageList.tsx"

assert_desktop_case "runner-only changes retain full coverage" \
  'wework_desktop_e2e=true
wework_desktop_e2e_matrix={"include":[{"id":"core","name":"Core","command":"e2e:desktop","segment":""},{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":""},{"id":"cloud","name":"Cloud","command":"e2e:desktop:cloud","segment":""}]}' \
  "wework/e2e/desktop/task-flow.e2e.mjs"

assert_desktop_case "skill mention files select plugin and core coverage" \
  'wework_desktop_e2e=true
wework_desktop_e2e_matrix={"include":[{"id":"core-core-task-flow","name":"Core / core-task-flow","command":"e2e:desktop","segment":"core-task-flow"},{"id":"plugins-skill-mention-rendering","name":"Plugins / skill-mention-rendering","command":"e2e:desktop:plugins","segment":"skill-mention-rendering"}]}' \
  "wework/src/components/chat/composer/ComposerMentionMenu.tsx"

assert_desktop_case "browser E2E changes avoid desktop jobs" \
  'wework_desktop_e2e=false
wework_desktop_e2e_matrix={"include":[]}' \
  "wework/e2e/tests/workbench.spec.ts"

assert_desktop_case "cloud files select only the cloud suite" \
  'wework_desktop_e2e=true
wework_desktop_e2e_matrix={"include":[{"id":"cloud","name":"Cloud","command":"e2e:desktop:cloud","segment":""}]}' \
  "wework/src/features/cloud-connection/CloudConnectionProvider.tsx"

assert_desktop_case "plugin files select only their plugin segment" \
  'wework_desktop_e2e=true
wework_desktop_e2e_matrix={"include":[{"id":"plugins-plugin-lifecycle","name":"Plugins / plugin-lifecycle","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}' \
  "wework/src/components/plugins/PluginsWorkspace.tsx"

assert_desktop_case "shared desktop infrastructure remains full coverage" \
  'wework_desktop_e2e=true
wework_desktop_e2e_matrix={"include":[{"id":"core","name":"Core","command":"e2e:desktop","segment":""},{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":""},{"id":"cloud","name":"Cloud","command":"e2e:desktop:cloud","segment":""}]}' \
  "wework/src/App.tsx"

test_workflow="$script_dir/../workflows/test.yml"
if ! sed -n '/^  pull_request:/,/^  [a-z_]*:/p' "$test_workflow" |
  grep -q -- "- labeled"; then
  printf 'test.yml must run when the ci:all label is applied\n' >&2
  exit 1
fi

if ! grep -q "ci:all" "$test_workflow"; then
  printf 'test.yml must force all module tests for the ci:all label\n' >&2
  exit 1
fi

for workflow in e2e-tests.yml wework-e2e.yml; do
  workflow_path="$script_dir/../workflows/$workflow"
  push_config="$(
    sed -n '/^  push:/,/^  pull_request:/p' "$workflow_path"
  )"
  pull_request_config="$(
    sed -n '/^  pull_request:/,/^  [a-z_]*:/p' "$workflow_path"
  )"
  if grep -q "paths:" <<<"$push_config"; then
    printf '%s must run for every push to main\n' "$workflow" >&2
    exit 1
  fi
  if ! grep -q "ready_for_review" <<<"$pull_request_config"; then
    printf '%s must run E2E when a draft PR becomes ready for review\n' \
      "$workflow" >&2
    exit 1
  fi
  if ! grep -q "labeled" <<<"$pull_request_config"; then
    printf '%s must run when the ci:all label is applied\n' "$workflow" >&2
    exit 1
  fi
  if grep -q "paths:" <<<"$pull_request_config"; then
    printf '%s must not path-filter ci:all label events\n' "$workflow" >&2
    exit 1
  fi
  if ! grep -q "ci:all" "$workflow_path"; then
    printf '%s must force E2E for the ci:all label\n' "$workflow" >&2
    exit 1
  fi
  if ! grep -q "merge_group:" "$workflow_path"; then
    printf '%s must run for merge queue groups\n' "$workflow" >&2
    exit 1
  fi
  if ! grep -q "checks_requested" "$workflow_path"; then
    printf '%s must limit merge group runs to checks_requested\n' \
      "$workflow" >&2
    exit 1
  fi
  if ! grep -Fq \
    "FORCE_ALL: \${{ github.event_name != 'pull_request'" \
    "$workflow_path"; then
    printf '%s must force all E2E outside pull request events\n' \
      "$workflow" >&2
    exit 1
  fi
done

for workflow in test.yml lint.yml; do
  workflow_path="$script_dir/../workflows/$workflow"
  if ! grep -q "classify-ci-changes.sh --all" "$workflow_path"; then
    printf '%s must classify every module for pushes to main\n' "$workflow" >&2
    exit 1
  fi
  if ! grep -q "merge_group:" "$workflow_path"; then
    printf '%s must run for merge queue groups\n' "$workflow" >&2
    exit 1
  fi
  if ! grep -q "GITHUB_EVENT_NAME.*merge_group\\|github.event_name == 'merge_group'" \
    "$workflow_path"; then
    printf '%s must classify every module for merge groups\n' "$workflow" >&2
    exit 1
  fi
done

wework_workflow="$script_dir/../workflows/wework-e2e.yml"
if [[ "$(grep -c "github.event.action != 'labeled'" "$wework_workflow")" -lt 2 ]]; then
  printf 'Wework non-memory E2E jobs must filter pull_request label events\n' >&2
  exit 1
fi

if ! grep -q "github.event.label.name || 'code'" "$wework_workflow"; then
  printf 'Wework label events must not cancel code-change E2E runs\n' >&2
  exit 1
fi

if ! grep -q "name: Platform E2E Summary" \
  "$script_dir/../workflows/e2e-tests.yml"; then
  printf 'Platform E2E must expose a stable summary check\n' >&2
  exit 1
fi

if ! grep -q "name: Wework E2E Summary" "$wework_workflow"; then
  printf 'Wework E2E must expose a stable summary check\n' >&2
  exit 1
fi

if ! grep -q "wework_desktop_e2e_matrix" "$wework_workflow"; then
  printf 'Wework desktop E2E must use the changed-feature segment matrix\n' >&2
  exit 1
fi

wework_browser_job="$(
  sed -n '/^  wework-e2e:/,/^  wework-desktop-e2e:/p' "$wework_workflow"
)"
if ! grep -q "needs.changes.outputs.wework_e2e == 'true'" <<<"$wework_browser_job"; then
  printf 'Wework browser E2E must use the broad Wework change classification\n' >&2
  exit 1
fi

wework_desktop_job="$(
  sed -n '/^  wework-desktop-e2e:/,/^  wework-e2e-summary:/p' "$wework_workflow"
)"
if ! grep -q \
  "needs.changes.outputs.wework_desktop_e2e == 'true'" \
  <<<"$wework_desktop_job"; then
  printf 'Wework desktop E2E must use the desktop segment classification\n' >&2
  exit 1
fi

if ! grep -q "github.event_name != 'merge_group'" "$wework_workflow"; then
  printf 'Wework memory E2E must remain outside regular merge groups\n' >&2
  exit 1
fi

printf 'CI change classifier tests passed\n'
