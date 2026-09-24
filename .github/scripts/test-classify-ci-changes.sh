#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
classifier="$script_dir/classify-ci-changes.sh"
desktop_classifier="$script_dir/classify-wework-desktop-e2e.sh"
plugin_auth_classifier="$script_dir/classify-plugin-auth-sdk.sh"
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
    's/environment-panel-scroll,local-file-preview,renderer-storage/environment-panel-scroll,renderer-storage/' \
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

assert_plugin_auth_case() {
  local name="$1"
  local expected="$2"
  shift 2

  local output
  output="$(GITHUB_OUTPUT=/dev/stdout "$plugin_auth_classifier" "$@")"
  if [[ "$output" != "plugin_auth_sdk=$expected" ]]; then
    printf 'Plugin auth case "%s" failed: %s\n' "$name" "$output" >&2
    exit 1
  fi
}

assert_plugin_auth_case "unrelated Wework change" false \
  "wework/src/App.tsx"
assert_plugin_auth_case "native auth source" true \
  "executor/src/plugin_account_auth/mod.rs"
assert_plugin_auth_case "explicit full regression" true --all

assert_checkpoint_runtime_failure_rejected() {
  local temp_dir
  temp_dir="$(mktemp -d)"
  printf '#!/bin/sh\nexit 23\n' > "$temp_dir/node"
  chmod +x "$temp_dir/node"
  if PATH="$temp_dir:$PATH" GITHUB_OUTPUT="$temp_dir/output" "$desktop_classifier" --all \
    >"$temp_dir/stdout" 2>"$temp_dir/stderr"; then
    printf 'Desktop classifier ignored a failed checkpoint runtime\n' >&2
    rm -rf "$temp_dir"
    exit 1
  fi
  if ! grep -Fq 'Could not load registered desktop checkpoints' "$temp_dir/stderr"; then
    cat "$temp_dir/stderr" >&2
    rm -rf "$temp_dir"
    exit 1
  fi
  rm -rf "$temp_dir"
}

assert_checkpoint_runtime_failure_rejected

if ! grep -Eq -- '--(segment|parallel-segments)[[:space:]][^[:space:]]*app-update-differential' \
  "$wework_app_workflow"; then
  printf 'The formal release workflow must invoke app-update-differential\n' >&2
  exit 1
fi
if ! grep -Eq -- '--(segment|parallel-segments)[[:space:]][^[:space:]]*app-update-baseline' \
  "$wework_app_workflow"; then
  printf 'The formal release workflow must invoke app-update-baseline\n' >&2
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

collaboration_package=$(
  cat <<'EOF'
backend=false
executor=false
executor_manager=false
shared=false
knowledge_engine=false
frontend=true
wework=true
wegent_cli=false
platform_e2e=true
wework_e2e=true
EOF
)

assert_case \
  "collaboration package" \
  "$collaboration_package" \
  "packages/collaboration/src/CollaborationApp.tsx"

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

assert_desktop_case "official DWS source fixture selects account authentication" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-10","name":"Cloud / shard 10","segments":"plugin-account-auth"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/fixtures/dws-store/main.go"

assert_desktop_case "shared collaboration package selects its desktop checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"collaboration-group-onboarding"},{"id":"core-2","name":"Core / shard 2","segments":"collaboration-first-use,collaboration-local-executor-issue-tools"},{"id":"core-6","name":"Core / shard 6","segments":"collaboration-shared-core,collaboration-issue-comment-mention,collaboration-issue-comment-notification"},{"id":"core-7","name":"Core / shard 7","segments":"collaboration-agent-automation-chain"},{"id":"core-11","name":"Core / shard 11","segments":"collaboration-local-agent-capabilities"},{"id":"core-12","name":"Core / shard 12","segments":"collaboration-settings-matrix"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "packages/collaboration/src/CollaborationApp.tsx"

assert_desktop_case "issue comment mention scenario selects its own checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"collaboration-issue-comment-mention"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-issue-comment-mention.scenario.mjs"

assert_desktop_case "collaboration execution environment changes select onboarding and lifecycle coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"collaboration-group-onboarding"},{"id":"core-2","name":"Core / shard 2","segments":"collaboration-first-use,collaboration-local-executor-issue-tools"},{"id":"core-6","name":"Core / shard 6","segments":"collaboration-shared-core"},{"id":"core-7","name":"Core / shard 7","segments":"collaboration-agent-automation-chain"},{"id":"core-11","name":"Core / shard 11","segments":"collaboration-local-agent-capabilities"},{"id":"core-12","name":"Core / shard 12","segments":"collaboration-settings-matrix,remote-device-onboarding"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-4","name":"Cloud / shard 4","segments":"cloud-device-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "packages/collaboration/src/platform/WorkspaceResourceConfiguration.tsx" \
  "packages/collaboration/src/project-agent-config/ProjectAgentConfiguration.tsx" \
  "packages/collaboration/src/http-api/createSharedWorkspaceHttpApi.ts" \
  "packages/collaboration/src/ports/SharedWorkspaceApi.ts" \
  "packages/collaboration/src/dto-mappers/workspaceDtoMappers.ts"

