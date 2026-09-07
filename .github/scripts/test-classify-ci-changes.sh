#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
classifier="$script_dir/classify-ci-changes.sh"
desktop_classifier="$script_dir/classify-wework-desktop-e2e.sh"
cloud_checkpoint_flows="$repo_root/wework/e2e/desktop/modules/cloud-checkpoint-flows.mjs"
desktop_build_flows="$repo_root/wework/e2e/desktop/modules/desktop-build-flows.mjs"
desktop_checkpoint_runner="$repo_root/wework/e2e/desktop/run-checkpoints.mjs"
memory_tool_flows="$repo_root/wework/e2e/desktop/modules/memory-tool-flows.mjs"
notification_isolation_scenario="$repo_root/wework/e2e/desktop/scenarios/codex-notification-isolation.scenario.mjs"
wework_app_workflow="$repo_root/.github/workflows/wework-app.yml"

assert_invalid_desktop_shards_rejected() {
  local temp_dir
  temp_dir="$(mktemp -d)"
  local broken_classifier="$temp_dir/classify-wework-desktop-e2e.sh"
  sed \
    's/,local-file-preview$//' \
    "$desktop_classifier" > "$broken_classifier"
  chmod +x "$broken_classifier"

  if GITHUB_OUTPUT="$temp_dir/output" "$broken_classifier" --all \
    >"$temp_dir/stdout" 2>"$temp_dir/stderr"; then
    printf 'Desktop classifier accepted a core shard mapping with a missing segment\n' >&2
    rm -rf "$temp_dir"
    exit 1
  fi
  if ! grep -Fq 'Core segment missing from core_shards: local-file-preview' \
    "$temp_dir/stderr"; then
    printf 'Desktop classifier did not explain the missing core segment\n' >&2
    cat "$temp_dir/stderr" >&2
    rm -rf "$temp_dir"
    exit 1
  fi
  rm -rf "$temp_dir"
}

assert_invalid_cloud_shards_rejected() {
  local temp_dir
  temp_dir="$(mktemp -d)"
  local broken_classifier="$temp_dir/classify-wework-desktop-e2e.sh"
  awk '
    /^cloud_shards=\($/ {
      in_cloud_shards = 1
    }
    in_cloud_shards && /plugin-auto-update/ {
      sub(/plugin-auto-update,?/, "")
    }
    {
      print
    }
    in_cloud_shards && /^\)$/ {
      in_cloud_shards = 0
    }
  ' "$desktop_classifier" > "$broken_classifier"
  chmod +x "$broken_classifier"

  if GITHUB_OUTPUT="$temp_dir/output" "$broken_classifier" --all \
    >"$temp_dir/stdout" 2>"$temp_dir/stderr"; then
    printf 'Desktop classifier accepted a cloud shard mapping with a missing segment\n' >&2
    rm -rf "$temp_dir"
    exit 1
  fi
  if ! grep -Fq 'Cloud segment missing from cloud_shards: plugin-auto-update' \
    "$temp_dir/stderr"; then
    printf 'Desktop classifier did not explain the missing cloud segment\n' >&2
    cat "$temp_dir/stderr" >&2
    rm -rf "$temp_dir"
    exit 1
  fi
  rm -rf "$temp_dir"
}

assert_invalid_desktop_shards_rejected
assert_invalid_cloud_shards_rejected

if ! grep -Eq -- '--(segment|parallel-segments)[[:space:]][^[:space:]]*app-update-differential' \
  "$wework_app_workflow"; then
  printf 'The formal release workflow must invoke app-update-differential\n' >&2
  exit 1
fi

if ! grep -Fq 'const NOISE_DELTA_COUNT = 2200' "$notification_isolation_scenario" ||
  ! grep -Fq 'const BURST_RENDER_TIMEOUT_MS = 30_000' "$notification_isolation_scenario"; then
  printf 'Codex notification isolation must retain its 2200-delta stress case and targeted 30-second render budget\n' >&2
  exit 1
fi

if ! grep -Fq 'const MEMORY_RESPONSE_TIMEOUT_MS = 30_000' "$memory_tool_flows" ||
  ! grep -Fq 'Date.now() - startedAt < MEMORY_RESPONSE_TIMEOUT_MS' "$memory_tool_flows"; then
  printf 'Wework memory E2E must use its targeted 30-second streaming response budget\n' >&2
  exit 1
fi

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

