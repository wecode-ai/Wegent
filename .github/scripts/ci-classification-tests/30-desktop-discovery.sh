# Sourced by test-classify-ci-changes.sh; all assertions share its helpers.

for path in \
  wework/e2e/desktop/catalog/component-update.json \
  wework/e2e/desktop/scenarios/component-update.scenario.mjs; do
  assert_desktop_case "app update retry coverage runs in Core and macOS CI: $path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"component-update"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=true' \
    "$path"
done

assert_desktop_case "app update retry helper retains full coverage including macOS CI" \
  "$(node "$script_dir/ci-classification-tests/expected-desktop-matrix.mjs" "$repo_root")" \
  "wework/e2e/desktop/modules/app-update-retry.mjs"

assert_desktop_case "unbound project-space discovery is invoked by its core CI checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"project-space-tool-discovery"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/project-space-tool-discovery.scenario.mjs"

assert_desktop_case "Windows background policy runs its native checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-8","name":"Core / shard 8","segments":"window-background-policy"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/electron/src/host/window-background-policy.ts" \
  "wework/e2e/desktop/scenarios/window-background-policy.scenario.mjs"

assert_desktop_case "Issue navigation source changes retain existing coverage and select notification reads" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"notification-tab-navigation"},{"id":"core-2","name":"Core / shard 2","segments":"project-assignment-notification,human-interactions"},{"id":"core-3","name":"Core / shard 3","segments":"stand-in-notifications,human-interactions-browser,human-interactions-hidden"},{"id":"core-5","name":"Core / shard 5","segments":"human-interactions-issue"},{"id":"core-8","name":"Core / shard 8","segments":"collaboration-issue-comment-notification,stand-in-cloud,stand-in-assignment-notifications"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/features/notifications/WeworkSchemeBridge.tsx" \
  "wework/src/features/notifications/scheme.ts"

assert_desktop_case "Issue read API changes retain board coverage and select notification reads" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"task-status-sync"},{"id":"core-6","name":"Core / shard 6","segments":"task-board-association"},{"id":"core-8","name":"Core / shard 8","segments":"collaboration-issue-comment-notification"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/api/deliveries.ts"

assert_desktop_case "Issue notification read scenario selects its existing CI group" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-8","name":"Core / shard 8","segments":"collaboration-issue-comment-notification"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/issue-notification-read.scenario.mjs"

for terminal_wiring_path in \
  wework/src/components/layout/DesktopWorkbenchMain.tsx \
  wework/src/components/layout/workspace-panels/RightWorkspacePanel.tsx \
  wework/src/api/hybrid/hybridServices.ts \
  wework/src/api/hybrid/hybridServices.test.ts \
  wework/src/api/local/localServices.ts \
  wework/src/api/local/localServices.test.ts; do
  terminal_wiring_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$terminal_wiring_path")"
  if [[ "$terminal_wiring_output" != *"background-terminals"* ]]; then
    printf 'Terminal wiring changes must select background-terminal coverage: %s\n%s\n' \
      "$terminal_wiring_path" "$terminal_wiring_output" >&2
    exit 1
  fi
done

assert_desktop_case "home preload race is invoked by its core CI checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"collaboration-home-preload"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/collaboration-home-preload.scenario.mjs"

for board_transcript_path in \
  wework/e2e/desktop/scenarios/board-transcript-followup.scenario.mjs \
  wework/src/features/todo/useBoardRuntimeConversations.ts \
  wework/src/features/todo/useBoardRuntimeConversations.test.ts; do
  assert_desktop_case "board transcript follow-up regression is selected by CI" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-3","name":"Core / shard 3","segments":"board-transcript-followup"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$board_transcript_path"
done

assert_desktop_case "device artifact scenario is invoked by its core CI checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"device-artifact-declaration"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/device-artifact-declaration.scenario.mjs"

assert_desktop_case "local artifact scenario is invoked by its core CI checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-5","name":"Core / shard 5","segments":"local-artifact-declaration"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/local-artifact-declaration.scenario.mjs"

for assignment_trigger_path in \
  wework/src/api/hybrid/hybridServices.ts \
  executor/src/runtime_work/handler/stand_in_events.rs; do
  assignment_trigger_output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$assignment_trigger_path")"
  if [[ "$assignment_trigger_output" != *"stand-in-assignment-notifications"* ]]; then
    printf 'Assignment trigger changes must select notification coverage: %s\n%s\n' \
      "$assignment_trigger_path" "$assignment_trigger_output" >&2
    exit 1
  fi
done

for voice_input_path in \
  "wework/dsh/voice-input/client.js" \
  "wework/e2e/desktop/scenarios/voice-input.scenario.mjs"; do
  assert_desktop_case "voice input runs in its core CI shard: $voice_input_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"voice-input"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$voice_input_path"
done

assert_desktop_case "cloud catalog recovery changes select the real backend checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-4","name":"Cloud / shard 4","segments":"cloud-model-recovery"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/src/api/hybrid/cloudModelCatalog.ts" \
  "wework/e2e/desktop/modules/cloud-model-recovery.mjs" \
  "wework/e2e/desktop/scenarios/cloud-model-recovery.scenario.mjs"

for responses_gateway_path in \
  wework/e2e/desktop/scenarios/responses-api-gateway.scenario.mjs \
  backend/app/api/endpoints/openapi_responses.py \
  backend/app/api/endpoints/wework_api.py \
  backend/app/services/wework_api/service.py \
  backend/tests/api/test_openapi_responses.py \
  backend/tests/api/test_wework_api.py; do
  assert_desktop_case "Responses creation reuses the existing account-auth Cloud lifecycle: $responses_gateway_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-8","name":"Cloud / shard 8","segments":"plugin-account-auth-dws"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$responses_gateway_path"
done

assert_desktop_case "deleted task model recovery runs in the cloud shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-5","name":"Cloud / shard 5","segments":"task-model-deletion"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/task-model-deletion.scenario.mjs"

assert_desktop_case "cloud model preset regression runs in the cloud shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-2","name":"Cloud / shard 2","segments":"cloud-model-presets"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/cloud-model-presets.scenario.mjs"

assert_desktop_case "cloud history search selects its real cloud conversation checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-4","name":"Cloud / shard 4","segments":"conversation-state"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/modules/cloud-history-search.mjs"

history_search_expected='wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"running-conversation-history"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-4","name":"Cloud / shard 4","segments":"conversation-state"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false'
for history_search_path in \
  "wework/e2e/desktop/modules/terminal-history-search.mjs" \
  "wework/e2e/desktop/modules/cached-history-search.mjs" \
  "wework/e2e/desktop/modules/conversation-search-contract.mjs" \
  "packages/chat-core/test-fixtures/conversation-search-contract.json"; do
  assert_desktop_case "shared history search selects local and cloud checkpoints: $history_search_path" \
    "$history_search_expected" "$history_search_path"
done

assert_desktop_case "plugin uninstall scenario selects its independent checkpoints" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-uninstall-restart-recovery,plugin-uninstall-lost-response"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-write-coordination,plugin-account-auth-coordination"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"plugin-uninstall-unknown-result,plugin-registration-coordination"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"plugin-uninstall-reinstall-race"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/scenarios/plugin-uninstall-resilience.scenario.mjs"

assert_desktop_case "shared transport faults select board recovery and cloud history search" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-4","name":"Core / shard 4","segments":"collaboration-board-move-recovery"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-uninstall-restart-recovery,plugin-uninstall-lost-response"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-write-coordination,plugin-account-auth-coordination"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"conversation-state,plugin-uninstall-unknown-result,plugin-registration-coordination"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"plugin-uninstall-reinstall-race"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"plugin-runtime-route-refresh,plugin-background-sync-isolation,plugin-periodic-reconcile"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/e2e/desktop/modules/transport-fault-proxy.mjs"

assert_desktop_case "transport fault tests select cloud recovery and history search" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-uninstall-restart-recovery,plugin-uninstall-lost-response"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-write-coordination,plugin-account-auth-coordination"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"conversation-state,plugin-uninstall-unknown-result,plugin-registration-coordination"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"plugin-uninstall-reinstall-race"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}
wework_desktop_macos_inspector_e2e=false' \
  "wework/scripts/plugin-fault-proxy.test.mjs"