assert_desktop_case "Creator resources select desktop and cloud delivery" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-5","name":"Cloud / shard 5","segments":"plugin-workspace-publication"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins-plugin-marketplace-lifecycle","name":"Plugins / plugin-marketplace-lifecycle","command":"e2e:desktop:plugins","segment":"plugin-marketplace-lifecycle"}]}
wework_desktop_macos_inspector_e2e=false' \
  "sdk/plugin-creator/SKILL.md"
for terminal_path in \
  wework/e2e/desktop/modules/terminal-compatibility-flows.mjs \
  backend/app/api/ws/terminal_namespace.py \
  backend/app/services/device/terminal_protocol.py \
  backend/app/services/device/terminal_session_record.py \
  backend/app/services/device/terminal_session_service.py; do
  assert_desktop_case "terminal compatibility is included in cloud core-task-flow: $terminal_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"core-task-flow"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$terminal_path"
done

assert_desktop_case "conversation cache selects guidance and conversation segments" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"core-task-flow"},{"id":"core-10","name":"Core / shard 10","segments":"conversation-state"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/features/workbench/runtimeConversationCache.ts"

assert_desktop_case "independent features select the union of minimum segments" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"rendering-extensions"},{"id":"core-4","name":"Core / shard 4","segments":"goal-lifecycle"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/lib/runtime-goal.ts" \
  "wework/src/components/chat/blocks/ToolBlockItem.tsx"

assert_desktop_case "runner coverage does not broaden a classified feature" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"rendering-extensions"},{"id":"core-10","name":"Core / shard 10","segments":"conversation-state"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/task-flow.e2e.mjs" \
  "wework/src/components/chat/MessageList.tsx"

assert_desktop_case "turn lifecycle changes select supervisor and resilience coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"supervisor-lifecycle"},{"id":"core-7","name":"Core / shard 7","segments":"resilience"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/features/workbench/runtimeTaskLifecycle/reducer.ts"

assert_desktop_case "runtime pane events select supervisor and conversation coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"supervisor-lifecycle"},{"id":"core-10","name":"Core / shard 10","segments":"conversation-state"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/features/workbench/runtimePaneMessages.ts"

assert_desktop_case "temporary chat files select temporary chat coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-10","name":"Core / shard 10","segments":"temporary-chat"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/components/layout/workspace-panels/TemporaryChatPanel.tsx"

assert_desktop_case "shared right workspace panel selects plugin development and temporary chat" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-10","name":"Core / shard 10","segments":"temporary-chat"},{"id":"core-13","name":"Core / shard 13","segments":"plugin-development"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/components/layout/workspace-panels/RightWorkspacePanel.tsx"

assert_desktop_case "main workbench changes select fixed environment panel coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"environment-panel-scroll"},{"id":"core-9","name":"Core / shard 9","segments":"cloud-context-resilience"},{"id":"core-10","name":"Core / shard 10","segments":"temporary-chat"},{"id":"core-13","name":"Core / shard 13","segments":"task-board-association"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/components/layout/DesktopWorkbenchMain.tsx"

assert_desktop_case "main workbench layout test selects fixed environment panel coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"environment-panel-scroll"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/components/layout/DesktopWorkbenchLayout.test.tsx"

assert_desktop_case "startup splash selects native startup coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"native-window-startup"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/electron/src/host/startup-splash.ts" \
  "wework/electron/src/shell/startup-splash/styles.css"

assert_desktop_case "Wework documentation skips desktop E2E" \
  'wework_desktop_e2e=false
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/README.md"

full_desktop_expected='wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-full-1","name":"Core / full lane 1","segments":"rendering-extensions,embedded-browser,workspace-tabs,collaboration-group-onboarding,environment-panel-scroll,local-file-preview,renderer-storage,collaboration-shared-core,board-focus-view,codex-invalid-launch-cwd,collaboration-issue-comment-mention,collaboration-issue-comment-notification,workspace-attachments,cloud-login-proxy,native-window-chrome,project-automation,fork-provider-preservation,collaboration-local-agent-capabilities","parallel":8},{"id":"core-full-2","name":"Core / full lane 2","segments":"task-status-sync,change-request-status,collaboration-first-use,executor-stream-recovery,running-conversation-history,supervisor-lifecycle,collaboration-local-executor-issue-tools,collaboration-agent-automation-chain,component-update,native-window-startup,resilience,browser-toolbar-actions,collaboration-settings-matrix,core-dsh-plugin-management,permission-modes,remote-device-onboarding,browser-annotation-design,send-key-preference","parallel":8},{"id":"core-full-3","name":"Core / full lane 3","segments":"window-lifecycle,workbench-mode,harness-apps,codex-account-login,project-ai-settings,priority-filter,system-pac,release-package-startup,project-event-sources,computer-use,running-plan-history,task-board-association,task-board-bulk-actions,context-compaction,system-proxy,transcript-sync,task-attachments,plugin-development","parallel":8},{"id":"core-full-4","name":"Core / full lane 4","segments":"core-task-flow,goal-lifecycle,codex-notification-isolation,offline-local-project-space,local-harness,runtime-task-queue,cloud-context-resilience,external-content-import,project-assignment-notification,cloud-space-mention","parallel":8},{"id":"core-full-5","name":"Core / full lane 5","segments":"model-routing,tray-lifecycle,split-workbench,automation-lifecycle,browser-annotation-core,claude-runtime,temporary-chat,browser-annotation-anchors,conversation-state,dsh-owner-capture","parallel":8}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-full-1","name":"Cloud / full lane 1","segments":"plugin-auto-update,automation-lifecycle,cloud-worktree-capability,cloud-project-creation,cloud-worktree-archive-restore,plugin-workspace-publication,project-automation,supervisor-lifecycle,priority-filter,rendering-extensions,goal-lifecycle,cloud-worktree-tools,browser-multi-tabs,resilience","parallel":8},{"id":"cloud-full-2","name":"Cloud / full lane 2","segments":"core-task-flow,cloud-worktree-create,cloud-device-lifecycle,cloud-worktree-queued-cancel,workspace-tabs,telemetry-consent,workspace-attachments,embedded-browser,window-lifecycle,conversation-state,plugin-account-auth,model-routing","parallel":8}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":""}]}
wework_desktop_macos_inspector_e2e=true'

assert_desktop_case "runner-only changes retain full coverage" \
  "$full_desktop_expected" \
  "wework/e2e/desktop/task-flow.e2e.mjs"

assert_desktop_case "collaboration executor runtime changes retain full coverage including the automation chain" \
  "$full_desktop_expected" \
  "executor/src/runtime_work/handler/claude_turns.rs"

assert_desktop_case "workbench mode changes select their desktop regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"workbench-mode"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/workbench-mode.scenario.mjs" \
  "wework/electron/src/runtime/workbench-mode.ts" \
  "wework/src/features/workbench-mode/workbenchMode.ts"

assert_desktop_case "Codex account login scenario selects its desktop regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"codex-account-login"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/codex-account-login.scenario.mjs"

assert_desktop_case "board focus view changes select their desktop regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"board-focus-view"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/board-focus-view.scenario.mjs"

assert_desktop_case "external content import changes select its desktop regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-9","name":"Core / shard 9","segments":"external-content-import"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "executor/src/local/codex_home.rs" \
  "wework/e2e/desktop/scenarios/external-content-import.scenario.mjs"

assert_desktop_case "embedded browser files select browser coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"embedded-browser"},{"id":"core-5","name":"Core / shard 5","segments":"browser-annotation-core"},{"id":"core-7","name":"Core / shard 7","segments":"browser-toolbar-actions"},{"id":"core-10","name":"Core / shard 10","segments":"browser-annotation-anchors"},{"id":"core-12","name":"Core / shard 12","segments":"browser-annotation-design"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=true' \
  "wework/src/lib/browser-url.ts"

assert_desktop_case "browser toolbar scenario is invoked by Core and macOS CI" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"embedded-browser"},{"id":"core-5","name":"Core / shard 5","segments":"browser-annotation-core"},{"id":"core-7","name":"Core / shard 7","segments":"browser-toolbar-actions"},{"id":"core-10","name":"Core / shard 10","segments":"browser-annotation-anchors"},{"id":"core-12","name":"Core / shard 12","segments":"browser-annotation-design"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=true' \
  "wework/e2e/desktop/scenarios/embedded-browser-toolbar-actions.scenario.mjs"

assert_desktop_case "native tray files select Core and macOS restart coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"tray-lifecycle"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=true' \
  "wework/electron/src/host/tray-manager.ts" \
  "wework/e2e/desktop/scenarios/tray-position.mjs"

assert_desktop_case "local harness files select local harness coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-9","name":"Core / shard 9","segments":"local-harness"},{"id":"core-10","name":"Core / shard 10","segments":"claude-runtime"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/lib/local-harness.ts"

assert_desktop_case "Claude runtime messaging selects task and Claude coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"core-task-flow"},{"id":"core-8","name":"Core / shard 8","segments":"project-ai-settings"},{"id":"core-10","name":"Core / shard 10","segments":"claude-runtime"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"cloud-worktree-create"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"cloud-worktree-capability,cloud-worktree-archive-restore"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"cloud-worktree-queued-cancel"},{"id":"cloud-9","name":"Cloud / shard 9","segments":"cloud-worktree-tools"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/features/workbench/useWorkbenchRuntimeMessaging.ts"

assert_desktop_case "local file preview files select the shared preview checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"local-file-preview"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/components/layout/workspace-panels/WorkspaceFilePreview.tsx"

assert_desktop_case "Core artifact changes retain full coverage" \
  "$full_desktop_expected" \
  ".github/scripts/archive-wework-core-e2e-build.sh"

assert_desktop_case "skill mention files select plugin and core coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"core-task-flow"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins-skill-mention-rendering","name":"Plugins / skill-mention-rendering","command":"e2e:desktop:plugins","segment":"skill-mention-rendering"}]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/components/chat/composer/ComposerMentionMenu.tsx"