extract_named_workflow_step_from_job() {
  local workflow_path="$1"
  local job_start="$2"
  local job_end="$3"
  local step_name="$4"
  awk \
    -v job_start="$job_start" \
    -v job_end="$job_end" \
    -v target="$step_name" '
      $0 == job_start {
        in_job = 1
        next
      }
      in_job && $0 == job_end {
        in_job = 0
      }
      !in_job {
        next
      }
      found && /^      - name:/ {
        found = 0
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

assert_case "shared CI actions validate all modules" "$all_true" \
  ".github/actions/setup-sccache/action.yml"

assert_case "shared apt helper validates all modules" "$all_true" \
  ".github/scripts/lib/apt-packages.sh"

assert_case "cache policy helper validates all modules" "$all_true" \
  ".github/scripts/lib/validate-ci-cache-policy.rb"

assert_case "cache warmup classifier validates all modules" "$all_true" \
  ".github/scripts/classify-ci-cache-warmup.sh"

assert_case "cache policy changes validate all modules" "$all_true" \
  ".github/scripts/test-ci-cache-policy.sh"

assert_case "release workflow changes validate all modules" "$all_true" \
  ".github/workflows/publish-image.yml"

assert_case "base image workflow changes validate all modules" "$all_true" \
  ".github/workflows/publish-base-image.yml"

assert_case "cache warmup changes validate all modules" "$all_true" \
  ".github/workflows/ci-cache-warmup.yml"

assert_case "ci:all label forces all modules" "$all_true" --all

platform_e2e_expected="${all_false/platform_e2e=false/platform_e2e=true}"
assert_case "docker changes run platform E2E" "$platform_e2e_expected" \
  "docker/docker-compose.yml"

executor_dependency_expected="${platform_e2e_expected/executor=false/executor=true}"
assert_case "executor dependency setup changes run executor and platform E2E" \
  "$executor_dependency_expected" \
  ".github/scripts/install-executor-rust-system-dependencies.sh"

assert_case "executor E2E resolver changes run platform E2E" \
  "$platform_e2e_expected" \
  ".github/scripts/resolve-executor-e2e-runtime.sh"

wework_e2e_expected="${all_false/wework_e2e=false/wework_e2e=true}"
assert_case "Wework workflow changes run Wework E2E" "$wework_e2e_expected" \
  ".github/workflows/wework-e2e.yml"

assert_case "Wework artifact scripts run Wework E2E" "$wework_e2e_expected" \
  ".github/scripts/archive-wework-core-e2e-build.sh"

assert_case "Wework E2E image changes run Wework E2E" "$wework_e2e_expected" \
  "docker/wework-e2e/desktop.Dockerfile"

assert_desktop_case() {
  local name="$1"
  local expected="$2"
  shift 2

  if [[ "$expected" != *"wework_desktop_cloud_e2e="* ]]; then
    local cloud_defaults
    cloud_defaults='wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e='
    expected="${expected/wework_desktop_other_e2e=/$cloud_defaults}"
  fi
  if [[ "$expected" != *"wework_desktop_macos_inspector_e2e="* ]]; then
    expected="${expected}"$'\n''wework_desktop_macos_inspector_e2e=false'
  fi
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
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"conversation-state"},{"id":"core-7","name":"Core / shard 7","segments":"core-task-flow"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/runtimeConversationCache.ts"

assert_desktop_case "independent features select the union of minimum segments" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"goal-lifecycle"},{"id":"core-13","name":"Core / shard 13","segments":"rendering-extensions"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/lib/runtime-goal.ts" \
  "wework/src/components/chat/blocks/ToolBlockItem.tsx"

assert_desktop_case "runner coverage does not broaden a classified feature" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"conversation-state"},{"id":"core-13","name":"Core / shard 13","segments":"rendering-extensions"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/task-flow.e2e.mjs" \
  "wework/src/components/chat/MessageList.tsx"

assert_desktop_case "turn lifecycle changes select supervisor and resilience coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"supervisor-lifecycle"},{"id":"core-10","name":"Core / shard 10","segments":"resilience"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/runtimeTaskLifecycle/reducer.ts"

assert_desktop_case "runtime pane events select supervisor and conversation coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"supervisor-lifecycle"},{"id":"core-5","name":"Core / shard 5","segments":"conversation-state"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/runtimePaneMessages.ts"

assert_desktop_case "temporary chat files select temporary chat coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"temporary-chat"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/workspace-panels/TemporaryChatPanel.tsx"

assert_desktop_case "shared right workspace panel selects plugin development and temporary chat" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"temporary-chat"},{"id":"core-16","name":"Core / shard 16","segments":"plugin-development"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/workspace-panels/RightWorkspacePanel.tsx"

assert_desktop_case "main workbench changes select fixed environment panel coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"temporary-chat"},{"id":"core-5","name":"Core / shard 5","segments":"cloud-context-resilience"},{"id":"core-7","name":"Core / shard 7","segments":"task-board-association"},{"id":"core-10","name":"Core / shard 10","segments":"environment-panel-scroll"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/DesktopWorkbenchMain.tsx"

assert_desktop_case "main workbench layout test selects fixed environment panel coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-10","name":"Core / shard 10","segments":"environment-panel-scroll"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/DesktopWorkbenchLayout.test.tsx"

assert_desktop_case "startup splash selects native startup coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-14","name":"Core / shard 14","segments":"native-window-startup"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/electron/src/host/startup-splash.ts" \
  "wework/electron/src/shell/startup-splash/styles.css"

assert_desktop_case "Wework documentation skips desktop E2E" \
  'wework_desktop_e2e=false
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/README.md"

full_desktop_expected='wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"harness-apps,browser-annotation-design"},{"id":"core-2","name":"Core / shard 2","segments":"supervisor-lifecycle,remote-device-onboarding"},{"id":"core-3","name":"Core / shard 3","segments":"temporary-chat,local-file-preview"},{"id":"core-4","name":"Core / shard 4","segments":"goal-lifecycle,embedded-browser,browser-annotation-core,permission-modes,tray-lifecycle"},{"id":"core-5","name":"Core / shard 5","segments":"conversation-state,project-ai-settings,offline-local-project-space,cloud-context-resilience,cloud-space-mention"},{"id":"core-6","name":"Core / shard 6","segments":"claude-runtime,workspace-tabs,task-attachments"},{"id":"core-7","name":"Core / shard 7","segments":"task-status-sync,task-board-association,core-task-flow,change-request-status,context-compaction"},{"id":"core-8","name":"Core / shard 8","segments":"window-lifecycle,runtime-terminal-convergence,browser-toolbar-actions,browser-annotation-anchors"},{"id":"core-9","name":"Core / shard 9","segments":"project-automation"},{"id":"core-10","name":"Core / shard 10","segments":"resilience"},{"id":"core-11","name":"Core / shard 11","segments":"workspace-attachments,automation-lifecycle"},{"id":"core-12","name":"Core / shard 12","segments":"project-assignment-notification,split-workbench,priority-filter"},{"id":"core-13","name":"Core / shard 13","segments":"rendering-extensions"},{"id":"core-14","name":"Core / shard 14","segments":"runtime-task-queue,release-package-startup,component-update,native-window-startup,renderer-storage,external-content-import"},{"id":"core-15","name":"Core / shard 15","segments":"local-harness,running-conversation-history,native-window-chrome"},{"id":"core-16","name":"Core / shard 16","segments":"codex-notification-isolation,core-dsh-plugin-management,plugin-development,executor-stream-recovery"},{"id":"core-17","name":"Core / shard 17","segments":"model-routing,computer-use"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"core-task-flow"},{"id":"cloud-2","name":"Cloud / shard 2","segments":"embedded-browser,cloud-worktree-device-restart,cloud-project-creation"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"goal-lifecycle,cloud-worktree-archive-restore"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"rendering-extensions"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"project-automation"},{"id":"cloud-6","name":"Cloud / shard 6","segments":"window-lifecycle"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"priority-filter,cloud-worktree-tools"},{"id":"cloud-8","name":"Cloud / shard 8","segments":"resilience,telemetry-consent"},{"id":"cloud-9","name":"Cloud / shard 9","segments":"cloud-worktree-create,automation-lifecycle,browser-multi-tabs"},{"id":"cloud-10","name":"Cloud / shard 10","segments":"workspace-tabs,cloud-worktree-capability"},{"id":"cloud-11","name":"Cloud / shard 11","segments":"supervisor-lifecycle,conversation-state"},{"id":"cloud-12","name":"Cloud / shard 12","segments":"model-routing"},{"id":"cloud-13","name":"Cloud / shard 13","segments":"plugin-auto-update,plugin-workspace-publication"},{"id":"cloud-14","name":"Cloud / shard 14","segments":"cloud-worktree-queued-cancel"},{"id":"cloud-15","name":"Cloud / shard 15","segments":"workspace-attachments"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":""}]}
wework_desktop_macos_inspector_e2e=true'
full_desktop_expected="${full_desktop_expected/\"segments\":\"resilience\"/\"segments\":\"resilience,environment-panel-scroll\"}"

assert_desktop_case "runner-only changes retain full coverage" \
  "$full_desktop_expected" \
  "wework/e2e/desktop/task-flow.e2e.mjs"

assert_desktop_case "external content import changes select its desktop regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-14","name":"Core / shard 14","segments":"external-content-import"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "executor/src/local/codex_home.rs" \
  "wework/e2e/desktop/scenarios/external-content-import.scenario.mjs"

assert_desktop_case "embedded browser files select browser coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"browser-annotation-design"},{"id":"core-4","name":"Core / shard 4","segments":"embedded-browser,browser-annotation-core"},{"id":"core-8","name":"Core / shard 8","segments":"browser-toolbar-actions,browser-annotation-anchors"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=true' \
  "wework/src/lib/browser-url.ts"

assert_desktop_case "browser toolbar scenario is invoked by Core and macOS CI" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"browser-annotation-design"},{"id":"core-4","name":"Core / shard 4","segments":"embedded-browser,browser-annotation-core"},{"id":"core-8","name":"Core / shard 8","segments":"browser-toolbar-actions,browser-annotation-anchors"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=true' \
  "wework/e2e/desktop/scenarios/embedded-browser-toolbar-actions.scenario.mjs"

assert_desktop_case "local harness files select local harness coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"claude-runtime"},{"id":"core-15","name":"Core / shard 15","segments":"local-harness"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/lib/local-harness.ts"

assert_desktop_case "Claude runtime messaging selects task and Claude coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"project-ai-settings"},{"id":"core-6","name":"Core / shard 6","segments":"claude-runtime"},{"id":"core-7","name":"Core / shard 7","segments":"core-task-flow"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"cloud-worktree-device-restart"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"cloud-worktree-archive-restore"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"cloud-worktree-tools"},{"id":"cloud-9","name":"Cloud / shard 9","segments":"cloud-worktree-create"},{"id":"cloud-10","name":"Cloud / shard 10","segments":"cloud-worktree-capability"},{"id":"cloud-14","name":"Cloud / shard 14","segments":"cloud-worktree-queued-cancel"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/useWorkbenchRuntimeMessaging.ts"

assert_desktop_case "local file preview files select the shared preview checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"local-file-preview"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/workspace-panels/WorkspaceFilePreview.tsx"

assert_desktop_case "Core artifact changes retain full coverage" \
  "$full_desktop_expected" \
  ".github/scripts/archive-wework-core-e2e-build.sh"

assert_desktop_case "skill mention files select plugin and core coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"core-task-flow"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins-skill-mention-rendering","name":"Plugins / skill-mention-rendering","command":"e2e:desktop:plugins","segment":"skill-mention-rendering"}]}' \
  "wework/src/components/chat/composer/ComposerMentionMenu.tsx"