for uninstall_path in \
  "wework/e2e/desktop/modules/plugin-registration-coordination.mjs" \
  "wework/e2e/desktop/support/registration-capabilities.py" \
  "wework/e2e/desktop/modules/plugin-write-coordination.mjs" \
  "wework/e2e/desktop/modules/plugin-sync-disconnect.mjs" \
  "wework/e2e/desktop/modules/plugin-write-lease.mjs" \
  "wework/e2e/desktop/support/plugin-write-lease.py" \
  "backend/app/services/device/plugin_reconciliation.py" \
  "backend/app/services/device/plugin_removal_sync.py" \
  "backend/app/services/plugin_device_installation_service.py" \
  "backend/app/services/plugin_installation_operations.py" \
  "backend/app/services/plugin_marketplace_service.py"; do
  assert_desktop_case "plugin write and uninstall changes select real cloud recovery: $uninstall_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-uninstall-restart-recovery,plugin-uninstall-lost-response"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-write-coordination,plugin-account-auth-coordination"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"plugin-uninstall-unknown-result,plugin-registration-coordination"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"plugin-uninstall-reinstall-race"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$uninstall_path"
done

for catalog_boundary_path in \
  "wework/e2e/desktop/modules/plugin-catalog-boundaries.mjs" \
  "wework/e2e/desktop/modules/plugin-source-continuation.mjs" \
  "wework/e2e/desktop/modules/plugin-late-response-resilience.mjs" \
  "wework/e2e/desktop/modules/plugin-scope-boundaries.mjs" \
  "wework/e2e/desktop/modules/plugin-detail-resilience.mjs" \
  "wework/e2e/desktop/modules/plugin-partial-inventory-resilience.mjs"; do
  assert_desktop_case "plugin read boundary reuses the uninstall cloud checkpoint: $catalog_boundary_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-uninstall-lost-response"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$catalog_boundary_path"