assert_desktop_case "model settings select task launch and model routing coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"core-task-flow"},{"id":"core-5","name":"Core / shard 5","segments":"model-routing"},{"id":"core-8","name":"Core / shard 8","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/features/model-settings/localModelSettings.ts"

assert_desktop_case "composer plugin files select project plugin coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"core-task-flow"},{"id":"core-5","name":"Core / shard 5","segments":"model-routing"},{"id":"core-8","name":"Core / shard 8","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/components/chat/composer/PluginPickerMenu.tsx"

assert_desktop_case "automation files select only automation lifecycle coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"automation-lifecycle"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/features/automations/AutomationDetailWorkspace.tsx"

assert_desktop_case "project automation files select lifecycle and project coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"automation-lifecycle"},{"id":"core-11","name":"Core / shard 11","segments":"project-automation"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/features/todo/ProjectAutomationRulesSection.tsx"

assert_desktop_case "project automation E2E changes select core and cloud coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"automation-lifecycle"},{"id":"core-11","name":"Core / shard 11","segments":"project-automation"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-auto-update,automation-lifecycle"},{"id":"cloud-2","name":"Cloud / shard 2","segments":"core-task-flow,cloud-worktree-create"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"cloud-worktree-capability,cloud-project-creation,cloud-worktree-archive-restore"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"cloud-device-lifecycle,cloud-worktree-queued-cancel,workspace-tabs"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"plugin-workspace-publication,project-automation,supervisor-lifecycle"},{"id":"cloud-6","name":"Cloud / shard 6","segments":"telemetry-consent,workspace-attachments,embedded-browser"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"priority-filter,rendering-extensions,goal-lifecycle"},{"id":"cloud-8","name":"Cloud / shard 8","segments":"window-lifecycle,conversation-state"},{"id":"cloud-9","name":"Cloud / shard 9","segments":"cloud-worktree-tools,browser-multi-tabs,resilience"},{"id":"cloud-10","name":"Cloud / shard 10","segments":"plugin-account-auth,model-routing"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/project-automation.scenario.mjs"

assert_desktop_case "collaboration automation chain scenario selects its core shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"collaboration-agent-automation-chain"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/collaboration-agent-automation-chain.scenario.mjs"

assert_desktop_case "collaboration first-use scenario selects its core shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"collaboration-first-use"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/collaboration-first-use.scenario.mjs"

assert_desktop_case "collaboration group onboarding scenario selects its core shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"collaboration-group-onboarding"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/collaboration-group-onboarding.scenario.mjs"

assert_desktop_case "collaboration local agent capabilities scenario selects its core shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-11","name":"Core / shard 11","segments":"collaboration-local-agent-capabilities"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/collaboration-local-agent-capabilities.scenario.mjs"

assert_desktop_case "collaboration local executor Issue tools scenario selects its core shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"collaboration-local-executor-issue-tools"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/collaboration-local-executor-issue-tools.scenario.mjs"

assert_desktop_case "collaboration settings matrix scenario selects its core shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-12","name":"Core / shard 12","segments":"collaboration-settings-matrix"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/collaboration-settings-matrix.scenario.mjs"

assert_desktop_case "collaboration backend automation changes select the agent automation chain" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-7","name":"Core / shard 7","segments":"collaboration-agent-automation-chain"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "backend/app/services/project_automation_execution.py"

assert_desktop_case "project assignment notification E2E changes select assignment coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-9","name":"Core / shard 9","segments":"project-assignment-notification"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/project-assignment-notification.scenario.mjs"

assert_desktop_case "browser E2E changes avoid desktop jobs" \
  'wework_desktop_e2e=false
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/tests/workbench.spec.ts"

assert_desktop_case "cloud files select only the cloud suite" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-auto-update,automation-lifecycle"},{"id":"cloud-2","name":"Cloud / shard 2","segments":"core-task-flow,cloud-worktree-create"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"cloud-worktree-capability,cloud-project-creation,cloud-worktree-archive-restore"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"cloud-device-lifecycle,cloud-worktree-queued-cancel,workspace-tabs"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"plugin-workspace-publication,project-automation,supervisor-lifecycle"},{"id":"cloud-6","name":"Cloud / shard 6","segments":"telemetry-consent,workspace-attachments,embedded-browser"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"priority-filter,rendering-extensions,goal-lifecycle"},{"id":"cloud-8","name":"Cloud / shard 8","segments":"window-lifecycle,conversation-state"},{"id":"cloud-9","name":"Cloud / shard 9","segments":"cloud-worktree-tools,browser-multi-tabs,resilience"},{"id":"cloud-10","name":"Cloud / shard 10","segments":"plugin-account-auth,model-routing"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/features/cloud-connection/CloudConnectionProvider.tsx"

assert_desktop_case "cloud device lifecycle files select managed restart coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-4","name":"Cloud / shard 4","segments":"cloud-device-lifecycle"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/components/settings/ConnectionsSettingsPage.tsx" \
  "wework/src/components/settings/DeviceVersionBadge.tsx" \
  "wework/src/features/cloud-devices/useDeviceOfflineLifecycleAction.ts" \
  "wework/e2e/desktop/modules/cloud-device-lifecycle-flow.mjs"

assert_desktop_case "worktree UI changes select local launch and cloud lifecycle coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"core-task-flow"},{"id":"core-11","name":"Core / shard 11","segments":"workspace-attachments"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"cloud-worktree-create"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"cloud-worktree-capability,cloud-worktree-archive-restore"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"cloud-worktree-queued-cancel"},{"id":"cloud-9","name":"Cloud / shard 9","segments":"cloud-worktree-tools"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/lib/worktree-availability.ts"

assert_desktop_case "task status projection changes select status synchronization coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"task-status-sync"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/features/workbench/projectTaskTracking.ts"

assert_desktop_case "workbench context changes select send shortcut coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"task-status-sync"},{"id":"core-12","name":"Core / shard 12","segments":"send-key-preference"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/features/workbench/workbenchContextTypes.ts"

assert_desktop_case "workbench provider changes select send shortcut coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"core-task-flow"},{"id":"core-8","name":"Core / shard 8","segments":"project-ai-settings"},{"id":"core-11","name":"Core / shard 11","segments":"workspace-attachments"},{"id":"core-12","name":"Core / shard 12","segments":"send-key-preference"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"cloud-worktree-create"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"cloud-worktree-capability,cloud-worktree-archive-restore"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"cloud-worktree-queued-cancel"},{"id":"cloud-9","name":"Cloud / shard 9","segments":"cloud-worktree-tools"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/features/workbench/WorkbenchProvider.tsx"

assert_desktop_case "workbench cloud context changes select non-blocking composer coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"task-status-sync"},{"id":"core-9","name":"Core / shard 9","segments":"cloud-context-resilience"},{"id":"core-13","name":"Core / shard 13","segments":"task-board-association"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/components/layout/useWorkbenchCloudProjectContext.ts"

assert_desktop_case "task board association UI changes select dedicated coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"task-status-sync"},{"id":"core-13","name":"Core / shard 13","segments":"task-board-association"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/features/todo/TaskBoardAssociationDialog.tsx"

assert_desktop_case "task board bulk action changes select dedicated coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-13","name":"Core / shard 13","segments":"task-board-bulk-actions"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/features/todo/TaskBoardView.tsx" \
  "wework/src/features/workbench/runtimeTaskArchive.ts" \
  "wework/e2e/desktop/scenarios/task-board-bulk-actions.scenario.mjs"

assert_desktop_case "backend runtime Worktree changes select the cloud lifecycle checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"cloud-worktree-create"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"cloud-worktree-capability,cloud-worktree-archive-restore"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"cloud-worktree-queued-cancel"},{"id":"cloud-9","name":"Cloud / shard 9","segments":"cloud-worktree-tools"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "backend/app/services/device/runtime_route.py"

assert_desktop_case "runtime task queue scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-9","name":"Core / shard 9","segments":"runtime-task-queue"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/runtime-task-queue.scenario.mjs"

assert_desktop_case "send key preference scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-12","name":"Core / shard 12","segments":"send-key-preference"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/send-key-preference.scenario.mjs"

assert_desktop_case "system proxy scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-8","name":"Core / shard 8","segments":"system-pac"},{"id":"core-13","name":"Core / shard 13","segments":"system-proxy"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/system-pac.scenario.mjs" \
  "wework/e2e/desktop/scenarios/system-proxy.scenario.mjs" \
  "wework/electron/src/host/system-proxy.ts" \
  "wework/src/components/settings/ProxySettingsPage.tsx" \
  "wework/src/desktop/systemProxy.ts"

assert_desktop_case "cloud sign-in proxy scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-11","name":"Core / shard 11","segments":"cloud-login-proxy"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/cloud-login-proxy.scenario.mjs" \
  "wework/e2e/desktop/modules/cloud-login-proxy-fixtures.mjs" \
  "wework/electron/src/host/cloud-http.ts" \
  "wework/electron/src/host/cloud-credential-service.ts"

assert_desktop_case "Codex notification isolation scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"codex-notification-isolation"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/codex-notification-isolation.scenario.mjs"

assert_desktop_case "executor stream recovery scenario is invoked by the core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"executor-stream-recovery"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/executor-stream-recovery.scenario.mjs"

assert_desktop_case "transcript sync files invoke the multi-device desktop regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-13","name":"Core / shard 13","segments":"transcript-sync"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "backend/app/services/wework_transcript_service.py" \
  "executor/src/runtime_work/native_transcript.rs" \
  "executor/src/runtime_work/handler/transcript_sync.rs" \
  "wework/dsh/transcript-sync/index.js" \
  "wework/e2e/desktop/scenarios/transcript-sync.scenario.mjs"

assert_desktop_case "Codex rollout paging invokes transcript and environment regressions" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"environment-panel-scroll"},{"id":"core-13","name":"Core / shard 13","segments":"transcript-sync"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "executor/src/runtime_work/codex_transcript_page.rs"

assert_desktop_case "plugin files select plugin lifecycle and project plugin coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-8","name":"Core / shard 8","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins-plugin-lifecycle","name":"Plugins / plugin-lifecycle","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/components/plugins/PluginsWorkspace.tsx"

assert_desktop_case "Core DSH plugin files select their desktop checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-12","name":"Core / shard 12","segments":"core-dsh-plugin-management"},{"id":"core-13","name":"Core / shard 13","segments":"plugin-development"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/electron/src/runtime/core-dsh-plugin-manager.ts"

assert_desktop_case "plugin development files select the full desktop workflow" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-13","name":"Core / shard 13","segments":"plugin-development"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/electron/src/runtime/plugin-development-manager.ts"

assert_desktop_case "DSH UI plugin files select composition coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins-core-dsh-ui-plugin-composition","name":"Plugins / core-dsh-ui-plugin-composition","command":"e2e:desktop:plugins","segment":"core-dsh-ui-plugin-composition"}]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/dsh/ui-applications/client.js"