assert_desktop_case "model settings select task launch and model routing coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"project-ai-settings"},{"id":"core-7","name":"Core / shard 7","segments":"core-task-flow"},{"id":"core-17","name":"Core / shard 17","segments":"model-routing"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/model-settings/localModelSettings.ts"

assert_desktop_case "composer plugin files select project plugin coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"project-ai-settings"},{"id":"core-7","name":"Core / shard 7","segments":"core-task-flow"},{"id":"core-17","name":"Core / shard 17","segments":"model-routing"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/chat/composer/PluginPickerMenu.tsx"

assert_desktop_case "automation files select only automation lifecycle coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-11","name":"Core / shard 11","segments":"automation-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/automations/AutomationDetailWorkspace.tsx"

assert_desktop_case "project automation files select lifecycle and project coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-9","name":"Core / shard 9","segments":"project-automation"},{"id":"core-11","name":"Core / shard 11","segments":"automation-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/todo/ProjectAutomationRulesSection.tsx"

assert_desktop_case "project automation E2E changes select core and cloud coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-9","name":"Core / shard 9","segments":"project-automation"},{"id":"core-11","name":"Core / shard 11","segments":"automation-lifecycle"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"core-task-flow"},{"id":"cloud-2","name":"Cloud / shard 2","segments":"embedded-browser,cloud-worktree-device-restart,cloud-project-creation"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"goal-lifecycle,cloud-worktree-archive-restore"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"rendering-extensions"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"project-automation"},{"id":"cloud-6","name":"Cloud / shard 6","segments":"window-lifecycle"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"priority-filter,cloud-worktree-tools"},{"id":"cloud-8","name":"Cloud / shard 8","segments":"resilience,telemetry-consent"},{"id":"cloud-9","name":"Cloud / shard 9","segments":"cloud-worktree-create,automation-lifecycle,browser-multi-tabs"},{"id":"cloud-10","name":"Cloud / shard 10","segments":"workspace-tabs,cloud-worktree-capability"},{"id":"cloud-11","name":"Cloud / shard 11","segments":"supervisor-lifecycle,conversation-state"},{"id":"cloud-12","name":"Cloud / shard 12","segments":"model-routing"},{"id":"cloud-13","name":"Cloud / shard 13","segments":"plugin-auto-update,plugin-workspace-publication"},{"id":"cloud-14","name":"Cloud / shard 14","segments":"cloud-worktree-queued-cancel"},{"id":"cloud-15","name":"Cloud / shard 15","segments":"workspace-attachments"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/project-automation.scenario.mjs"

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
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"core-task-flow"},{"id":"cloud-2","name":"Cloud / shard 2","segments":"embedded-browser,cloud-worktree-device-restart,cloud-project-creation"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"goal-lifecycle,cloud-worktree-archive-restore"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"rendering-extensions"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"project-automation"},{"id":"cloud-6","name":"Cloud / shard 6","segments":"window-lifecycle"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"priority-filter,cloud-worktree-tools"},{"id":"cloud-8","name":"Cloud / shard 8","segments":"resilience,telemetry-consent"},{"id":"cloud-9","name":"Cloud / shard 9","segments":"cloud-worktree-create,automation-lifecycle,browser-multi-tabs"},{"id":"cloud-10","name":"Cloud / shard 10","segments":"workspace-tabs,cloud-worktree-capability"},{"id":"cloud-11","name":"Cloud / shard 11","segments":"supervisor-lifecycle,conversation-state"},{"id":"cloud-12","name":"Cloud / shard 12","segments":"model-routing"},{"id":"cloud-13","name":"Cloud / shard 13","segments":"plugin-auto-update,plugin-workspace-publication"},{"id":"cloud-14","name":"Cloud / shard 14","segments":"cloud-worktree-queued-cancel"},{"id":"cloud-15","name":"Cloud / shard 15","segments":"workspace-attachments"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/cloud-connection/CloudConnectionProvider.tsx"

assert_desktop_case "worktree UI changes select local launch and cloud lifecycle coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"core-task-flow"},{"id":"core-11","name":"Core / shard 11","segments":"workspace-attachments"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"cloud-worktree-device-restart"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"cloud-worktree-archive-restore"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"cloud-worktree-tools"},{"id":"cloud-9","name":"Cloud / shard 9","segments":"cloud-worktree-create"},{"id":"cloud-10","name":"Cloud / shard 10","segments":"cloud-worktree-capability"},{"id":"cloud-14","name":"Cloud / shard 14","segments":"cloud-worktree-queued-cancel"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/lib/worktree-availability.ts"

assert_desktop_case "task status projection changes select status synchronization coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"task-status-sync"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/workbench/projectTaskTracking.ts"

assert_desktop_case "workbench cloud context changes select non-blocking composer coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"cloud-context-resilience"},{"id":"core-7","name":"Core / shard 7","segments":"task-status-sync,task-board-association"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/useWorkbenchCloudProjectContext.ts"

assert_desktop_case "task board association UI changes select dedicated coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"task-status-sync,task-board-association"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/todo/TaskBoardAssociationDialog.tsx"

assert_desktop_case "backend runtime Worktree changes select the cloud lifecycle checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"cloud-worktree-device-restart"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"cloud-worktree-archive-restore"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"cloud-worktree-tools"},{"id":"cloud-9","name":"Cloud / shard 9","segments":"cloud-worktree-create"},{"id":"cloud-10","name":"Cloud / shard 10","segments":"cloud-worktree-capability"},{"id":"cloud-14","name":"Cloud / shard 14","segments":"cloud-worktree-queued-cancel"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "backend/app/services/device/runtime_route.py"

assert_desktop_case "runtime task queue scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-14","name":"Core / shard 14","segments":"runtime-task-queue"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/runtime-task-queue.scenario.mjs"

assert_desktop_case "Codex notification isolation scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-16","name":"Core / shard 16","segments":"codex-notification-isolation"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/codex-notification-isolation.scenario.mjs"

assert_desktop_case "executor stream recovery scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-16","name":"Core / shard 16","segments":"executor-stream-recovery"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/executor-stream-recovery.scenario.mjs"

assert_desktop_case "plugin files select plugin lifecycle and project plugin coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"project-ai-settings"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins-plugin-lifecycle","name":"Plugins / plugin-lifecycle","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}' \
  "wework/src/components/plugins/PluginsWorkspace.tsx"

assert_desktop_case "Core DSH plugin files select their desktop checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-16","name":"Core / shard 16","segments":"core-dsh-plugin-management,plugin-development"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/electron/src/runtime/core-dsh-plugin-manager.ts"

assert_desktop_case "plugin development files select the full desktop workflow" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-16","name":"Core / shard 16","segments":"plugin-development"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/electron/src/runtime/plugin-development-manager.ts"

assert_desktop_case "DSH UI plugin files select composition coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins-core-dsh-ui-plugin-composition","name":"Plugins / core-dsh-ui-plugin-composition","command":"e2e:desktop:plugins","segment":"core-dsh-ui-plugin-composition"}]}' \
  "wework/dsh/ui-applications/client.js"

