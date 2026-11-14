# Sourced by test-classify-ci-changes.sh; all assertions share its helpers.

for mobile_subagent_path in \
  wework-mobile/src/components/ConversationAgentsPill.tsx \
  wework-mobile/src/domain/mobileSubagents.ts \
  wework-mobile/src/domain/mobileSubagents.test.ts \
  wework-mobile/src/domain/mobileProcessingBlocks.ts \
  wework-mobile/src/services/mobileTranscriptTransfer.ts; do
  assert_case "mobile subagents enable the existing runtime protocol CI gate" \
    "${all_false/wework_e2e=false/wework_e2e=true}" \
    "$mobile_subagent_path"
  assert_desktop_case "mobile subagents select only the existing lifecycle and history checkpoint" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","name":"Core / shard 1","segments":"streaming-subagents"}]}
wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$mobile_subagent_path"
done

for mobile_file_path in \
  wework-mobile/src/components/files/FilePreviewProvider.tsx \
  wework-mobile/src/components/files/FileDirectoryBrowser.tsx \
  wework-mobile/src/components/files/FileBrowserModal.tsx \
  wework-mobile/src/domain/mobileFileTarget.ts \
  wework-mobile/src/domain/mobileFiles.ts \
  wework-mobile/src/services/mobileFileStore.ts \
  wework-mobile/src/services/mobilePreviewRuntime.ts \
  wework-mobile/src/services/runtimeFilesApi.test.ts \
  wework-mobile/src/services/runtimeStream.ts \
  wework-mobile/src/services/runtimeStream.test.ts \
  wework-mobile/src/types/runtimeCommand.ts \
  wework-mobile/src/hooks/useMobileRuntime.ts \
  wework-mobile/src/hooks/useMobileRuntime.test.tsx \
  wework-mobile/src/types/files.ts \
  wework-mobile/src/types/workspaceGit.ts \
  wework-mobile/src/domain/mobileWorkspaceGit.ts \
  wework-mobile/src/services/mobileWorkspaceGit.ts \
  wework-mobile/src/components/ConversationChangesPill.tsx \
  wework-mobile/src/components/ConversationMenu.tsx \
  wework-mobile/src/hooks/useConversationActions.ts \
  wework-mobile/src/domain/conversationActions.ts \
  wework-mobile/src/services/mobileConversationArchive.ts \
  wework-mobile/preview/main.tsx; do
  assert_case "mobile files enable their existing cloud protocol CI gate" \
    "${all_false/wework_e2e=false/wework_e2e=true}" \
    "$mobile_file_path"
  assert_desktop_case "mobile files select only the existing cloud file checkpoint" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-3","name":"Cloud / shard 3","segments":"workspace-attachments"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$mobile_file_path"
done

assert_case "mobile API changes enable their existing protocol CI gate" \
  "${all_false/wework_e2e=false/wework_e2e=true}" \
  "wework-mobile/src/services/runtimeApi.ts"
assert_desktop_case "mobile API preserves remote task access coverage alongside files" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-2","name":"Core / shard 2","segments":"remote-task-access"}]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-3","name":"Cloud / shard 3","segments":"workspace-attachments"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework-mobile/src/services/runtimeApi.ts"

assert_desktop_case "cloud chunk protocol module reuses the existing cloud file checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-3","name":"Cloud / shard 3","segments":"workspace-attachments"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/workspace-file-chunks-flow.mjs"

assert_desktop_case "conversation menu protocol reuses the existing cloud file checkpoint" \
  'wework_desktop_e2e=true
wework_desktop_core_e2e=false
wework_desktop_core_e2e_matrix={"include":[]}
wework_desktop_cloud_e2e=true
wework_desktop_cloud_e2e_matrix={"include":[{"id":"cloud-3","name":"Cloud / shard 3","segments":"workspace-attachments"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
  "wework/e2e/desktop/modules/conversation-menu-flow.mjs"

# Shared files retain the existing full-suite policy; Mobile mappings only add coverage.
shared_file_expected="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" --all)"
for shared_file_path in \
  packages/chat-core/src/workspace-file-paths.ts \
  packages/chat-core/src/workspace-file-types.ts; do
  assert_desktop_case "shared file helpers retain all existing desktop coverage" \
    "$shared_file_expected" "$shared_file_path"
done