done

assert_desktop_case "plugin install and update faults reuse the write-coordination cloud checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-write-coordination"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/plugin-install-update-resilience.mjs"

assert_desktop_case "plugin resilience orchestration tests select both existing cloud hosts" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-uninstall-lost-response"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-write-coordination"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/scripts/plugin-resilience-checkpoints.test.mjs"

assert_desktop_case "long plugin list selects its independent cloud checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-7","name":"Cloud / shard 7","segments":"plugin-composer-long-list"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/plugin-composer-long-list.scenario.mjs"

for plugin_sync_checkpoint in \
  plugin-runtime-route-refresh \
  plugin-background-sync-isolation \
  plugin-periodic-reconcile; do
  assert_desktop_case "plugin sync checkpoint runs independently: $plugin_sync_checkpoint" \
    "wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={\"include\":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={\"include\":[{\"id\":\"cloud-7\",\"name\":\"Cloud / shard 7\",\"segments\":\"$plugin_sync_checkpoint\"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={\"include\":[]}" \
    "wework/e2e/desktop/scenarios/$plugin_sync_checkpoint.scenario.mjs"
done

assert_desktop_case "plugin composer route messaging runs with its scenario" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-7","name":"Cloud / shard 7","segments":"plugin-runtime-route-refresh"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/plugin-composer-route-messaging.mjs"

assert_desktop_case "shared plugin sync observer selects every consumer" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-7","name":"Cloud / shard 7","segments":"plugin-runtime-route-refresh,plugin-background-sync-isolation,plugin-periodic-reconcile"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/plugin-sync-observer.mjs"

assert_desktop_case "plugin-only runtime identity selects route, background and periodic recovery" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-7","name":"Cloud / shard 7","segments":"plugin-runtime-route-refresh,plugin-background-sync-isolation,plugin-periodic-reconcile"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "backend/app/services/plugin_device_identity.py"