assert_desktop_case "Wework plugin developer Demo selects development and composition coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-16","name":"Core / shard 16","segments":"plugin-development"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins-core-dsh-ui-plugin-composition","name":"Plugins / core-dsh-ui-plugin-composition","command":"e2e:desktop:plugins","segment":"core-dsh-ui-plugin-composition"}]}' \
  "wework/dsh/plugin-developer/codex-plugin/skills/develop-wework-plugin/assets/ui-extension-demo/client.js"

assert_desktop_case "desktop sidebar selects all owned checkpoints" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"project-ai-settings"},{"id":"core-7","name":"Core / shard 7","segments":"core-task-flow"},{"id":"core-11","name":"Core / shard 11","segments":"workspace-attachments"},{"id":"core-12","name":"Core / shard 12","segments":"priority-filter"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/components/layout/DesktopSidebar.tsx"

assert_desktop_case "priority section selects only its dedicated checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-12","name":"Core / shard 12","segments":"priority-filter"}]}
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
  if [[ "$workflow" == "wework-e2e.yml" ]]; then
    if ! grep -Fq "github.event.merge_group.base_sha" "$workflow_path" ||
      ! grep -Fq "github.event.merge_group.head_sha" "$workflow_path" ||
      ! grep -Fq "github.event_name != 'merge_group'" "$workflow_path" ||
      ! grep -Fq "grep -v '^\\.github/'" "$workflow_path"; then
      printf '%s must classify merge groups from their product diff\n' \
        "$workflow" >&2
      exit 1
    fi
  elif ! grep -Fq \
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

