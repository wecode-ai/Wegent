import type {
  ArchivedConversationsListRequest,
  ArchivedConversationsListResponse,
  BindRuntimeTaskIMSessionsRequest,
  BindRuntimeTaskIMSessionsResponse,
  DeleteDeviceWorkspaceRequest,
  DeleteDeviceWorkspaceResponse,
  DeviceWorkspaceResponse,
  DeviceWorkspacePrepareRequest,
  DeviceWorkspacePrepareResponse,
  DeviceWorkspaceUpsert,
  RuntimeGlobalIMNotificationUpdateRequest,
  RuntimeIMNotificationPresenceResponse,
  RuntimeIMNotificationPresenceUpdateRequest,
  RuntimeGuidanceRequest,
  RuntimeGuidanceResponse,
  RuntimeInterruptAndSendRequest,
  RuntimeModelPrepareRequest,
  RuntimeRollbackRequest,
  RuntimeGoalClearRequest,
  RuntimeGoalClearResponse,
  RuntimeGoalGetRequest,
  RuntimeGoalGetResponse,
  RuntimeGoalSetRequest,
  RuntimeGoalSetResponse,
  RuntimeSupervisorClearRequest,
  RuntimeSupervisorGetRequest,
  RuntimeSupervisorResolveRequest,
  RuntimeSupervisorResponse,
  RuntimeSupervisorRunNowRequest,
  RuntimeSupervisorSetRequest,
  RuntimeFileChangesRevertRequest,
  RuntimeFileChangesRevertResponse,
  RuntimeIMNotificationSettingsResponse,
  RuntimeArchiveProjectConversationsRequest,
  RuntimeArchivedConversationBulkRequest,
  RuntimeArchivedConversationBulkResponse,
  RuntimeArchivedConversationCleanupResponse,
  RuntimeCompactRequest,
  RuntimeSendRequest,
  RuntimeSendResponse,
  RuntimeTaskAddress,
  RuntimeTaskArchiveResponse,
  RuntimeTaskCancelResponse,
  RuntimeTaskCreateRequest,
  RuntimeTaskCreateResponse,
  RuntimeTaskForkRequest,
  RuntimeTaskForkResponse,
  RuntimeTaskQueueReorderRequest,
  RuntimeTaskQueueReorderResponse,
  RuntimeTaskRenameRequest,
  RuntimeSettings,
  RuntimeTaskIMNotificationSubscriptionRequest,
  RuntimeTaskIMNotificationSubscriptionResponse,
  RuntimeTranscriptRequest,
  RuntimeTranscriptResponse,
  RuntimeWorkSearchRequest,
  RuntimeWorkSearchResponse,
  RuntimeWorkspaceSearchRequest,
  RuntimeWorkspaceSearchResponse,
  RuntimeWorkspaceOpenRequest,
  RuntimeWorkspaceOpenResponse,
  RuntimeLocalProjectUpsertRequest,
  RuntimeLocalProjectUpsertResponse,
  RuntimeWorkspaceRemoveRequest,
  RuntimeWorkspaceRenameRequest,
  RuntimeWorkListResponse,
  RuntimeProjectAppearanceRequest,
  RuntimeProjectActivateRequest,
  RuntimeProjectPinRequest,
  RuntimeProjectReorderRequest,
  RuntimeRemoteProjectsSyncRequest,
  RuntimeProjectTaskReorderRequest,
  RuntimeSidebarMutationResponse,
  RuntimeTaskPinRequest,
  RuntimeWorktreeDeleteRequest,
  RuntimeWorktreeListResponse,
  RuntimeWorktreeMutationResponse,
  RuntimeWorktreePrepareRequest,
  RuntimeWorktreeSettings,
  RuntimeWorktreeSettingsPatch,
} from '@/types/api'
import type { HttpClient, HttpRequestOptions } from './http'
import type { KeybindingOverride } from '@/lib/keybindings'

