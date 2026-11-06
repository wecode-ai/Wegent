#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/../.." && pwd)"
core_segments=()
cloud_segments=()
plugin_segments=()
formal_release_segments=()
cloud_worktree_segments=()
core_shards=()
cloud_shards=()
catalog_path_targets=()
additional_catalog_path_targets=()

# Catalog records are parsed as data; never evaluate checkpoint metadata as shell.
if ! catalog_records="$(node "$repository_root/wework/e2e/desktop/checkpoint-catalog.mjs")"; then
  printf 'Could not load registered desktop checkpoints\n' >&2
  exit 1
fi
while IFS=$'\t' read -r name value pattern; do
  case "$name" in
    core_segments) core_segments+=("$value") ;;
    cloud_segments) cloud_segments+=("$value") ;;
    plugin_segments) plugin_segments+=("$value") ;;
    formal_release_segments) formal_release_segments+=("$value") ;;
    cloud_worktree_segments) cloud_worktree_segments+=("$value") ;;
    core_shards) core_shards+=("$value") ;;
    cloud_shards) cloud_shards+=("$value") ;;
    path_target) catalog_path_targets+=("$value"$'\t'"$pattern") ;;
    additional_path_target) additional_catalog_path_targets+=("$value"$'\t'"$pattern") ;;
    *) printf 'Unknown desktop catalog record: %s\n' "$name" >&2; exit 1 ;;
  esac
done <<< "$catalog_records"

validate_registered_checkpoint_coverage() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local repository_root
  repository_root="$(cd "$script_dir/../.." && pwd)"
  if ! (
    cd "$repository_root"
    node --input-type=module -e '
      import { readFileSync } from "node:fs"
      import { upgradeVerificationCheckpoint } from "./wework/e2e/desktop/upgrade-suite.mjs"
      import {
        DESKTOP_CHECKPOINTS,
        DESKTOP_CHECKPOINT_CI_HOSTS,
        DESKTOP_CHECKPOINT_GROUPS,
        expandDesktopCheckpoints,
      } from "./wework/e2e/desktop/checkpoints.mjs"
      const registered = DESKTOP_CHECKPOINTS.filter(name => !DESKTOP_CHECKPOINT_GROUPS.has(name))
      if (!registered.length) {
        console.error("Registered desktop checkpoint catalog is empty")
        process.exit(1)
      }
      const releaseWorkflow = readFileSync(".github/workflows/wework-app.yml", "utf8")
      const upgradeVerifier = readFileSync("wework/scripts/verify-release-upgrades.mjs", "utf8")
      if (!releaseWorkflow.includes("node wework/scripts/verify-release-upgrades.mjs") ||
          !upgradeVerifier.includes("--parallel-segments") ||
          !upgradeVerifier.includes("diagnosticCheckpoint || upgradeVerificationCheckpoint(platform)")) {
        console.error("The release workflow must invoke its registered platform upgrade checkpoints")
        process.exit(1)
      }
      const releaseCheckpoints = ["macos", "windows"].map(upgradeVerificationCheckpoint)
      const covered = new Set(expandDesktopCheckpoints([...process.argv.slice(1), ...releaseCheckpoints]))
      for (const checkpoint of registered) {
        const host = DESKTOP_CHECKPOINT_CI_HOSTS.get(checkpoint) ?? checkpoint
        if (!covered.has(host)) {
          console.error(`Registered desktop checkpoint missing from CI catalogs: ${checkpoint}`)
          process.exit(1)
        }
      }
    ' -- "${core_segments[@]}" "${cloud_segments[@]}" "${formal_release_segments[@]}"
  ); then
    printf 'Could not load registered desktop checkpoints\n' >&2
    return 1
  fi
}

validate_registered_checkpoint_coverage

declare -A selected=()
desktop_runner_changed=false
macos_inspector_e2e=false
windows_installer_e2e=false

select_target() {
  selected["$1"]=true
  if [[ "$1" == "core:component-update" ]]; then
    macos_inspector_e2e=true
  fi
}

select_catalog_path_targets() {
  select_path_targets "$1" "${catalog_path_targets[@]}"
}

select_path_targets() {
  local path="$1"
  shift
  local record target pattern
  local matched=false
  for record in "$@"; do
    IFS=$'\t' read -r target pattern <<< "$record"
    if [[ "$path" == $pattern ]]; then
      select_target "$target"
      matched=true
    fi
  done
  [[ "$matched" == true ]]
}

select_account_auth_checkpoints() {
  select_target "cloud:plugin-account-auth-password"
  select_target "cloud:plugin-account-auth-transfer"
  select_target "cloud:plugin-account-auth-oauth"
  select_target "cloud:plugin-account-auth-dws"
  select_target "cloud:plugin-account-auth-conversation"
  select_target "cloud:plugin-account-auth-github"
  select_target "cloud:plugin-account-auth-coordination"
}