if grep -Fq 'WEWORK_E2E_SKIP_TYPECHECK' "$desktop_build_flows" ||
  grep -Fq 'WEWORK_E2E_SKIP_TYPECHECK' "$wework_workflow"; then
  printf 'Prebuilt Electron E2E must not retain the obsolete typecheck bypass\n' >&2
  exit 1
fi

if ! grep -q "wework_desktop_core_e2e_matrix" "$wework_workflow" ||
  ! grep -q "wework_desktop_other_e2e_matrix" "$wework_workflow"; then
  printf 'Wework desktop E2E must use the split changed-feature matrices\n' >&2
  exit 1
fi

core_build_job="$(
  sed -n '/^  build-wework-desktop-core-e2e:/,/^  wework-desktop-core-e2e:/p' \
    "$wework_workflow"
)"
desktop_other_job="$(
  sed -n '/^  wework-desktop-e2e:/,/^  wework-e2e-summary:/p' \
    "$wework_workflow"
)"
if [[ "$core_build_job" != *"pnpm --filter wework ai:verify:electron:build"* ]] ||
  [[ "$core_build_job" != *"wework/electron/release/WeWork-linux-x64/WeWork"* ]] ||
  [[ "$core_build_job" != *"resources/bin/wegent-executor"* ]]; then
  printf 'The shared desktop E2E artifact must be built from the Electron package\n' >&2
  exit 1