assert_desktop_case "Wework plugin developer Demo selects development and composition coverage" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-13","name":"Core / shard 13","segments":"plugin-development"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins-core-dsh-ui-plugin-composition","name":"Plugins / core-dsh-ui-plugin-composition","command":"e2e:desktop:plugins","segment":"core-dsh-ui-plugin-composition"}]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/dsh/plugin-developer/codex-plugin/skills/develop-wework-plugin/assets/ui-extension-demo/client.js"

assert_desktop_case "desktop sidebar selects all owned checkpoints" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"core-task-flow"},{"id":"core-8","name":"Core / shard 8","segments":"project-ai-settings,priority-filter"},{"id":"core-11","name":"Core / shard 11","segments":"workspace-attachments"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/src/components/layout/DesktopSidebar.tsx"

assert_desktop_case "priority section selects only its dedicated checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-8","name":"Core / shard 8","segments":"priority-filter"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
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
    "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'" \
    "$workflow_path"; then
    printf '%s must reserve full E2E for scheduled, dispatched, or ci:all runs\n' \
      "$workflow" >&2
    exit 1
  fi
done

platform_e2e_workflow="$script_dir/../workflows/e2e-tests.yml"
provider_native_step="$(
  extract_named_workflow_step \
    "$platform_e2e_workflow" \
    "Run Provider-native E2E tests"
)"
if grep -Fq "if: matrix.shardIndex ==" <<<"$provider_native_step" ||
  ! grep -Fq -- \
    '--shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }}' \
    <<<"$provider_native_step"; then
  printf 'Provider-native E2E must use every existing platform shard\n' >&2
  exit 1