select_uninstall_checkpoints() {
  select_target "cloud:plugin-uninstall-lost-response"
  select_target "cloud:plugin-uninstall-unknown-result"
  select_target "cloud:plugin-uninstall-restart-recovery"
  select_target "cloud:plugin-uninstall-reinstall-race"
  select_target "cloud:plugin-write-coordination"
  select_target "cloud:plugin-registration-coordination"
  select_target "cloud:plugin-account-auth-coordination"
}

select_plugin_sync_checkpoints() {
  select_target "cloud:plugin-runtime-route-refresh"
  select_target "cloud:plugin-background-sync-isolation"
  select_target "cloud:plugin-periodic-reconcile"
}

select_rendering_checkpoints() {
  select_target "core:rendering-extensions"
  select_target "core:streaming-content"
  select_target "core:streaming-tools"
  select_target "core:streaming-timers"
  select_target "core:streaming-scroll"
  select_target "core:streaming-message-order"
  select_target "core:streaming-conversation-switching"
  select_target "core:streaming-subagents"
}

select_cloud_worktree_checkpoints() {
  local segment
  for segment in "${cloud_worktree_segments[@]}"; do
    select_target "cloud:$segment"
  done
}

select_collaboration_dispatch_checkpoints() {
  select_target "core:collaboration-runtime-reconciliation"
  select_target "core:collaboration-worktree-policy"
  select_target "core:project-assignment-notification"
  select_target "core:collaboration-local-agent-dispatch"
  select_target "core:stand-in"
  select_target "core:stand-in-identities"
  select_target "core:stand-in-connections"
  select_target "core:stand-in-git"
  select_target "core:stand-in-mcp"
  select_target "core:stand-in-cli"
  select_target "core:stand-in-plugin-bridge"
  select_target "core:stand-in-alternate-source"
  select_target "core:stand-in-action-confirmation"
  select_target "core:stand-in-email"
  select_target "core:stand-in-list-confirmation"
  select_target "core:stand-in-profile"
  select_target "core:stand-in-telemetry"
  select_target "core:stand-in-workspace"
  select_target "core:stand-in-controls"
  select_target "core:stand-in-project-enable"
  select_target "core:stand-in-cloud"
  select_target "core:stand-in-assignment-notifications"
  select_target "core:stand-in-personal-task"
  select_target "core:stand-in-permissions"
  select_target "core:collaboration-remote-agent-dispatch"
  select_target "core:collaboration-local-group-coordinate"
  select_target "core:collaboration-remote-group-coordinate"
  select_target "core:collaboration-remote-group-planning-details"
  select_target "core:collaboration-human-round-resume"
  select_target "core:collaboration-local-group-cancellation"
}

select_all_desktop_suites() {
  select_target "core:all"
  select_target "plugins:all"
  select_target "cloud:all"
  macos_inspector_e2e=true
}

# Keep path precedence explicit; feature rules live outside the shared runner.
source "$script_dir/desktop-ci/wework-paths.sh"
source "$script_dir/desktop-ci/workbench-paths.sh"
source "$script_dir/desktop-ci/runtime-paths.sh"

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
    local selected_plugins=()
    local plugin_segment
    for plugin_segment in "${plugin_segments[@]}"; do
      if [[ "${selected[plugins:$plugin_segment]:-false}" == "true" ]]; then
        selected_plugins+=("$plugin_segment")
      fi
    done
    if ((${#selected_plugins[@]} > 0)); then
      local joined_plugins
      joined_plugins="$(IFS=,; printf '%s' "${selected_plugins[*]}")"
      append_matrix_entry plugins Plugins e2e:desktop:plugins "$joined_plugins"
    fi
  fi

  local cloud_shard_index
  for cloud_shard_index in "${!cloud_shards[@]}"; do
    local selected_cloud_segments=()
    local cloud_shard_segments
    IFS=',' read -ra cloud_shard_segments <<< "${cloud_shards[$cloud_shard_index]}"
    local cloud_segment
    for cloud_segment in "${cloud_shard_segments[@]}"; do
      if [[ "${selected[cloud:all]:-false}" == "true" || \
        "${selected[cloud:$cloud_segment]:-false}" == "true" ]]; then
        selected_cloud_segments+=("$cloud_segment")
      fi
    done
    if ((${#selected_cloud_segments[@]} > 0)); then
      local joined_cloud_segments
      joined_cloud_segments="$(IFS=,; printf '%s' "${selected_cloud_segments[*]}")"
      local entry
      printf -v entry \
        '{"id":"cloud-%s","name":"Cloud / shard %s","segments":"%s"}' \
        "$((cloud_shard_index + 1))" \
        "$((cloud_shard_index + 1))" \
        "$joined_cloud_segments"
      cloud_matrix_entries+=("$entry")
    fi
  done
}

if [[ "${1:-}" == "--all" ]]; then
  select_all_desktop_suites
  windows_installer_e2e=true
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
  printf 'wework_desktop_macos_inspector_e2e=%s\n' "$macos_inspector_e2e"
  printf 'wework_windows_installer_e2e=%s\n' "$windows_installer_e2e"
} >> "$output_file"