fi

if [[ "$desktop_other_job" != *"build-wework-desktop-core-e2e"* ]] ||
  [[ "$desktop_other_job" != *".github/scripts/download-actions-artifact.sh"* ]] ||
  [[ "$desktop_other_job" != *"electron-app/WeWork"* ]] ||
  [[ "$desktop_other_job" != *"electron-app/resources/bin/wegent-executor"* ]]; then
  printf 'Non-Core desktop E2E must consume the shared Electron package\n' >&2
  exit 1
fi

electron_cache_step="$(
  extract_named_workflow_step_from_job \
    "$wework_workflow" \
    "  build-wework-desktop-core-e2e:" \
    "  wework-desktop-core-e2e:" \
    "Restore shared Wework Electron E2E build dependencies"
)"
electron_cache_key="$(
  printf '%s\n' "$electron_cache_step" |
    sed -n 's/^          key:[[:space:]]*//p'
)"
# GitHub expressions are matched literally in workflow source.
# shellcheck disable=SC2016
if ! grep -Fq '${{ runner.os }}-wework-electron-e2e-v1-' \
  <<<"$electron_cache_key" ||
  ! grep -Fq "hashFiles('docker/wework-e2e/desktop.Dockerfile')" \
    <<<"$electron_cache_key"; then
  printf 'Wework Electron E2E cache key must follow the desktop image\n' >&2
  exit 1
fi

electron_cache_save_step="$(
  extract_named_workflow_step \
    "$wework_workflow" \
    "Save shared Wework Electron E2E build dependencies"
)"
# GitHub expressions are matched literally in workflow source.
# shellcheck disable=SC2016
if ! grep -Fq "if: github.ref == 'refs/heads/main'" \
  <<<"$electron_cache_save_step" ||
  ! grep -Fq \
    'key: ${{ steps.wework-desktop-cargo-cache.outputs.cache-primary-key }}' \
    <<<"$electron_cache_save_step"; then
  printf 'Only main may save the shared Wework Electron E2E cache\n' >&2
  exit 1
fi

wework_browser_job="$(
  sed -n '/^  wework-e2e:/,/^  build-wework-desktop-core-e2e:/p' \
    "$wework_workflow"
)"
if [[ "$wework_browser_job" != *"needs.changes.outputs.wework_e2e == 'true'"* ]]; then
  printf 'Wework browser E2E must use the broad Wework change classification\n' >&2
  exit 1
fi
if [[ "$wework_browser_job" == *"if: github.event_name != 'pull_request' ||"* ]]; then
  printf 'Wework browser E2E must honor merge-group change classification\n' >&2
  exit 1
fi

wework_changes_job="$(
  sed -n '/^  changes:/,/^  wework-e2e:/p' "$wework_workflow"
)"
# GitHub expressions and shell source are matched literally in workflow source.
# shellcheck disable=SC2016
if grep -Fq "prepare-wework-e2e-image" "$wework_workflow" ||
  [[ "$wework_changes_job" != *'browser_image: ${{ steps.image.outputs.browser-ref }}'* ]] ||
  [[ "$wework_changes_job" != *'desktop_image: ${{ steps.image.outputs.desktop-ref }}'* ]] ||
  [[ "$wework_changes_job" != *'docker manifest inspect "$IMAGE"'* ]] ||
  [[ "$wework_changes_job" != *"steps.browser-image-check.outputs.exists == 'false'"* ]] ||
  [[ "$wework_changes_job" != *"steps.desktop-image-check.outputs.exists == 'false'"* ]]; then
  printf 'Wework image resolution must share the change-detection job and build only misses\n' >&2
  exit 1
fi

