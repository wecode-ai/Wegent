#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
classifier="$script_dir/classify-ci-changes.sh"
desktop_classifier="$script_dir/classify-wework-desktop-e2e.sh"

workflow_has_top_level_trigger() {
  local workflow_path="$1"
  local trigger="$2"

  awk -v target="$trigger" '
    function normalize_token(token) {
      gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", token)
      gsub(/^\047+|\047+$/, "", token)
      return token
    }

    function inline_has_target(value, tokens, token_count, token_index) {
      sub(/[[:space:]]+#.*/, "", value)
      gsub(/[\[\],]/, " ", value)
      token_count = split(value, tokens, /[[:space:]]+/)
      for (token_index = 1; token_index <= token_count; token_index++) {
        if (normalize_token(tokens[token_index]) == target) return 1
      }
      return 0
    }

    /^[[:space:]]*(#|$)/ {
      next
    }

    {
      line = $0
      if (!in_on) {
        if (line !~ /^on:[[:space:]]*/) next
        sub(/^on:[[:space:]]*/, "", line)
        sub(/^[[:space:]]*#.*/, "", line)
        if (line != "") {
          found = inline_has_target(line)
          exit
        }
        in_on = 1
        child_indent = -1
        next
      }

      if (line ~ /^[^[:space:]]/) exit

      indentation = line
      sub(/[^[:space:]].*$/, "", indentation)
      indent = length(indentation)
      if (child_indent == -1) child_indent = indent
      if (indent != child_indent) next

      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+#.*/, "", line)
      sub(/^-[[:space:]]*/, "", line)
      sub(/:.*/, "", line)
      if (normalize_token(line) == target) {
        found = 1
        exit
      }
    }

    END {
      exit found ? 0 : 1
    }
  ' "$workflow_path"
}

assert_workflow_trigger_case() {
  local name="$1"
  local expected="$2"
  local workflow="$3"
  local actual="false"

  if workflow_has_top_level_trigger <(printf '%s\n' "$workflow") "push"; then
    actual="true"
  fi
  if [[ "$actual" != "$expected" ]]; then
    printf 'Workflow trigger case "%s" failed.\n' "$name" >&2
    exit 1
  fi
}

extract_named_workflow_step() {
  local workflow_path="$1"
  local step_name="$2"

  awk -v target="$step_name" '
    found && /^      - name:/ {
      exit
    }
    $0 == "      - name: " target {
      found = 1
    }
    found {
      print
    }
  ' "$workflow_path"
}

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

assert_case "Wework artifact scripts run Wework E2E" "$wework_e2e_expected" \
  ".github/scripts/archive-wework-core-e2e-build.sh"

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

assert_desktop_case "conversation cache selects guidance and conversation segments" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-core-task-flow","name":"Core / core-task-flow","command":"e2e:desktop","segment":"core-task-flow"},{"id":"core-conversation-state","name":"Core / conversation-state","command":"e2e:desktop","segment":"conversation-state"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/runtimeConversationCache.ts"

assert_desktop_case "independent features select the union of minimum segments" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-goal-lifecycle","name":"Core / goal-lifecycle","command":"e2e:desktop","segment":"goal-lifecycle"},{"id":"core-rendering-extensions","name":"Core / rendering-extensions","command":"e2e:desktop","segment":"rendering-extensions"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/lib/runtime-goal.ts" \
  "wework/src/components/chat/blocks/ToolBlockItem.tsx"

assert_desktop_case "runner coverage does not broaden a classified feature" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-conversation-state","name":"Core / conversation-state","command":"e2e:desktop","segment":"conversation-state"},{"id":"core-rendering-extensions","name":"Core / rendering-extensions","command":"e2e:desktop","segment":"rendering-extensions"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/task-flow.e2e.mjs" \
  "wework/src/components/chat/MessageList.tsx"

assert_desktop_case "turn lifecycle changes select supervisor and resilience coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-supervisor-lifecycle","name":"Core / supervisor-lifecycle","command":"e2e:desktop","segment":"supervisor-lifecycle"},{"id":"core-resilience","name":"Core / resilience","command":"e2e:desktop","segment":"resilience"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/runtimeTaskLifecycle/reducer.ts"

assert_desktop_case "runtime pane events select supervisor and conversation coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-supervisor-lifecycle","name":"Core / supervisor-lifecycle","command":"e2e:desktop","segment":"supervisor-lifecycle"},{"id":"core-conversation-state","name":"Core / conversation-state","command":"e2e:desktop","segment":"conversation-state"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/runtimePaneMessages.ts"

full_desktop_expected='wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-workspace-tabs","name":"Core / workspace-tabs","command":"e2e:desktop","segment":"workspace-tabs"},{"id":"core-priority-filter","name":"Core / priority-filter","command":"e2e:desktop","segment":"priority-filter"},{"id":"core-core-task-flow","name":"Core / core-task-flow","command":"e2e:desktop","segment":"core-task-flow"},{"id":"core-window-lifecycle","name":"Core / window-lifecycle","command":"e2e:desktop","segment":"window-lifecycle"},{"id":"core-goal-lifecycle","name":"Core / goal-lifecycle","command":"e2e:desktop","segment":"goal-lifecycle"},{"id":"core-supervisor-lifecycle","name":"Core / supervisor-lifecycle","command":"e2e:desktop","segment":"supervisor-lifecycle"},{"id":"core-resilience","name":"Core / resilience","command":"e2e:desktop","segment":"resilience"},{"id":"core-conversation-state","name":"Core / conversation-state","command":"e2e:desktop","segment":"conversation-state"},{"id":"core-workspace-attachments","name":"Core / workspace-attachments","command":"e2e:desktop","segment":"workspace-attachments"},{"id":"core-rendering-extensions","name":"Core / rendering-extensions","command":"e2e:desktop","segment":"rendering-extensions"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":""},{"id":"cloud","name":"Cloud","command":"e2e:desktop:cloud","segment":""}]}'

assert_desktop_case "runner-only changes retain full coverage" \
  "$full_desktop_expected" \
  "wework/e2e/desktop/task-flow.e2e.mjs"

assert_desktop_case "Core artifact changes retain full coverage" \
  "$full_desktop_expected" \
  ".github/scripts/archive-wework-core-e2e-build.sh"

assert_desktop_case "skill mention files select plugin and core coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-core-task-flow","name":"Core / core-task-flow","command":"e2e:desktop","segment":"core-task-flow"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins-skill-mention-rendering","name":"Plugins / skill-mention-rendering","command":"e2e:desktop:plugins","segment":"skill-mention-rendering"}]}' \
  "wework/src/components/chat/composer/ComposerMentionMenu.tsx"

assert_desktop_case "browser E2E changes avoid desktop jobs" \
  'wework_desktop_e2e=false
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/tests/workbench.spec.ts"

assert_desktop_case "cloud files select only the cloud suite" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"cloud","name":"Cloud","command":"e2e:desktop:cloud","segment":""}]}' \
  "wework/src/features/cloud-connection/CloudConnectionProvider.tsx"

