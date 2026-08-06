#!/usr/bin/env bash

set -euo pipefail

core_segments=(
  workspace-tabs
  priority-filter
  core-task-flow
  window-lifecycle
  goal-lifecycle
  supervisor-lifecycle
  resilience
  conversation-state
  workspace-attachments
  rendering-extensions
  embedded-browser
)
plugin_segments=(
  plugin-lifecycle
  skill-mention-rendering
  sites-plugin-auto-install
)

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
  other_matrix_entries=()

  local segment
  for segment in "${core_segments[@]}"; do
    if [[ "${selected[core:all]:-false}" == "true" || \
      "${selected[core:$segment]:-false}" == "true" ]]; then
      append_matrix_entry \
        "core-$segment" \
        "Core / $segment" \
        e2e:desktop \
        "$segment"
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
    append_matrix_entry cloud Cloud e2e:desktop:cloud
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
run_other=false
run_desktop=false

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

output_file="${GITHUB_OUTPUT:-/dev/stdout}"
{
  printf 'wework_desktop_e2e=%s\n' "$run_desktop"
  printf 'wework_desktop_core_e2e=%s\n' "$run_core"
  printf 'wework_desktop_core_e2e_matrix=%s\n' "$core_matrix_json"
  printf 'wework_desktop_other_e2e=%s\n' "$run_other"
  printf 'wework_desktop_other_e2e_matrix=%s\n' "$other_matrix_json"
} >> "$output_file"
