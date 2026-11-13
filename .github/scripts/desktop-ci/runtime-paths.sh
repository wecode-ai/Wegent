classify_path() {
  local path="$1"

  # Feature-local dependencies add coverage without replacing existing routes.
  select_path_targets "$path" "${additional_catalog_path_targets[@]}" || true

  if [[ "$path" == wework/e2e/desktop/catalog/*.json ]]; then
    if ! select_catalog_path_targets "$path"; then
      select_all_desktop_suites
    fi
    return
  fi

  case "$path" in
    wework/src/features/todo/ProjectCoordinatorConversation*|wework/src/features/todo/ProjectCoordinatorPublication*|wework/src/features/todo/ProjectCoordinationPanel*|executor/src/runtime_work/handler/project_coordinator.rs|executor/src/runtime_work/handler/project_router*|executor/src/task_runtime/project_router_store.rs|executor/src/task_runtime/store/project_coordinator.rs|wework/e2e/desktop/scenarios/project-coordinator-publication.scenario.mjs|wework/e2e/desktop/scenarios/project-coordination.scenario.mjs)
      select_target "core:stand-in-profile"
      select_target "core:stand-in-permissions"
      return
      ;;
    wework/dsh/coordination-runtime/*|executor/src/runtime_work/handler/coordination_rpc.rs|executor/src/runtime_work/handler/stand_in_arrangements*|executor/src/task_runtime/coordination_arrangements.rs|wework/e2e/desktop/scenarios/coordination-runtime.scenario.mjs|wework/e2e/desktop/scenarios/coordination-arrangements.scenario.mjs)
      select_target "core:stand-in-permissions"
      select_collaboration_dispatch_checkpoints
      case "$path" in
        wework/dsh/coordination-runtime/index.js|wework/dsh/coordination-runtime/package.json|wework/dsh/coordination-runtime/cordis.patch.yml)
          select_target "core:release-package-startup"
          select_target "core:core-dsh-plugin-management"
          ;;
      esac
      return
      ;;
    executor/src/task_runtime/coordination_store.rs)
      select_target "core:stand-in-profile"
      select_target "core:stand-in-permissions"
      return
      ;;
    wework/e2e/desktop/scenarios/stand-in-processing.scenario.mjs|wework/src/features/todo/StandInProcessing*|wework/src/features/todo/useStandInProcessingStatus*|executor/src/runtime_work/handler/stand_in_processing*|executor/src/task_runtime/stand_in_processing.rs|executor/src/task_runtime/mcp/stand_in_processing.rs)
      select_target "core:stand-in-profile"
      select_target "core:stand-in-permissions"
      if [[ "$path" == executor/src/runtime_work/handler/stand_in_processing* ]]; then
        select_collaboration_dispatch_checkpoints
      fi
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-runtime-route-refresh.scenario.mjs | \
      wework/e2e/desktop/modules/plugin-composer-route-messaging.mjs)
      select_target "cloud:plugin-runtime-route-refresh"
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-background-sync-isolation.scenario.mjs)
      select_target "cloud:plugin-background-sync-isolation"
      return
      ;;
    wework/e2e/desktop/modules/plugin-sync-observer.mjs | \
      backend/app/services/plugin_device_identity.py)
      select_plugin_sync_checkpoints
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-periodic-reconcile.scenario.mjs | \
      wework/e2e/desktop/modules/plugin-periodic-reconcile*.mjs)
      select_target "cloud:plugin-periodic-reconcile"
      return
      ;;
  esac

  case "$path" in
    backend/app/services/plugin_device_sync.py | \
      backend/app/api/endpoints/installed_plugins.py)
      select_plugin_sync_checkpoints
      ;;
    wework/src/features/plugins/pluginDeviceApi* | \
      wework/src/desktop/localExecutor* | \
      wework/src/components/plugins/PluginsWorkspace*)
      select_target "cloud:plugin-runtime-route-refresh"
      select_target "cloud:plugin-background-sync-isolation"
      ;;
  esac

  case "$path" in
    backend/app/services/runtime_continuation.py | \
      wework/e2e/desktop/modules/workbench-control-collaboration.mjs | \
      executor/src/runtime_work/reader* | \
      executor/src/workbench_control/* | \
      executor/src/runtime_work/handler/control.rs | \
      executor/src/runtime_work/handler/control/* | \
      executor/src/runtime_work/handler/creation.rs | \
      executor/src/runtime_work/handler/creation/*)
      select_target "core:workbench-control"
      return
      ;;
    executor/src/local/capabilities/runtime_legacy_sources* | \
      wework/e2e/desktop/scenarios/plugin-legacy-upgrade.scenario.mjs | \
      wework/e2e/desktop/modules/legacy-plugin-executor.mjs)
      select_target "cloud:plugin-legacy-upgrade"
      select_target "cloud:plugin-runtime-path-recovery"
      return
      ;;
    packages/chat-core/test-fixtures/conversation-search-contract.json)
      select_target "core:running-conversation-history"
      select_target "cloud:conversation-state"
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-runtime-path-recovery.scenario.mjs | \
      wework/e2e/desktop/modules/plugin-runtime-path-fixture.mjs | \
      wework/e2e/desktop/fixtures/historical-plugin-revision.py | \
      wework/scripts/plugin-runtime-path-fixture.test.mjs)
      select_target "cloud:plugin-runtime-path-recovery"
      return
      ;;
  esac

  case "$path" in
    backend/app/core/distributed_lock.py | \
      backend/app/services/plugin_write_*.py | \
      backend/app/services/plugin_kind_revision.py | \
      backend/app/services/plugin_policy_revision.py)
      select_account_auth_checkpoints
      select_uninstall_checkpoints
      select_target "cloud:plugin-auto-update"
      ;;
  esac

  case "$path" in
    backend/app/api/ws/device_namespace.py | \
      backend/app/api/endpoints/loop_item_executions.py | \
      backend/app/schemas/runtime_execution_snapshot.py | \
      backend/app/services/project_chat/execution_snapshot.py | \
      backend/app/services/loop_item_executions/* | \
      backend/tests/api/ws/test_device_namespace*.py | \
      backend/tests/api/ws/test_device_reconnect_storm.py | \
      backend/tests/api/ws/test_device_runtime_content_reconciliation.py | \
      backend/tests/api/test_loop_item_executions_api.py | \
      backend/tests/schemas/test_runtime_execution_snapshot*.py | \
      backend/tests/services/test_loop_item_executions.py | \
      backend/tests/services/test_project_chat_execution_snapshot.py)
      select_target "core:collaboration-runtime-reconciliation"
      ;;
  esac

  case "$path" in
    backend/app/api/endpoints/cloud_projects.py | \
      backend/app/api/endpoints/workspaces.py | \
      backend/app/schemas/cloud_project.py | backend/app/schemas/workspace.py | \
      backend/app/services/cloud_project_visibility.py | \
      backend/app/services/cloud_projects/* | backend/app/services/workspaces/* | \
      backend/app/services/collaboration_permissions.py | \
      backend/app/services/collaboration_revocation.py | \
      backend/app/services/issue_assignments.py | \
      backend/tests/api/test_collaboration_permission_contract.py | \
      backend/tests/api/test_cloud_project* | \
      backend/tests/services/test_cloud_project* | \
      backend/tests/services/test_loop_item_assignment.py | \
      backend/tests/test_collaboration_permission_guard.py | \
      backend/integration_checks/test_rust_collaboration_permissions_mysql.py | \
      packages/collaboration/src/project-manage/* | \
      packages/collaboration/src/CollaborationApp* | \
      packages/collaboration/src/http-api/createSharedWorkspaceHttpApi* | \
      packages/collaboration/src/ports/SharedWorkspaceApi* | \
      packages/collaboration/src/types*)
      select_target "core:project-member-overrides"
      ;;
  esac

  case "$path" in
    packages/collaboration/src/controls/ModelSelector* | \
      packages/collaboration/src/controls/ModelPowerSlider* | \
      packages/collaboration/src/controls/model-reasoning* | \
      packages/collaboration/src/controls/model-ui* | \
      packages/collaboration/src/controls/model-selector-utils*)
      select_target "cloud:cloud-model-presets"
      select_target "core:codex-native-catalog"
      ;;
  esac
  case "$path" in
    packages/collaboration/src/conversation/McpUrlAuthorizationCard* | \
      packages/collaboration/src/conversation/RequestUserInputCard* | \
      wework/src/components/chat/RequestUserInputCard*)
      select_target "core:permission-modes"
      ;;
  esac
  case "$path" in
    backend/app/api/endpoints/installed_plugins.py | \
      backend/app/api/ws/device_namespace.py | \
      backend/app/services/device/plugin_reconciliation.py | \
      backend/app/services/device/plugin_removal_sync.py | \
      backend/app/services/plugin_device_installation_service.py | \
      backend/app/services/plugin_device_sync.py | \
      backend/app/services/plugin_installation_operations.py | \
      backend/app/services/plugin_marketplace_service.py | \
      wework/src/api/pluginUninstall* | wework/src/api/plugins.ts | \
      wework/src/features/plugins/pluginInventory* | \
      wework/src/features/plugins/pluginMarketplaceCache* | \
      wework/src/components/plugins/PluginsWorkspace* | \
      wework/src/components/plugins/PluginManagementWorkspace* | \
      packages/chat-core/src/installed-plugin-merge.ts)
      select_uninstall_checkpoints
      ;;
  esac
  case "$path" in
    wework/src/features/plugins/useOpenAiPluginCatalog* | \
      wework/src/features/plugins/remotePluginError* | \
      wework/src/api/local/codexPlugins* | \
      wework/e2e/desktop/modules/plugin-flows.mjs)
      select_target "plugins:plugin-composer-network-isolation"
      ;;
  esac
  case "$path" in
    packages/collaboration/src/composer/PluginPickerMenu.tsx | \
      wework/src/components/chat/composer/PluginPickerMenu* | \
      wework/src/components/chat/composer/composerAppsSnapshot* | \
      wework/src/components/plugins/PluginManagementWorkspace* | \
      wework/src/features/plugins/pluginInventory*)
      select_target "cloud:plugin-composer-long-list"
      ;;
    wework/e2e/desktop/modules/plugin-catalog-boundaries.mjs | \
      wework/e2e/desktop/modules/plugin-source-continuation.mjs | \
      wework/e2e/desktop/modules/plugin-late-response-resilience.mjs | \
      wework/e2e/desktop/modules/plugin-scope-boundaries.mjs | \
      wework/e2e/desktop/modules/plugin-detail-resilience.mjs | \
      wework/e2e/desktop/modules/plugin-partial-inventory-resilience.mjs)
      select_target "cloud:plugin-uninstall-lost-response"
      return
      ;;
    wework/e2e/desktop/modules/plugin-install-update-resilience.mjs)
      select_target "cloud:plugin-write-coordination"
      return
      ;;
    wework/scripts/plugin-resilience-checkpoints.test.mjs)
      select_target "cloud:plugin-uninstall-lost-response"
      select_target "cloud:plugin-write-coordination"
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-uninstall-resilience.scenario.mjs | \
      wework/e2e/desktop/modules/plugin-registration-coordination.mjs | \
      wework/e2e/desktop/support/registration-capabilities.py | \
      wework/e2e/desktop/modules/plugin-write-coordination.mjs | \
      wework/e2e/desktop/modules/plugin-sync-disconnect.mjs | \
      wework/e2e/desktop/modules/plugin-write-lease.mjs | \
      wework/e2e/desktop/support/plugin-write-lease.py)
      select_uninstall_checkpoints
      return
      ;;
    wework/scripts/plugin-fault-proxy.test.mjs | \
      wework/e2e/desktop/modules/transport-fault-proxy*)
      select_uninstall_checkpoints
      select_target "cloud:conversation-state"
      if [[ "$path" == wework/e2e/desktop/modules/transport-fault-proxy* ]]; then
        select_plugin_sync_checkpoints
        select_target "core:collaboration-board-move-recovery"
      fi
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-composer-long-list.scenario.mjs)
      select_target "cloud:plugin-composer-long-list"
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-collaboration-composer-isolation.scenario.mjs | \
      packages/chat-core/src/runtime-composer-api* | \
      packages/chat-core/src/runtime-composer-snapshot* | \
      executor/src/runtime_work/handler/composer_catalog*)
      select_target "cloud:plugin-collaboration-composer-isolation"
      return
      ;;
    wework/e2e/desktop/scenarios/plugin-toggle-persistence.scenario.mjs)
      select_target "cloud:plugin-toggle-persistence"
      return
      ;;
    wework/e2e/desktop/modules/plugin-inventory-state.mjs | \
      wework/scripts/plugin-inventory-state.test.mjs)
      select_target "cloud:plugin-runtime-path-recovery"
      select_target "cloud:plugin-toggle-persistence"
      return
      ;;
    wework/e2e/desktop/modules/plugin-regression-fixture.mjs)
      select_plugin_sync_checkpoints
      select_target "cloud:plugin-toggle-persistence"
      select_uninstall_checkpoints
      select_target "cloud:plugin-composer-long-list"
      select_target "cloud:plugin-collaboration-composer-isolation"
      return
      ;;
  esac

  case "$path" in
    sdk/plugin-creator/* | sdk/plugin-auth/* | executor/src/local/plugin_creator.rs | \
      wework/src/components/plugins/PluginCreateWorkspace* | \
      wework/e2e/desktop/modules/plugin-flows.mjs)
      select_target "plugins:plugin-marketplace-lifecycle"
      if [[ "$path" == wework/e2e/desktop/modules/plugin-flows.mjs ]]; then
        select_target "plugins:plugin-lifecycle"
      fi
      select_target "cloud:plugin-workspace-publication"
      ;;
    backend/app/schemas/issue_workflow.py | \
      backend/app/schemas/project_chat.py | \
      backend/app/schemas/runtime_work.py | \
      backend/app/services/cloud_projects/service.py | \
      backend/app/services/issue_execution_configuration.py | \
      backend/app/services/loop_item_executions/* | \
      backend/app/api/endpoints/issue_dispatches.py | \
      backend/app/schemas/issue_dispatch.py | \
      backend/app/services/issue_dispatch*.py | \
      backend/tests/api/test_issue_dispatches_api.py | \
      backend/tests/services/test_issue_dispatch*.py | \
      backend/app/services/project_automation_* | \
      backend/app/services/project_automations.py | \
      backend/app/services/project_chat/* | \
      backend/app/services/project_workflow_projection.py | \
      backend/app/services/runtime_work_service.py | \
      backend/tests/api/test_cloud_projects_api.py | \
      backend/tests/schemas/test_issue_workflow.py | \
      backend/tests/services/test_coordinator_configuration.py | \
      backend/tests/services/test_loop_item_executions.py | \
      backend/tests/services/test_project_automations.py | \
      backend/tests/services/test_project_chat_service.py | \
      backend/tests/services/test_project_workflow_projection.py | \
      backend/tests/services/test_runtime_work_service.py | \
      executor/src/agents/claude_code.rs | \
      executor/src/agents/mod.rs | \
      executor/src/agents/runtime_capabilities.rs | \
      executor/src/runtime_work/events.rs | \
      executor/src/runtime_work/handler.rs | \
      executor/src/runtime_work/handler/claude_turns.rs | \
      executor/src/runtime_work/util.rs | \
      executor/src/services/skill_deployer.rs | \
      executor/src/task_runtime/model.rs | \
      executor/src/task_runtime/store.rs)
      select_collaboration_dispatch_checkpoints
      ;;
  esac

  case "$path" in
    sdk/plugin-auth/* | sdk/plugin-auth-go/* | sdk/dws-auth/* | executor/src/plugin_account_auth/* | \
      executor/tests/plugin_account_auth_contract.rs | \
      backend/app/services/plugin_account* | backend/app/services/plugin_auth* | \
      backend/app/services/plugin_oauth* | backend/app/services/plugin_credential* | \
      backend/app/schemas/plugin_account_auth.py | backend/app/api/ws/plugin_auth_broker.py | \
      backend/app/api/endpoints/plugin_connections.py)
      select_account_auth_checkpoints
      ;;
    executor/src/runtime_work/codex_transcript_page.rs)
      select_target "core:transcript-sync"
      select_target "core:environment-panel-scroll"
      ;;
    backend-rs/migrations/reference/versions/*wework_transcript* | \
      backend/app/api/endpoints/wework_transcripts.py | \
      backend/app/core/wework_transcript_encryption.py | \
      backend/app/models/wework_transcript.py | \
      backend/app/schemas/wework_transcript.py | \
      backend/app/services/wework_transcript_* | \
      backend/tests/api/endpoints/test_wework_transcripts_api.py | \
      backend/tests/models/test_wework_transcript_schema.py | \
      executor/src/runtime_work/native_transcript.rs | \
      executor/src/runtime_work/handler/transcript_sync.rs)
      select_target "core:transcript-sync"
      ;;
    backend/app/api/ws/terminal_namespace.py | \
      backend/app/services/device/terminal_protocol.py | \
      backend/app/services/device/terminal_session_record.py | \
      backend/app/services/device/terminal_session_service.py)
      select_target "cloud:core-task-flow"
      ;;
    executor/src/local/app_ipc.rs | \
      executor/src/local/codex_home.rs | \
      executor/tests/local_app_ipc_contract.rs)
      select_target "core:external-content-import"
      ;;
    backend/app/api/endpoints/runtime_work.py | \
      backend/app/api/ws/device_namespace.py | \
      backend/app/api/ws/wework_runtime_namespace.py | \
      backend/app/schemas/device.py | \
      backend/app/schemas/runtime_work.py | \
      backend/app/services/device/runtime_route.py | \
      backend/app/services/device/runtime_rpc_service.py | \
      backend/app/services/runtime_work_service.py | \
      backend/tests/api/endpoints/test_runtime_work_api.py | \
      backend/tests/api/ws/test_device_reconnect_storm.py | \
      backend/tests/api/ws/test_wework_runtime_namespace.py | \
      backend/tests/services/test_runtime_route.py | \
      backend/tests/services/test_runtime_rpc_service.py | \
      backend/tests/services/test_runtime_work_service.py | \
      docker/device/Dockerfile)
      select_cloud_worktree_checkpoints
      ;;
    wework/e2e/desktop/modules/delivery-cloud-editing.mjs | \
      wework/e2e/desktop/scenarios/collaboration-delivery-editing.scenario.mjs | \
      wework/e2e/desktop/scenarios/collaboration-deliveries.scenario.mjs | \
      packages/collaboration/src/issue-detail/IssueDelivery* | \
      packages/collaboration/src/issue-detail/deliveryMessages*)
      select_target "core:collaboration-deliveries"
      select_target "core:collaboration-delivery-editing"
      ;;
    wework/e2e/desktop/scenarios/collaboration-template-agents.scenario.mjs | \
    wework/e2e/desktop/scenarios/collaboration-template-app-device-routing.scenario.mjs | \
    wework/e2e/desktop/scenarios/collaboration-template-lifecycle.scenario.mjs | \
    wework/e2e/desktop/scenarios/collaboration-templates.scenario.mjs | \
      packages/collaboration/src/templates/* | \
      backend-rs/src/collaboration_templates/* | \
      backend-rs/init_data/04-collaboration-templates.yaml | \
      shared/data/collaboration-templates.json)
      select_target "core:collaboration-templates"
      select_target "core:collaboration-template-lifecycle"
      select_target "core:collaboration-template-agents"
      select_target "core:collaboration-template-app-device-routing"
      if [[ "$path" == packages/collaboration/src/templates/* ]]; then
        select_target "core:collaboration-group-onboarding"
      fi
      ;;
    packages/collaboration/src/platform/WorkspaceResourceConfiguration* | \
      packages/collaboration/src/project-agent-config/* | \
      packages/collaboration/src/agent-form/runnerRouting* | \
      packages/collaboration/src/http-api/createSharedWorkspaceHttpApi* | \
      packages/collaboration/src/ports/SharedWorkspaceApi* | \
      packages/collaboration/src/dto-mappers/workspaceDtoMappers*)
      select_target "core:remote-device-onboarding"
      select_target "core:collaboration-shared-core"
      select_target "core:collaboration-issue-archive"
      select_target "core:collaboration-first-use"
      select_target "core:collaboration-group-onboarding"
      select_collaboration_dispatch_checkpoints
      if [[ "$path" == packages/collaboration/src/project-agent-config/* || \
        "$path" == packages/collaboration/src/agent-form/runnerRouting* ]]; then
        select_target "core:collaboration-template-agents"
        select_target "core:collaboration-template-app-device-routing"
      fi
      select_target "cloud:cloud-device-lifecycle"
      if [[ "$path" == packages/collaboration/src/dto-mappers/workspaceDtoMappers* ]]; then
        select_target "core:collaboration-deliveries"
        select_target "core:collaboration-delivery-editing"
      fi
      ;;
    wework/src/api/agentRoutingCatalog* | \
      wework/src/features/collaboration/WeworkProjectAgentConfigurationHost*)
      select_target "core:collaboration-template-agents"
      select_target "core:collaboration-template-app-device-routing"
      ;;
    packages/collaboration/*)
      if [[ "$path" == packages/collaboration/src/conversation/useConversationScrollController* ]]; then
        select_target "core:follow-up-task-switch"
      fi
      select_target "core:collaboration-parent-board"
      if [[ "$path" == packages/collaboration/src/composer/* ]]; then
        select_target "core:drawing-attachment"
      fi
      select_target "core:collaboration-shared-core"
      select_target "core:collaboration-issue-archive"
      select_target "core:collaboration-first-use"
      select_target "core:collaboration-group-onboarding"
      select_collaboration_dispatch_checkpoints
      select_target "core:collaboration-issue-comment-mention"
      select_target "core:collaboration-issue-assignment-activity"
      select_target "core:collaboration-issue-comment-attachments"
      select_target "core:collaboration-issue-attachment-preview"
      select_target "core:collaboration-issue-comment-notification"
      select_target "core:collaboration-board-sorting"
      select_target "core:collaboration-board-backlog"
      select_target "core:collaboration-board-move-recovery"
      select_target "core:collaboration-home-preload"
      select_target "core:board-transcript-followup"
      if [[ "$path" == packages/collaboration/src/issue-detail/IssueExecutionLists* ||
        "$path" == packages/collaboration/src/issue-detail/createSharedIssueDetailPort* ||
        "$path" == packages/collaboration/src/SharedIssueDetailEditor* ]]; then
        select_target "core:collaboration-deliveries"
        select_target "core:collaboration-delivery-editing"
      fi
      ;;
    executor/crates/model-proxy/src/codex_model_catalog*.rs)
      select_target "core:codex-native-catalog"
      ;;
    executor/* | packages/chat-core/* | package.json | pnpm-lock.yaml | pnpm-workspace.yaml)
      select_all_desktop_suites
      ;;
    backend/app/api/endpoints/openapi_responses.py | \
      backend/app/api/endpoints/wework_api.py | \
      backend/app/services/wework_api/* | \
      backend/tests/api/test_openapi_responses.py | \
      backend/tests/api/test_wework_api.py)
      select_target "cloud:plugin-account-auth-dws"
      ;;
    backend/app/api/endpoints/adapter/attachments.py | \
      backend/tests/api/endpoints/adapter/test_attachment_download_policy_routes.py | \
      backend/tests/api/endpoints/adapter/test_content_disposition.py | \
      backend/app/api/endpoints/cloud_projects.py | \
      backend/app/api/endpoints/deliveries.py | \
      backend/tests/api/test_cloud_projects_api.py | \
      backend/tests/api/test_deliveries_api.py)
      select_target "core:collaboration-issue-attachment-preview"
      ;;
    shared/rust/* | backend-rs/* | backend-rs/** | \
      wework/e2e/desktop/modules/cloud-environment.mjs | \
      wework/e2e/desktop/modules/task-flow-main.mjs | \
      wework/e2e/desktop/support/mysql-helper.py)
      select_all_desktop_suites
      ;;
    .github/ci/rust-toolchain | \
      .github/runtime-images/* | .github/scripts/ci-prebuilt-images.mjs | \
      .github/scripts/resolve-ci-image.mjs | .github/ci/prebuilt-images.json | \
      .github/scripts/publish-ci-prebuild.sh | .github/scripts/restore-ci-downloads.sh | \
      .github/actions/setup-rust-cache/* | \
      .github/actions/setup-sccache/* | \
      .github/actions/setup-node-workspace/* | \
      .github/actions/setup-python-uv-cache/* | \
      .github/actions/setup-wework-native-test-dependencies/* | \
      .github/ci/wework-native-test-ubuntu.sources | \
      .github/actions/build-wework-windows-e2e/* | \
      .github/actions/build-wework-macos-e2e/* | \
      .github/workflows/wework-e2e.yml | \
      .github/actions/build-wework-core-e2e/* | \
      .github/actions/build-minio-e2e/* | \
      .github/actions/setup-minio-e2e/* | \
      .github/ci/wework-linux-checkpoint-durations.json | \
      .github/scripts/order-wework-linux-e2e.* | \
      .github/scripts/core-runner-slots.* | \
      docker/wework-e2e/* | \
      .github/scripts/download-actions-artifact.sh | \
      .github/scripts/restore-actions-runtime.sh | \
      .github/scripts/runtime-artifact.* | \
      .github/scripts/prepare-macos-inspector-e2e.sh | \
      .github/scripts/build-macos-e2e-runtimes.sh | \
      .github/scripts/macos-e2e-source-digest.* | \
      .github/scripts/macos-e2e-build*.mjs | .github/scripts/restore-macos-ci-build.mjs | \
      .github/scripts/verified-build-oci.mjs | \
      .github/scripts/restore-macos-e2e-runtime-oci.sh | .github/scripts/publish-macos-e2e-runtime-oci.sh | \
      .github/scripts/archive-wework-core-e2e-build.sh | \
      .github/scripts/wework-core-e2e-transport.* | \
      .github/scripts/classify-ci-changes.sh | \
      .github/scripts/classify-wework-desktop-e2e.sh | \
      .github/scripts/desktop-ci/* | \
      .github/scripts/ci-classification-tests/* | \
      .github/scripts/restore-wework-core-e2e-build.sh | \
      .github/scripts/test-classify-ci-changes.sh)
      select_all_desktop_suites
      ;;
    wework/scripts/ci-test-sequencer.*)
      ;;
    wework/*)
      classify_wework_path "$path"
      ;;
  esac
}