export function createRuntimeWorkApi(client: HttpClient) {
  return {
    prepareRuntimeModel(data: RuntimeModelPrepareRequest): Promise<boolean> {
      void data
      return Promise.resolve(true)
    },
    listRuntimeWork(
      requestOptions?: Pick<HttpRequestOptions, 'signal'>
    ): Promise<RuntimeWorkListResponse> {
      return requestOptions
        ? client.get('/runtime-work', requestOptions)
        : client.get('/runtime-work')
    },
    getKeybindings(): Promise<{ keybindings: KeybindingOverride[] }> {
      return client.get('/runtime-work/keybindings')
    },
    getRuntimeSettings(): Promise<RuntimeSettings> {
      return client.get('/runtime-work/settings')
    },
    updateRuntimeSettings(data: RuntimeSettings): Promise<RuntimeSettings> {
      return client.put('/runtime-work/settings', data)
    },
    updateKeybindings(data: {
      keybindings: KeybindingOverride[]
    }): Promise<{ keybindings: KeybindingOverride[] }> {
      return client.put('/runtime-work/keybindings', data)
    },
    upsertDeviceWorkspace(data: DeviceWorkspaceUpsert): Promise<DeviceWorkspaceResponse> {
      return client.post('/runtime-work/device-workspaces', data)
    },
    prepareDeviceWorkspace(
      data: DeviceWorkspacePrepareRequest
    ): Promise<DeviceWorkspacePrepareResponse> {
      return client.post('/runtime-work/device-workspaces/prepare', data)
    },
    deleteDeviceWorkspace(
      data: DeleteDeviceWorkspaceRequest
    ): Promise<DeleteDeviceWorkspaceResponse> {
      const params = new URLSearchParams({
        project_id: String(data.projectId),
        device_id: data.deviceId,
        workspace_path: data.workspacePath,
      })
      return client.delete(`/runtime-work/device-workspaces?${params.toString()}`)
    },
    getRuntimeTranscript(request: RuntimeTranscriptRequest): Promise<RuntimeTranscriptResponse> {
      return client.post('/runtime-work/transcript', request)
    },
    searchRuntimeWork(data: RuntimeWorkSearchRequest): Promise<RuntimeWorkSearchResponse> {
      return client.post('/runtime-work/search', data)
    },
    searchRuntimeWorkspace(
      data: RuntimeWorkspaceSearchRequest
    ): Promise<RuntimeWorkspaceSearchResponse> {
      return client.post('/runtime-work/workspace/search', data)
    },
    revertRuntimeFileChanges(
      request: RuntimeFileChangesRevertRequest
    ): Promise<RuntimeFileChangesRevertResponse> {
      return client.post('/runtime-work/file-changes/revert', request)
    },
    sendRuntimeMessage(data: RuntimeSendRequest): Promise<RuntimeSendResponse> {
      return client.post('/runtime-work/send', data)
    },
    interruptAndSendRuntimeMessage(
      data: RuntimeInterruptAndSendRequest
    ): Promise<RuntimeSendResponse> {
      return client.post('/runtime-work/interrupt-and-send', data)
    },
    rollbackRuntimeTask(data: RuntimeRollbackRequest): Promise<RuntimeSendResponse> {
      return client.post('/runtime-work/rollback', data)
    },
    compactRuntimeTask(data: RuntimeCompactRequest): Promise<RuntimeSendResponse> {
      void data
      return Promise.reject(new Error('上下文压缩只支持本机 Wework App'))
    },
    guideRuntimeTask(data: RuntimeGuidanceRequest): Promise<RuntimeGuidanceResponse> {
      return client.post('/runtime-work/guidance', data)
    },
    getRuntimeGoal(data: RuntimeGoalGetRequest): Promise<RuntimeGoalGetResponse> {
      return client.post('/runtime-work/goal/get', data)
    },
    setRuntimeGoal(data: RuntimeGoalSetRequest): Promise<RuntimeGoalSetResponse> {
      return client.post('/runtime-work/goal/set', data)
    },
    clearRuntimeGoal(data: RuntimeGoalClearRequest): Promise<RuntimeGoalClearResponse> {
      return client.post('/runtime-work/goal/clear', data)
    },
    getRuntimeSupervisor(data: RuntimeSupervisorGetRequest): Promise<RuntimeSupervisorResponse> {
      return client.post('/runtime-work/supervisor/get', data)
    },
    setRuntimeSupervisor(data: RuntimeSupervisorSetRequest): Promise<RuntimeSupervisorResponse> {
      return client.post('/runtime-work/supervisor/set', data)
    },
    clearRuntimeSupervisor(
      data: RuntimeSupervisorClearRequest
    ): Promise<RuntimeSupervisorResponse> {
      return client.post('/runtime-work/supervisor/clear', data)
    },
    runRuntimeSupervisorNow(
      data: RuntimeSupervisorRunNowRequest
    ): Promise<RuntimeSupervisorResponse> {
      return client.post('/runtime-work/supervisor/run-now', data)
    },
    resolveRuntimeSupervisor(
      data: RuntimeSupervisorResolveRequest
    ): Promise<RuntimeSupervisorResponse> {
      return client.post('/runtime-work/supervisor/resolve', data)
    },
    openRuntimeWorkspace(data: RuntimeWorkspaceOpenRequest): Promise<RuntimeWorkspaceOpenResponse> {
      return client.post('/runtime-work/workspaces/open', data)
    },
    upsertLocalRuntimeProject(
      data: RuntimeLocalProjectUpsertRequest
    ): Promise<RuntimeLocalProjectUpsertResponse> {
      return client.post('/runtime-work/projects/local', data)
    },
    renameRuntimeWorkspace(
      data: RuntimeWorkspaceRenameRequest
    ): Promise<RuntimeWorkspaceOpenResponse> {
      return client.post('/runtime-work/workspaces/rename', data)
    },
    removeRuntimeWorkspace(
      data: RuntimeWorkspaceRemoveRequest
    ): Promise<RuntimeWorkspaceOpenResponse> {
      return client.post('/runtime-work/workspaces/remove', data)
    },
    reorderRuntimeProjects(
      data: RuntimeProjectReorderRequest
    ): Promise<RuntimeSidebarMutationResponse> {
      return client.post('/runtime-work/sidebar/projects/reorder', data)
    },
    setRuntimeProjectPinned(
      data: RuntimeProjectPinRequest
    ): Promise<RuntimeSidebarMutationResponse> {
      return client.post('/runtime-work/sidebar/projects/pin', data)
    },
    setRuntimeProjectAppearance(
      data: RuntimeProjectAppearanceRequest
    ): Promise<RuntimeSidebarMutationResponse> {
      return client.post('/runtime-work/sidebar/projects/appearance', data)
    },
    syncRuntimeRemoteProjects(
      data: RuntimeRemoteProjectsSyncRequest
    ): Promise<RuntimeSidebarMutationResponse> {
      return client.post('/runtime-work/sidebar/projects/sync-remote', data)
    },
    activateRuntimeProject(
      data: RuntimeProjectActivateRequest
    ): Promise<RuntimeSidebarMutationResponse> {
      return client.post('/runtime-work/sidebar/projects/activate', data)
    },
    reorderRuntimeProjectTasks(
      data: RuntimeProjectTaskReorderRequest
    ): Promise<RuntimeSidebarMutationResponse> {
      return client.post('/runtime-work/sidebar/tasks/reorder', data)
    },
    setRuntimeTaskPinned(data: RuntimeTaskPinRequest): Promise<RuntimeSidebarMutationResponse> {
      return client.post('/runtime-work/sidebar/tasks/pin', data)
    },
    getWorktreeSettings(data: { deviceId: string }): Promise<RuntimeWorktreeSettings> {
      return client.post('/runtime-work/worktrees/settings', data)
    },
    updateWorktreeSettings(data: RuntimeWorktreeSettingsPatch): Promise<RuntimeWorktreeSettings> {
      return client.put('/runtime-work/worktrees/settings', data)
    },
    listWorktrees(data: { deviceId: string }): Promise<RuntimeWorktreeListResponse> {
      return client.post('/runtime-work/worktrees/list', data)
    },
    prepareWorktree(data: RuntimeWorktreePrepareRequest): Promise<RuntimeWorktreeMutationResponse> {
      return client.post('/runtime-work/worktrees/prepare', data)
    },
    deleteWorktree(data: RuntimeWorktreeDeleteRequest): Promise<RuntimeWorktreeMutationResponse> {
      return client.post('/runtime-work/worktrees/delete', data)
    },
    restoreWorktree(data: RuntimeWorktreeDeleteRequest): Promise<RuntimeWorktreeMutationResponse> {
      return client.post('/runtime-work/worktrees/restore', data)
    },
    bindRuntimeTaskImSessions(
      data: BindRuntimeTaskIMSessionsRequest
    ): Promise<BindRuntimeTaskIMSessionsResponse> {
      return client.post('/runtime-work/im-sessions', data)
    },
    getImNotificationSettings(): Promise<RuntimeIMNotificationSettingsResponse> {
      return client.get('/runtime-work/im-notifications')
    },
    updateGlobalImNotification(
      data: RuntimeGlobalIMNotificationUpdateRequest
    ): Promise<RuntimeIMNotificationSettingsResponse> {
      return client.put('/runtime-work/im-notifications/global', data)
    },
    updateImNotificationPresence(
      data: RuntimeIMNotificationPresenceUpdateRequest
    ): Promise<RuntimeIMNotificationPresenceResponse> {
      return client.put('/runtime-work/im-notifications/presence', data)
    },
    subscribeRuntimeTaskNotifications(
      data: RuntimeTaskIMNotificationSubscriptionRequest
    ): Promise<RuntimeTaskIMNotificationSubscriptionResponse> {
      return client.put('/runtime-work/im-notifications/runtime-task', data)
    },
    unsubscribeRuntimeTaskNotifications(
      address: RuntimeTaskAddress
    ): Promise<RuntimeTaskIMNotificationSubscriptionResponse> {
      return client.post('/runtime-work/im-notifications/runtime-task/unsubscribe', address)
    },
    archiveRuntimeTask(address: RuntimeTaskAddress): Promise<RuntimeTaskArchiveResponse> {
      return client.post('/runtime-work/archive', address)
    },
    renameRuntimeTask(data: RuntimeTaskRenameRequest): Promise<RuntimeTaskArchiveResponse> {
      return client.post('/runtime-work/rename', data)
    },
    listArchivedConversations(
      data: ArchivedConversationsListRequest = {}
    ): Promise<ArchivedConversationsListResponse> {
      return client.post('/runtime-work/archived-conversations/list', data)
    },
    archiveConversation(address: RuntimeTaskAddress): Promise<RuntimeTaskArchiveResponse> {
      return client.post('/runtime-work/archived-conversations/archive', address)
    },
    archiveProjectConversations(
      data: RuntimeArchiveProjectConversationsRequest
    ): Promise<RuntimeArchivedConversationBulkResponse> {
      return client.post('/runtime-work/archived-conversations/archive-project', data)
    },
    archiveAllConversations(): Promise<RuntimeArchivedConversationBulkResponse> {
      return client.post('/runtime-work/archived-conversations/archive-all', {})
    },
    unarchiveConversation(address: RuntimeTaskAddress): Promise<RuntimeTaskArchiveResponse> {
      return client.post('/runtime-work/archived-conversations/unarchive', address)
    },
    deleteArchivedConversation(address: RuntimeTaskAddress): Promise<RuntimeTaskArchiveResponse> {
      return client.post('/runtime-work/archived-conversations/delete', address)
    },
    deleteArchivedConversationsBulk(
      data: RuntimeArchivedConversationBulkRequest
    ): Promise<RuntimeArchivedConversationBulkResponse> {
      return client.post('/runtime-work/archived-conversations/delete-bulk', data)
    },
    previewArchivedConversationCleanup(
      data: RuntimeArchivedConversationBulkRequest
    ): Promise<RuntimeArchivedConversationCleanupResponse> {
      return client.post('/runtime-work/archived-conversations/cleanup-preview', data)
    },
    cleanupArchivedConversations(
      data: RuntimeArchivedConversationBulkRequest
    ): Promise<RuntimeArchivedConversationCleanupResponse> {
      return client.post('/runtime-work/archived-conversations/cleanup', data)
    },
    cancelRuntimeTask(address: RuntimeTaskAddress): Promise<RuntimeTaskCancelResponse> {
      return client.post('/runtime-work/cancel', address)
    },
    forceStartRuntimeTask(address: RuntimeTaskAddress): Promise<RuntimeTaskCancelResponse> {
      return client.post('/runtime-work/force-start', address)
    },
    reorderQueuedRuntimeTask(
      data: RuntimeTaskQueueReorderRequest
    ): Promise<RuntimeTaskQueueReorderResponse> {
      return client.post('/runtime-work/queue/reorder', data)
    },
    createRuntimeTask(data: RuntimeTaskCreateRequest): Promise<RuntimeTaskCreateResponse> {
      return client.post('/runtime-work/create', data)
    },
    forkRuntimeTask(data: RuntimeTaskForkRequest): Promise<RuntimeTaskForkResponse> {
      return client.post('/runtime-work/fork', data)
    },
  }
}