assert_desktop_case "plugin files select only their plugin segment" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins-plugin-lifecycle","name":"Plugins / plugin-lifecycle","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}' \
  "wework/src/components/plugins/PluginsWorkspace.tsx"

assert_desktop_case "desktop sidebar selects all owned checkpoints" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-priority-filter","name":"Core / priority-filter","command":"e2e:desktop","segment":"priority-filter"},{"id":"core-core-task-flow","name":"Core / core-task-flow","command":"e2e:desktop","segment":"core-task-flow"},{"id":"core-workspace-attachments","name":"Core / workspace-attachments","command":"e2e:desktop","segment":"workspace-attachments"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/DesktopSidebar.tsx"

assert_desktop_case "priority section selects only its dedicated checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-priority-filter","name":"Core / priority-filter","command":"e2e:desktop","segment":"priority-filter"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/DesktopSidebarPrioritySection.tsx"

assert_desktop_case "shared desktop infrastructure remains full coverage" \
  "$full_desktop_expected" \
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
  pull_request_config="$(
    sed -n '/^  pull_request:/,/^  [a-z_]*:/p' "$workflow_path"
  )"
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
    printf '%s must classify every module for merge groups\n' "$workflow" >&2
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

assert_workflow_trigger_case "block mapping push trigger" "true" $'on:\n  push:\n  pull_request:'
assert_workflow_trigger_case "block mapping with on comment" "true" $'on: # workflow triggers\n  push:\n  pull_request:'
assert_workflow_trigger_case "block sequence push trigger" "true" $'on:\n  - push\n  - pull_request'
assert_workflow_trigger_case "inline scalar push trigger" "true" "on: push"
assert_workflow_trigger_case "inline array push trigger" "true" "on: [push, pull_request]"
assert_workflow_trigger_case "push job is not a trigger" "false" $'on: pull_request\njobs:\n  push:\n    runs-on: ubuntu-latest'

