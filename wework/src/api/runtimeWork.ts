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
  RuntimeFileChangesRevertRequest,
  RuntimeFileChangesRevertResponse,
  RuntimeIMNotificationSettingsResponse,
  RuntimeArchiveProjectConversationsRequest,
  RuntimeArchivedConversationBulkRequest,
  RuntimeArchivedConversationBulkResponse,
  RuntimeSendRequest,
  RuntimeSendResponse,
  RuntimeTaskAddress,
  RuntimeTaskArchiveResponse,
  RuntimeTaskCancelResponse,
  RuntimeTaskCreateRequest,
  RuntimeTaskCreateResponse,
  RuntimeTaskForkRequest,
  RuntimeTaskForkResponse,
  RuntimeTaskRenameRequest,
  RuntimeTaskIMNotificationSubscriptionRequest,
  RuntimeTaskIMNotificationSubscriptionResponse,
  RuntimeTranscriptRequest,
  RuntimeTranscriptResponse,
  RuntimeWorkSearchRequest,
  RuntimeWorkSearchResponse,
  RuntimeWorkspaceOpenRequest,
  RuntimeWorkspaceOpenResponse,
  RuntimeWorkspaceRemoveRequest,
  RuntimeWorkspaceRenameRequest,
  RuntimeWorkListResponse,
} from '@/types/api'
import type { HttpClient } from './http'

export function createRuntimeWorkApi(client: HttpClient) {
  return {
    listRuntimeWork(): Promise<RuntimeWorkListResponse> {
      return client.get('/runtime-work')
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
    revertRuntimeFileChanges(
      request: RuntimeFileChangesRevertRequest
    ): Promise<RuntimeFileChangesRevertResponse> {
      return client.post('/runtime-work/file-changes/revert', request)
    },
    sendRuntimeMessage(data: RuntimeSendRequest): Promise<RuntimeSendResponse> {
      return client.post('/runtime-work/send', data)
    },
    openRuntimeWorkspace(data: RuntimeWorkspaceOpenRequest): Promise<RuntimeWorkspaceOpenResponse> {
      return client.post('/runtime-work/workspaces/open', data)
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
    cancelRuntimeTask(address: RuntimeTaskAddress): Promise<RuntimeTaskCancelResponse> {
      return client.post('/runtime-work/cancel', address)
    },
    createRuntimeTask(data: RuntimeTaskCreateRequest): Promise<RuntimeTaskCreateResponse> {
      return client.post('/runtime-work/create', data)
    },
    forkRuntimeTask(data: RuntimeTaskForkRequest): Promise<RuntimeTaskForkResponse> {
      return client.post('/runtime-work/fork', data)
    },
  }
}
