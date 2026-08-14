#!/usr/bin/env bash

set -euo pipefail

core_segments=(
  workspace-tabs
  priority-filter
  automation-lifecycle
  project-automation
  model-routing
  permission-modes
  core-task-flow
  window-lifecycle
  goal-lifecycle
  supervisor-lifecycle
  resilience
  conversation-state
  temporary-chat
  workspace-attachments
  rendering-extensions
  claude-runtime
  local-file-preview
  local-harness
  embedded-browser
)
plugin_segments=(
  plugin-lifecycle
  skill-mention-rendering
  sites-plugin-auto-install
)
# Group checkpoints by observed Cloud CI duration and order each shard from
# longest to shortest so the five serial workers finish at similar times.
# shellcheck disable=SC2054 # Each element is one comma-joined shard.
cloud_shards=(
  core-task-flow
  model-routing,embedded-browser,telemetry-consent
  window-lifecycle,conversation-state,browser-multi-tabs
  resilience,goal-lifecycle,supervisor-lifecycle
  rendering-extensions,workspace-attachments,workspace-tabs,priority-filter,automation-lifecycle,project-automation,plugin-auto-update
)
# Keep the number of core desktop runners fixed as checkpoints grow. Each
# runner reuses the same prebuilt application and executes its shard serially.
# shellcheck disable=SC2054 # Each element is one comma-joined shard.
core_shards=(
  core-task-flow
  model-routing,embedded-browser,claude-runtime,local-harness
  window-lifecycle,conversation-state,temporary-chat
  resilience,goal-lifecycle,supervisor-lifecycle
  rendering-extensions,workspace-attachments,workspace-tabs,priority-filter,automation-lifecycle,project-automation,permission-modes,local-file-preview
)

validate_core_shards() {
  declare -A known_segments=()
  declare -A assigned_segments=()
  local segment
  for segment in "${core_segments[@]}"; do
    if [[ -n "${known_segments[$segment]+set}" ]]; then
      printf 'Duplicate core segment in catalog: %s\n' "$segment" >&2
      return 1
    fi
    known_segments["$segment"]=true
  done

  local shard
  for shard in "${core_shards[@]}"; do
    local shard_segments
    IFS=',' read -ra shard_segments <<< "$shard"
    for segment in "${shard_segments[@]}"; do
      if [[ -z "${known_segments[$segment]+set}" ]]; then
        printf 'Unknown core segment in core_shards: %s\n' "$segment" >&2
        return 1
      fi
      if [[ -n "${assigned_segments[$segment]+set}" ]]; then
        printf 'Duplicate core segment in core_shards: %s\n' "$segment" >&2
        return 1
      fi
      assigned_segments["$segment"]=true
    done
  done

  for segment in "${core_segments[@]}"; do
    if [[ -z "${assigned_segments[$segment]+set}" ]]; then
      printf 'Core segment missing from core_shards: %s\n' "$segment" >&2
      return 1
    fi
  done
}

validate_core_shards

declare -A selected=()
desktop_runner_changed=false

select_target() {
  selected["$1"]=true
}

select_all_desktop_suites() {
  select_target "core:all"
  select_target "plugins:all"
  select_target "cloud:all"
}