fi

for workflow in test.yml lint.yml; do
  workflow_path="$script_dir/../workflows/$workflow"
  if ! grep -q "merge_group:" "$workflow_path"; then
    printf '%s must publish its required summary in merge groups\n' "$workflow" >&2
    exit 1
  fi
  if ! grep -Fq "if: github.event_name != 'merge_group'" "$workflow_path" ||
    ! grep -Fq "if: github.event_name == 'merge_group'" "$workflow_path" ||
    ! grep -Fq "name: Confirm E2E-only merge queue" "$workflow_path"; then
    printf '%s must replace module checks with one summary in merge groups\n' \
      "$workflow" >&2
    exit 1
  fi
  if ! grep -Fq "ci:all" "$workflow_path"; then
    printf '%s must keep full regression available through ci:all\n' "$workflow" >&2
    exit 1
  fi
done

plugin_auth_workflow="$script_dir/../workflows/plugin-auth-sdk.yml"
if workflow_has_top_level_trigger "$plugin_auth_workflow" "push"; then
  printf 'plugin-auth-sdk.yml must not repeat merge queue validation after entering main\n' >&2
  exit 1
fi
if workflow_has_top_level_trigger "$plugin_auth_workflow" "merge_group"; then
  printf 'plugin-auth-sdk.yml must not run in the merge queue\n' >&2
  exit 1