wework_desktop_job="$(
  sed -n '/^  wework-desktop-e2e:/,/^  wework-e2e-summary:/p' "$wework_workflow"
)"
if [[ "$wework_desktop_job" != *"needs.changes.outputs.wework_desktop_other_e2e == 'true'"* ]]; then
  printf 'Wework non-Core desktop E2E must use its segment classification\n' >&2
  exit 1
fi
if [[ "$wework_desktop_job" == *"if: github.event_name != 'pull_request' ||"* ]]; then
  printf 'Wework non-Core desktop E2E must honor merge-group change classification\n' >&2
  exit 1
fi

wework_desktop_cloud_job="$(
  sed -n '/^  wework-desktop-cloud-e2e:/,/^  wework-desktop-e2e:/p' "$wework_workflow"
)"
if [[ "$wework_desktop_cloud_job" != *"needs.changes.outputs.wework_desktop_cloud_e2e == 'true'"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"fromJSON(needs.changes.outputs.wework_desktop_cloud_e2e_matrix)"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"max-parallel: 15"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"--parallel-segments"* ]] ||
  [[ "$wework_desktop_cloud_job" != *'WEWORK_E2E_PARALLEL_CHECKPOINTS: "1"'* ]] ||
  [[ "$wework_desktop_cloud_job" != *'WEWORK_E2E_ISOLATED_XVFB: "true"'* ]] ||
  [[ "$wework_desktop_cloud_job" != *"compression-level: 0"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"name: Download shared Wework desktop E2E build"* ]] ||
  [[ "$wework_desktop_cloud_job" != *".github/scripts/download-actions-artifact.sh"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"WEWORK_E2E_APP_BIN:"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"WEWORK_E2E_EXECUTOR_BIN:"* ]]; then
  printf 'Wework Cloud desktop E2E must use fifteen prebuilt serial shards\n' >&2
  exit 1
fi
if [[ "$wework_desktop_cloud_job" == *"if: github.event_name != 'pull_request' ||"* ]]; then
  printf 'Wework Cloud desktop E2E must honor merge-group change classification\n' >&2
  exit 1
fi

wework_desktop_core_job="$(
  sed -n '/^  wework-desktop-core-e2e:/,/^  build-wework-desktop-windows-core-e2e:/p' \
    "$wework_workflow"
)"
if [[ "$wework_desktop_core_job" != *"needs.changes.outputs.wework_desktop_core_e2e == 'true'"* ]] ||
  [[ "$wework_desktop_core_job" != *"max-parallel: 17"* ]] ||
  [[ "$wework_desktop_core_job" != *'WEWORK_E2E_PARALLEL_CHECKPOINTS: "1"'* ]] ||
  [[ "$wework_desktop_core_job" != *"WEWORK_E2E_SCREENSHOTS:"* ]] ||
  [[ "$wework_desktop_core_job" == *"name: Set up Node workspace"* ]] ||
  [[ "$wework_desktop_core_job" != *"compression-level: 0"* ]]; then
  printf 'Wework Core desktop E2E must use seventeen prebuilt serial shards\n' >&2
  exit 1
fi
if [[ "$wework_desktop_core_job" == *"if: github.event_name != 'pull_request' ||"* ]]; then
  printf 'Wework Core desktop E2E must honor merge-group change classification\n' >&2
  exit 1
fi

wework_windows_desktop_core_build_job="$(
  sed -n \
    '/^  build-wework-desktop-windows-core-e2e:/,/^  wework-desktop-windows-core-e2e:/p' \
    "$wework_workflow"
)"
if [[ "$wework_windows_desktop_core_build_job" != *"runs-on: windows-latest"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"github.event_name != 'merge_group'"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"github.event.action == 'labeled'"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"pnpm --filter wework ai:verify:electron:build"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"WeWork-win32-x64/WeWork.exe"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"resources/bin/wegent-executor.exe"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"resources/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"resources/bundled-plugins/wework-personal/.agents/plugins/marketplace.json"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"include-hidden-files: true"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"REDIS_WINDOWS_VERSION: 8.10.1"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"REDIS_WINDOWS_SHA256: 4e8f2f956ed92feadf3f64b4e137ed34026438821e692e7ae22c9bba5976607a"* ]] ||
  [[ "$wework_windows_desktop_core_build_job" != *"name: wework-desktop-windows-redis-e2e-tools"* ]]; then
  printf 'Windows Wework Core desktop E2E must build a native packaged application\n' >&2
  exit 1
fi

wework_windows_desktop_core_job="$(
  sed -n '/^  wework-desktop-windows-core-e2e:/,/^  wework-desktop-cloud-e2e:/p' \
    "$wework_workflow"
)"
if [[ "$wework_windows_desktop_core_job" != *"runs-on: windows-latest"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"github.event_name != 'merge_group'"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"github.event.action == 'labeled'"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"fromJSON(needs.changes.outputs.wework_desktop_core_e2e_matrix)"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"max-parallel: 17"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *'WEWORK_E2E_PARALLEL_CHECKPOINTS: "1"'* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"--parallel-segments"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"WEWORK_E2E_APP_BIN:"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"WEWORK_E2E_EXECUTOR_BIN:"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"WEWORK_E2E_CODEX_BIN:"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"bundled-plugins/wework-personal/.agents/plugins/marketplace.json"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"name: wework-desktop-windows-redis-e2e-tools"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"uses: ./.github/actions/setup-python-uv-cache"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *'python-version: "3.12"'* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"shell: pwsh"* ]] ||
  [[ "$wework_windows_desktop_core_job" != *"WEWORK_E2E_REDIS_SERVER_BIN=\$redisServerPath"* ]] ||
  [[ "$wework_windows_desktop_core_job" == *"\$redisRoot | Out-File -FilePath \$env:GITHUB_PATH"* ]]; then
  printf 'Windows Wework Core desktop E2E must use all selected Core shards\n' >&2
  exit 1
fi

wework_summary_job="$(
  sed -n '/^  wework-e2e-summary:/,/^  wework-desktop-memory-e2e:/p' \
    "$wework_workflow"
)"
if [[ "$wework_summary_job" == *"RUN_DESKTOP_CORE_E2E: \${{ github.event_name != 'pull_request' ||"* ]] ||
  [[ "$wework_summary_job" == *"RUN_DESKTOP_CLOUD_E2E: \${{ github.event_name != 'pull_request' ||"* ]] ||
  [[ "$wework_summary_job" == *"RUN_DESKTOP_OTHER_E2E: \${{ github.event_name != 'pull_request' ||"* ]]; then
  printf 'Wework E2E summary must honor merge-group change classification\n' >&2
  exit 1