classify_wework_path() {
  local path="$1"

  case "$path" in
    # Browser-runner changes do not require a real desktop application.
    wework/e2e/tests/* | \
      wework/e2e/fixtures/* | \
      wework/playwright.config.ts)
      return
      ;;
    wework/e2e/desktop/task-flow.e2e.mjs)
      desktop_runner_changed=true
      return
      ;;

    # Plugin features have independently bootstrapped desktop segments.
    wework/src/components/plugins/* | \
      wework/src/features/plugins/* | \
      wework/src/pages/Plugin*)
      select_target "plugins:plugin-lifecycle"
      return
      ;;
    wework/src/components/sites/* | \
      wework/src/pages/SitesPage.tsx)
      select_target "plugins:sites-plugin-auto-install"
      return
      ;;
    wework/src/features/workbench/useWorkbenchSkills.ts | \
      wework/src/components/chat/composer/ComposerMentionMenu.tsx | \
      wework/src/components/chat/composer/composerMentionCandidates*)
      select_target "plugins:skill-mention-rendering"
      select_target "core:core-task-flow"
      return
      ;;

    # Cloud execution has a separate backend/executor-backed desktop suite.
    wework/src/api/cloud/* | \
      wework/src/features/cloud-connection/* | \
      wework/src/lib/cloud-authorization-window* | \
      wework/src/extensions/cloud-desktop*)
      select_target "cloud:all"
      return
      ;;

    # Window and native lifecycle behavior.
    wework/src/tauri/tray* | \
      wework/src/tauri/runtimeTaskCloseGuard* | \
      wework/src/components/layout/WindowFrameControls* | \
      wework/src/components/layout/DesktopWindowsTitlebar.tsx)
      select_target "core:window-lifecycle"
      return
      ;;

    # Goal creation, idle continuation, and restart recovery.
    wework/src/lib/runtime-goal* | \
      wework/src/components/chat/composer/Goal* | \
      wework/src/features/workbench/runtimeTaskReminders*)
      select_target "core:goal-lifecycle"
      return
      ;;

    # The extracted priority section has its own runtime-task fixture.
    wework/src/components/layout/DesktopSidebarPrioritySection.tsx)
      select_target "core:priority-filter"
      return
      ;;
    wework/src/features/todo/ProjectAutomation* | \
      wework/src/features/todo/projectAutomationForm* | \
      wework/src/api/projectAutomations* | \
      wework/e2e/desktop/scenarios/project-automation.scenario.mjs)
      select_target "core:automation-lifecycle"
      select_target "core:project-automation"
      return
      ;;
    wework/src/pages/AutomationsPage* | \
      wework/src/features/automations/* | \
      wework/src/types/automation.ts)
      select_target "core:automation-lifecycle"
      return
      ;;
    # The main sidebar also owns project creation, chats, and attachments.
    wework/src/components/layout/DesktopSidebar.tsx)
      select_target "core:priority-filter"
      select_target "core:core-task-flow"
      select_target "core:workspace-attachments"
      return
      ;;

    # Queueing, cancellation, retry, rate-limit, and reconnect behavior.
    wework/src/components/chat/ConversationQueuePanel* | \
      wework/src/lib/chat-error*)
      select_target "core:resilience"
      return
      ;;
    wework/src/features/workbench/runtimeTaskLifecycle/*)
      select_target "core:supervisor-lifecycle"
      select_target "core:resilience"
      return
      ;;

    # Conversation cache changes also affect background guidance in the core
    # task flow, while the remaining files are covered by conversation state.
    wework/src/features/workbench/runtimeConversationCache*)
      select_target "core:core-task-flow"
      select_target "core:conversation-state"
      return
      ;;
    wework/src/features/workbench/runtimePaneMessages* | \
      wework/src/components/layout/useWorkbenchPaneSession* | \
      wework/src/components/chat/MessageTurnNavigation* | \
      wework/src/components/chat/ScrollableMessageArea*)
      select_target "core:conversation-state"
      if [[ "$path" == wework/src/features/workbench/runtimePaneMessages* ]]; then
        select_target "core:supervisor-lifecycle"
      fi
      return
      ;;
    wework/src/components/chat/MessageList*)
      select_target "core:conversation-state"
      select_target "core:rendering-extensions"
      return
      ;;

    # Right-workspace temporary chats have an independently bootstrapped
    # ephemeral-thread scenario.
    wework/src/components/layout/DesktopWorkbenchMain.tsx | \
      wework/src/components/layout/workspace-panels/RightWorkspacePanel.tsx | \
      wework/src/components/layout/workspace-panels/TemporaryChatPanel.tsx | \
      wework/e2e/desktop/scenarios/temporary-chat.scenario.mjs)
      select_target "core:temporary-chat"
      return
      ;;

    # Project/worktree creation and composer path or attachment transfer.
    wework/src/api/attachments* | \
      wework/src/api/projects* | \
      wework/src/api/runtimeWork* | \
      wework/src/components/projects/* | \
      wework/src/features/workbench/useWorkbenchAttachments* | \
      wework/src/components/chat/composer/AttachmentBadges* | \
      wework/src/components/chat/composer/WorktreeBranchSelector* | \
      wework/src/components/chat/composer/composerPathTransfer*)
      select_target "core:workspace-attachments"
      return
      ;;

    # The embedded browser has a dedicated agent scenario checkpoint.
    wework/src-tauri/src/embedded_browser* | \
      wework/src/lib/embedded-browser* | \
      wework/src/lib/browser-url* | \
      wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel* | \
      wework/e2e/desktop/scenarios/embedded-browser-agent.scenario.mjs)
      select_target "core:embedded-browser"
      return
      ;;

    # Claude conversations cover both local and remote executor routing.
    wework/src/features/workbench/useWorkbenchRuntimeMessaging*)
      select_target "core:core-task-flow"
      select_target "core:claude-runtime"
      return
      ;;

    # Local PTY-backed coding harnesses have dedicated real-Tauri scenarios.
    wework/src-tauri/src/local_terminal* | \
      wework/src/lib/local-harness* | \
      wework/src/lib/local-terminal* | \
      wework/src/components/layout/CentralHarnessTerminal* | \
      wework/src/components/layout/WorkbenchHarnessSelector* | \
      wework/src/components/layout/localHarnessWorkbench* | \
      wework/src/components/settings/HarnessSettingsPage* | \
      wework/e2e/desktop/scenarios/claude-runtime.scenario.mjs | \
      wework/e2e/desktop/scenarios/local-terminal.scenario.mjs)
      select_target "core:claude-runtime"
      select_target "core:local-harness"
      return
      ;;

    # Local file browsing, preview, editing, and review share one real-Tauri
    # checkpoint so theme and loading regressions are covered together.
    wework/src-tauri/src/local_workspace_files* | \
      wework/src/tauri/localWorkspaceFiles* | \
      wework/src/components/layout/workspace-panels/FileWorkspacePanel* | \
      wework/src/components/layout/workspace-panels/WorkspaceFilePreview* | \
      wework/src/components/layout/workspace-panels/WorkspaceFileTree* | \
      wework/src/components/layout/workspace-panels/WorkspaceTextFileEditor* | \
      wework/src/components/chat/FileChangesReviewPanel* | \
      wework/e2e/desktop/scenarios/local-file-preview.scenario.mjs)
      select_target "core:local-file-preview"
      return
      ;;

    # Assistant/tool rendering and desktop extension surfaces.
    wework/src/components/chat/blocks/* | \
      wework/src/components/chat/AttachmentImagePreview* | \
      wework/src/extensions/desktop* | \
      wework/e2e/desktop/scenarios/*)
      select_target "core:rendering-extensions"
      return
      ;;

    # The main composer, model transport, and task launch path.
    wework/src/components/chat/composer/* | \
      wework/src/features/model-settings/* | \
      wework/src/features/local-runtime/* | \
      wework/src/stream/*)
      select_target "core:core-task-flow"
      select_target "core:model-routing"
      return
      ;;

    # Shared desktop infrastructure can affect every independently registered
    # checkpoint. Keep the fallback explicit instead of guessing one segment.
    wework/*)
      select_all_desktop_suites
      return
      ;;
  esac
}

classify_path() {
  local path="$1"

  case "$path" in
    executor/* | packages/chat-core/* | package.json | pnpm-lock.yaml | pnpm-workspace.yaml)
      select_all_desktop_suites
      ;;
    .github/workflows/wework-e2e.yml | \
      docker/wework-e2e/* | \
      .github/scripts/archive-wework-core-e2e-build.sh | \
      .github/scripts/classify-ci-changes.sh | \
      .github/scripts/classify-wework-desktop-e2e.sh | \
      .github/scripts/restore-wework-core-e2e-build.sh | \
      .github/scripts/test-classify-ci-changes.sh)
      select_all_desktop_suites
      ;;
    wework/*)
      classify_wework_path "$path"
      ;;
  esac
}

append_matrix_entry() {
  local id="$1"
  local name="$2"
  local command="$3"
  local segment="${4:-}"
  local entry

  printf -v entry \
    '{"id":"%s","name":"%s","command":"%s","segment":"%s"}' \
    "$id" "$name" "$command" "$segment"
  if [[ "$command" == "e2e:desktop" ]]; then
    core_matrix_entries+=("$entry")
  else
    other_matrix_entries+=("$entry")
  fi
}

build_matrix() {
  core_matrix_entries=()
  cloud_matrix_entries=()
  other_matrix_entries=()

  local shard_index
  for shard_index in "${!core_shards[@]}"; do
    local selected_segments=()
    local shard_segments
    IFS=',' read -ra shard_segments <<< "${core_shards[$shard_index]}"
    local segment
    for segment in "${shard_segments[@]}"; do
      if [[ "${selected[core:all]:-false}" == "true" || \
        "${selected[core:$segment]:-false}" == "true" ]]; then
        selected_segments+=("$segment")
      fi
    done
    if ((${#selected_segments[@]} > 0)); then
      local joined_segments
      joined_segments="$(IFS=,; printf '%s' "${selected_segments[*]}")"
      local entry
      printf -v entry \
        '{"id":"core-%s","name":"Core / shard %s","segments":"%s"}' \
        "$((shard_index + 1))" "$((shard_index + 1))" "$joined_segments"
      core_matrix_entries+=("$entry")
    fi
  done

  if [[ "${selected[plugins:all]:-false}" == "true" ]]; then
    append_matrix_entry plugins Plugins e2e:desktop:plugins
  else
    for segment in "${plugin_segments[@]}"; do
      if [[ "${selected[plugins:$segment]:-false}" == "true" ]]; then
        append_matrix_entry \
          "plugins-$segment" \
          "Plugins / $segment" \
          e2e:desktop:plugins \
          "$segment"
      fi
    done
  fi

  if [[ "${selected[cloud:all]:-false}" == "true" ]]; then
    local shard
    for shard in "${!cloud_shards[@]}"; do
      local entry
      printf -v entry \
        '{"id":"cloud-%s","name":"Cloud / shard %s","segments":"%s"}' \
        "$((shard + 1))" "$((shard + 1))" "${cloud_shards[$shard]}"
      cloud_matrix_entries+=("$entry")
    done
  fi
}

if [[ "${1:-}" == "--all" ]]; then
  select_all_desktop_suites
elif (($# > 0)); then
  for path in "$@"; do
    classify_path "$path"
  done
else
  while IFS= read -r path; do
    [[ -n "$path" ]] && classify_path "$path"
  done
fi

if [[ "$desktop_runner_changed" == "true" && ${#selected[@]} -eq 0 ]]; then
  select_all_desktop_suites
fi

build_matrix

core_matrix_json='{"include":[]}'
other_matrix_json='{"include":[]}'
run_core=false
run_cloud=false
run_other=false
run_desktop=false
cloud_matrix_json='{"include":[]}'

if ((${#core_matrix_entries[@]} > 0)); then
  joined_core_entries="$(IFS=,; printf '%s' "${core_matrix_entries[*]}")"
  core_matrix_json="{\"include\":[$joined_core_entries]}"
  run_core=true
  run_desktop=true
fi
if ((${#other_matrix_entries[@]} > 0)); then
  joined_other_entries="$(IFS=,; printf '%s' "${other_matrix_entries[*]}")"
  other_matrix_json="{\"include\":[$joined_other_entries]}"
  run_other=true
  run_desktop=true
fi
if ((${#cloud_matrix_entries[@]} > 0)); then
  joined_cloud_entries="$(IFS=,; printf '%s' "${cloud_matrix_entries[*]}")"
  cloud_matrix_json="{\"include\":[$joined_cloud_entries]}"
  run_cloud=true
  run_desktop=true
fi

output_file="${GITHUB_OUTPUT:-/dev/stdout}"
{
  printf 'wework_desktop_e2e=%s\n' "$run_desktop"
  printf 'wework_desktop_core_e2e=%s\n' "$run_core"
  printf 'wework_desktop_core_e2e_matrix=%s\n' "$core_matrix_json"
  printf 'wework_desktop_cloud_e2e=%s\n' "$run_cloud"
  printf 'wework_desktop_cloud_e2e_matrix=%s\n' "$cloud_matrix_json"
  printf 'wework_desktop_other_e2e=%s\n' "$run_other"
  printf 'wework_desktop_other_e2e_matrix=%s\n' "$other_matrix_json"
} >> "$output_file"