assert_desktop_case "plugin sync writes exercise route, background and periodic recovery" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-uninstall-restart-recovery,plugin-uninstall-lost-response"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-write-coordination,plugin-account-auth-coordination"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"plugin-uninstall-unknown-result,plugin-registration-coordination"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"plugin-uninstall-reinstall-race"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"plugin-runtime-route-refresh,plugin-background-sync-isolation,plugin-periodic-reconcile"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "backend/app/services/plugin_device_sync.py" \
  "backend/app/api/endpoints/installed_plugins.py"

assert_desktop_case "collaboration plugin isolation selects its cloud checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-7","name":"Cloud / shard 7","segments":"plugin-collaboration-composer-isolation"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/plugin-collaboration-composer-isolation.scenario.mjs" \
  "packages/chat-core/src/runtime-composer-api.ts" \
  "packages/chat-core/src/runtime-composer-snapshot.ts" \
  "executor/src/runtime_work/handler/composer_catalog.rs"

for inventory_path in \
  "wework/e2e/desktop/modules/plugin-inventory-state.mjs" \
  "wework/scripts/plugin-inventory-state.test.mjs"; do
  assert_desktop_case "plugin inventory refresh selects both consumers: $inventory_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-runtime-path-recovery"},{"id":"cloud-2","name":"Cloud / shard 2","segments":"plugin-toggle-persistence"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$inventory_path"
done

assert_desktop_case "shared plugin regression fixture selects both checkpoints" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-uninstall-restart-recovery,plugin-uninstall-lost-response"},{"id":"cloud-2","name":"Cloud / shard 2","segments":"plugin-toggle-persistence"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-write-coordination,plugin-account-auth-coordination"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"plugin-uninstall-unknown-result,plugin-registration-coordination"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"plugin-uninstall-reinstall-race"},{"id":"cloud-7","name":"Cloud / shard 7","segments":"plugin-composer-long-list,plugin-collaboration-composer-isolation,plugin-runtime-route-refresh,plugin-background-sync-isolation,plugin-periodic-reconcile"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/plugin-regression-fixture.mjs"

assert_desktop_case "plugin Home recovery runs its independently bootstrapped cloud checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-runtime-path-recovery"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/plugin-runtime-path-recovery.scenario.mjs" \
  "wework/e2e/desktop/modules/plugin-runtime-path-fixture.mjs" \
  "wework/e2e/desktop/fixtures/historical-plugin-revision.py" \
  "wework/scripts/plugin-runtime-path-fixture.test.mjs"

assert_desktop_case "historical plugin layouts run real old installers and Home recovery" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-runtime-path-recovery,plugin-legacy-upgrade"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "executor/src/local/capabilities/runtime_legacy_sources.rs" \
  "executor/src/local/capabilities/runtime_legacy_sources_tests.rs" \
  "wework/e2e/desktop/scenarios/plugin-legacy-upgrade.scenario.mjs" \
  "wework/e2e/desktop/modules/legacy-plugin-executor.mjs"

assert_desktop_case "conversation auth changes select managed login regression" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-account-auth-coordination"},{"id":"cloud-6","name":"Cloud / shard 6","segments":"plugin-account-auth-password,plugin-account-auth-transfer,plugin-account-auth-oauth"},{"id":"cloud-8","name":"Cloud / shard 8","segments":"plugin-account-auth-dws,plugin-account-auth-conversation,plugin-account-auth-github"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}' \
  "wework/src/features/plugins/localConnectorAuthGate.ts" \
  "wework/src/features/plugins/useLocalConnectorAuthGate.ts" \
  "wework/src/components/layout/DesktopEmptyTaskLauncher.tsx" \
  "wework/src/components/chat/ConnectorAuthCard.tsx" \
  "wework/src/api/local/githubCli.ts" \
  "wework/src/features/plugins/githubCliAuthGate.test.tsx"

# Check each path independently: a broad executor change must not hide missing
# authorization routing for a later frontend-only pull request.
for auth_path in \
  "wework/src/features/plugins/codexConnectorAuthorization.ts" \
  "wework/src/components/plugins/GithubCliAuthDialog.tsx" \
  "wework/src/components/plugins/PluginConnectorSection.tsx" \
  "wework/src/components/plugins/LocalConnectorAuthDialog.tsx"; do
  assert_desktop_case "provider authorization selects account regression: $auth_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-account-auth-coordination"},{"id":"cloud-6","name":"Cloud / shard 6","segments":"plugin-account-auth-password,plugin-account-auth-transfer,plugin-account-auth-oauth"},{"id":"cloud-8","name":"Cloud / shard 8","segments":"plugin-account-auth-dws,plugin-account-auth-conversation,plugin-account-auth-github"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle"}]}' \
    "$auth_path"
done

assert_desktop_case "remote catalog changes invoke the network isolation checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"project-ai-settings"}]}
wework_desktop_other_e2e=true
wework_desktop_other_e2e_matrix={"include":[{"id":"plugins","name":"Plugins","command":"e2e:desktop:plugins","segment":"plugin-lifecycle,plugin-composer-network-isolation"}]}' \
  "wework/src/features/plugins/useOpenAiPluginCatalog.ts"

for account_fixture in \
  "wework/e2e/desktop/modules/plugin-auth-coordination.mjs" \
  "wework/e2e/desktop/fixtures/dws-store/main.go" \
  "wework/e2e/desktop/modules/plugin-conversation-auth.mjs" \
  "wework/e2e/desktop/modules/github-manage-connection.mjs"; do
  assert_desktop_case "account authentication fixture selects its regression: $account_fixture" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-account-auth-coordination"},{"id":"cloud-6","name":"Cloud / shard 6","segments":"plugin-account-auth-password,plugin-account-auth-transfer,plugin-account-auth-oauth"},{"id":"cloud-8","name":"Cloud / shard 8","segments":"plugin-account-auth-dws,plugin-account-auth-conversation,plugin-account-auth-github"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$account_fixture"
done

for coordination_path in \
  "backend/app/core/distributed_lock.py" \
  "backend/app/services/plugin_write_coordination.py" \
  "backend/app/services/plugin_write_operations.py" \
  "backend/app/services/plugin_write_errors.py" \
  "backend/app/services/plugin_write_resources.py" \
  "backend/app/services/plugin_kind_revision.py" \
  "backend/app/services/plugin_policy_revision.py"; do
  assert_desktop_case "plugin write coordination selects its lifecycle regressions: $coordination_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-1","name":"Cloud / shard 1","segments":"plugin-uninstall-restart-recovery,plugin-uninstall-lost-response"},{"id":"cloud-3","name":"Cloud / shard 3","segments":"plugin-auto-update,plugin-write-coordination,plugin-account-auth-coordination"},{"id":"cloud-4","name":"Cloud / shard 4","segments":"plugin-uninstall-unknown-result,plugin-registration-coordination"},{"id":"cloud-5","name":"Cloud / shard 5","segments":"plugin-uninstall-reinstall-race"},{"id":"cloud-6","name":"Cloud / shard 6","segments":"plugin-account-auth-password,plugin-account-auth-transfer,plugin-account-auth-oauth"},{"id":"cloud-8","name":"Cloud / shard 8","segments":"plugin-account-auth-dws,plugin-account-auth-conversation,plugin-account-auth-github"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$coordination_path"
done

assert_desktop_case "notification tab navigation runs in a Core CI shard" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"notification-tab-navigation"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/scenarios/notification-tab-navigation.scenario.mjs"

for notification_path in \
  "wework/e2e/desktop/scenarios/stand-in-notifications.scenario.mjs" \
  "wework/src/features/notifications/NotificationCenter.tsx" \
  "wework/src/features/notifications/useUnlistedStandInTasks.ts"
do
  assert_desktop_case "stand-in notifications select local and cloud regressions: $notification_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"notification-tab-navigation"},{"id":"core-2","name":"Core / shard 2","segments":"project-assignment-notification,human-interactions"},{"id":"core-3","name":"Core / shard 3","segments":"stand-in-notifications,human-interactions-browser,human-interactions-hidden"},{"id":"core-5","name":"Core / shard 5","segments":"human-interactions-issue"},{"id":"core-8","name":"Core / shard 8","segments":"stand-in-cloud,stand-in-assignment-notifications"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$notification_path"
done