fi
plugin_auth_gated_job_count="$(
  grep -Fc "if: needs.changes.outputs.plugin_auth_sdk == 'true'" \
    "$plugin_auth_workflow"
)"
if ! grep -Fq "ci:all" "$plugin_auth_workflow" ||
  [[ "$plugin_auth_gated_job_count" -ne 3 ]]; then
  printf 'plugin-auth-sdk.yml must be path-scoped and full under ci:all\n' >&2
  exit 1
fi

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

collaboration_frontend_setup_step="$(
  extract_named_workflow_step_from_job \
    "$wework_workflow" \
    "  wework-desktop-core-e2e:" \
    "  build-wework-desktop-windows-core-e2e:" \
    "Set up Collaboration frontend"
)"
if ! grep -Fq \
  "contains(matrix.segments, 'collaboration-settings-matrix')" \
  <<<"$collaboration_frontend_setup_step" ||
  ! grep -Fq 'uses: ./.github/actions/setup-node-workspace' \
    <<<"$collaboration_frontend_setup_step" ||
  ! grep -Fq 'setup-toolchain: "false"' \
    <<<"$collaboration_frontend_setup_step"; then
  printf 'Shared Collaboration Core E2E must restore frontend dependencies only on its owning shard\n' >&2
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
  [[ "$core_build_job" != *"resources/bin/wegent-executor"* ]] ||
  [[ "$core_build_job" == *'CARGO_PROFILE_DEV_DEBUG: "0"'* ]]; then
  printf 'The shared desktop E2E artifact must be built from the Electron package\n' >&2
  exit 1