fi
if [[ "$wework_summary_job" != *"RUN_WINDOWS_DESKTOP_CORE_E2E:"* ]] ||
  [[ "$(grep -Fc "\"\$RUN_WINDOWS_DESKTOP_CORE_E2E\" == \"true\"" <<<"$wework_summary_job")" -ne 2 ]]; then
  printf 'Wework E2E summary must check Windows Core only when explicitly scheduled\n' >&2
  exit 1
fi

if grep -q '^  push:' "$wework_workflow"; then
  printf 'Wework E2E must not run the full suite after every main push\n' >&2
  exit 1
fi

if [[ "$wework_desktop_cloud_job" == *"name: Set up Node workspace"* ]] ||
  [[ "$wework_desktop_job" == *"name: Set up Node workspace"* ]] ||
  [[ "$(grep -Fc 'name: Prune transient Wework desktop E2E caches' "$wework_workflow")" -ne 5 ]]; then
  printf 'Wework desktop shards must avoid workspace dependency restores and prune transient caches\n' >&2
  exit 1
fi

for generated_path_exclusion in \
  '!wework/test-results/desktop-e2e/**/electron-user-data/managed-runtimes/**' \
  '!wework/test-results/desktop-e2e/**/electron-user-data/dsh-core/profiles/**' \
  '!wework/test-results/desktop-e2e/**/electron-user-data/harness-apps/instances/**/profiles/**' \
  '!wework/test-results/desktop-e2e/**/harness-runtime/**' \
  '!wework/test-results/desktop-e2e/**/node-runtime/**' \
  '!wework/test-results/desktop-e2e/**/WeWork-Electron-E2E-*.app/**'; do
  if [[ "$(grep -Fc "$generated_path_exclusion" "$wework_workflow")" -ne 5 ]]; then
    printf 'Wework desktop diagnostics must exclude generated Electron runtime files\n' >&2
    exit 1
  fi
done

if ! grep -Fq 'const DEFAULT_PARALLEL_CHECKPOINTS = 1' "$desktop_checkpoint_runner"; then
  printf 'Wework desktop E2E must default to one checkpoint per runner\n' >&2
  exit 1
fi

if grep -Fq 'cases: CLOUD_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES' "$desktop_build_flows" ||
  [[ "$(grep -Fc \
    'cases: CLOUD_EXECUTION_MODEL_PROTOCOL_MATRIX_CASES' \
    "$cloud_checkpoint_flows")" -ne 1 ]]; then
  printf 'Cloud model protocol coverage must run once in its dedicated checkpoint\n' >&2
  exit 1
fi

if ! grep -q "github.event_name != 'merge_group'" "$wework_workflow"; then
  printf 'Wework memory E2E must remain outside regular merge groups\n' >&2
  exit 1
fi

wework_memory_job="$(
  sed -n '/^  wework-desktop-memory-e2e:/,$p' "$wework_workflow"
)"
if [[ "$wework_memory_job" != *"pnpm-store-v2-"* ]] ||
  [[ "$wework_memory_job" != *"'wework/electron/pnpm-lock.yaml'"* ]] ||
  [[ "$wework_memory_job" != *"pnpm install --frozen-lockfile"* ]] ||
  [[ "$wework_memory_job" != *"pnpm --dir wework/electron install --frozen-lockfile"* ]] ||
  [[ "$wework_memory_job" == *"--offline"* ]]; then
  printf 'Wework memory E2E must allow dependency downloads when the macOS pnpm cache is incomplete\n' >&2
  exit 1
fi

printf 'CI change classifier tests passed\n'