for workflow in lint.yml test.yml e2e-tests.yml wework-e2e.yml; do
  workflow_path="$script_dir/../workflows/$workflow"
  if workflow_has_top_level_trigger "$workflow_path" "push"; then
    printf '%s must not repeat merge queue validation after entering main\n' \
      "$workflow" >&2
    exit 1
  fi
  # GitHub expressions are matched literally in workflow source.
  # shellcheck disable=SC2016
  if ! grep -Fq 'git diff --name-only "$BASE_SHA...$HEAD_SHA"' "$workflow_path"; then
    printf '%s must classify pull request changes from the merge base\n' \
      "$workflow" >&2
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

if ! grep -q "wework_desktop_core_e2e_matrix" "$wework_workflow" ||
  ! grep -q "wework_desktop_other_e2e_matrix" "$wework_workflow"; then
  printf 'Wework desktop E2E must use the split changed-feature matrices\n' >&2
  exit 1
fi

desktop_cache_step="$(
  extract_named_workflow_step "$wework_workflow" "Cache Cargo dependencies"
)"
desktop_cache_key="$(
  sed -n 's/^          key:[[:space:]]*//p' <<<"$desktop_cache_step"
)"
desktop_cache_restore_keys="$(
  awk '
    /^          restore-keys:/ {
      in_restore_keys = 1
      next
    }
    in_restore_keys && /^          [[:alnum:]_-]+:/ {
      exit
    }
    in_restore_keys {
      print
    }
  ' <<<"$desktop_cache_step"
)"
# GitHub expressions are matched literally in workflow source.
# shellcheck disable=SC2016
if ! grep -Fq '${{ matrix.command }}' <<<"$desktop_cache_key" ||
  ! grep -Fq '${{ matrix.command }}' <<<"$desktop_cache_restore_keys"; then
  printf 'Wework desktop E2E caches must be isolated by E2E command\n' >&2
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
  "needs.changes.outputs.wework_desktop_other_e2e == 'true'" \
  <<<"$wework_desktop_job"; then
  printf 'Wework non-Core desktop E2E must use its segment classification\n' >&2
  exit 1
fi

wework_desktop_core_job="$(
  sed -n '/^  wework-desktop-core-e2e:/,/^  wework-desktop-e2e:/p' "$wework_workflow"
)"
if ! grep -q \
  "needs.changes.outputs.wework_desktop_core_e2e == 'true'" \
  <<<"$wework_desktop_core_job"; then
  printf 'Wework Core desktop E2E must use its segment classification\n' >&2
  exit 1
fi

if ! grep -q "github.event_name != 'merge_group'" "$wework_workflow"; then
  printf 'Wework memory E2E must remain outside regular merge groups\n' >&2
  exit 1
fi

printf 'CI change classifier tests passed\n'