fi

if [[ "$desktop_other_job" != *"uses: actions/download-artifact@v4"* ]] ||
  [[ "$desktop_other_job" != *"build-wework-desktop-core-e2e"* ]] ||
  [[ "$desktop_other_job" != *"electron-app/WeWork"* ]] ||
  [[ "$desktop_other_job" != *"electron-app/resources/bin/wegent-executor"* ]]; then
  printf 'Non-Core desktop E2E must wait for and download the shared Electron package\n' >&2
  exit 1
fi

for desktop_job_start in \
  "  wework-desktop-core-e2e:" \
  "  wework-desktop-cloud-e2e:"; do
  desktop_job="$(
    case "$desktop_job_start" in
      "  wework-desktop-core-e2e:")
        sed -n '/^  wework-desktop-core-e2e:/,/^  build-wework-desktop-windows-core-e2e:/p' \
          "$wework_workflow"
        ;;
      *)
        sed -n '/^  wework-desktop-cloud-e2e:/,/^  wework-desktop-e2e:/p' \
          "$wework_workflow"
        ;;
    esac
  )"
  if [[ "$desktop_job" != *"uses: actions/download-artifact@v4"* ]] ||
    [[ "$desktop_job" != *"build-wework-desktop-core-e2e"* ]]; then
    printf 'Desktop E2E shards must start after the shared build is ready\n' >&2
    exit 1
  fi
done

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
if ! grep -Fq '${{ runner.os }}-wework-electron-e2e-v2-' \
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
  [[ "$wework_desktop_cloud_job" != *"max-parallel: 10"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"--parallel-segments"* ]] ||
  [[ "$wework_desktop_cloud_job" != *'WEWORK_E2E_PARALLEL_CHECKPOINTS: ${{ matrix.parallel || 3 }}'* ]] ||
  [[ "$wework_desktop_cloud_job" != *'WEWORK_E2E_ISOLATED_XVFB: "true"'* ]] ||
  [[ "$wework_desktop_cloud_job" != *"compression-level: 6"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"name: Download shared Wework desktop E2E build"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"uses: actions/download-artifact@v4"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"WEWORK_E2E_APP_BIN:"* ]] ||
  [[ "$wework_desktop_cloud_job" != *"WEWORK_E2E_EXECUTOR_BIN:"* ]]; then
  printf 'Wework Cloud desktop E2E must use prebuilt dynamically sized lanes\n' >&2
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
  [[ "$wework_desktop_core_job" != *"max-parallel: 13"* ]] ||
  [[ "$wework_desktop_core_job" != *'WEWORK_E2E_PARALLEL_CHECKPOINTS: ${{ matrix.parallel || 3 }}'* ]] ||
  [[ "$wework_desktop_core_job" != *"WEWORK_E2E_SCREENSHOTS:"* ]] ||
  [[ "$wework_desktop_core_job" == *"name: Set up Node workspace"* ]] ||
  [[ "$wework_desktop_core_job" != *"compression-level: 6"* ]]; then
  printf 'Wework Core desktop E2E must use prebuilt dynamically sized lanes\n' >&2
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

managed_components_exclusion='!wework/test-results/desktop-e2e/**/managed-components/**'
if [[ "$(grep -Fc "$managed_components_exclusion" "$wework_workflow")" -ne 7 ]] ||
  [[ "$(grep -Fc "$managed_components_exclusion" \
    "$script_dir/../workflows/wework-app.yml")" -ne 1 ]]; then
  printf 'Every Wework desktop diagnostics upload must exclude materialized components\n' >&2
  exit 1
fi

test_archive_exclusion='!wework/test-results/desktop-e2e/**/*.zip'
if [[ "$(grep -Fc "$test_archive_exclusion" "$wework_workflow")" -ne 7 ]] ||
  [[ "$(grep -Fc "$test_archive_exclusion" \
    "$script_dir/../workflows/wework-app.yml")" -ne 1 ]]; then
  printf 'Every Wework desktop diagnostics upload must exclude test archives\n' >&2
  exit 1
fi

if [[ "$(grep -Fc 'compression-level: 6' "$wework_workflow")" -ne 7 ]] ||
  [[ "$(grep -Fc 'compression-level: 6' \
    "$script_dir/../workflows/wework-app.yml")" -ne 1 ]]; then
  printf 'Every Wework desktop diagnostics upload must compress retained evidence\n' >&2
  exit 1
fi

for generated_path_exclusion in \
  '!wework/test-results/desktop-e2e/**/managed-runtimes/**' \
  '!wework/test-results/desktop-e2e/**/dsh-core/profiles/**' \
  '!wework/test-results/desktop-e2e/**/harness-apps/instances/**/profiles/**' \
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

for collaboration_checkpoint in \
  collaboration-shared-core \
  collaboration-settings-matrix \
  collaboration-issue-comment-notification; do
  if ! grep -Fq \
    "['$collaboration_checkpoint', 'collaboration-runtime']" \
    "$desktop_checkpoint_runner"; then
    printf 'Shared Collaboration checkpoints must serialize their cloud runtime\n' >&2
    exit 1
  fi
done

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
  [[ "$wework_memory_job" != *'CARGO_PROFILE_DEV_DEBUG: "0"'* ]] ||
  [[ "$wework_memory_job" != *"contains(github.event.pull_request.labels.*.name, 'ci:memory')"* ]] ||
  [[ "$wework_memory_job" != *"'release' || 'debug'"* ]] ||
  [[ "$wework_memory_job" == *"--offline"* ]]; then
  printf 'Wework macOS E2E must keep memory builds representative without slowing Inspector-only runs\n' >&2
  exit 1
fi

printf 'CI change classifier tests passed\n'
