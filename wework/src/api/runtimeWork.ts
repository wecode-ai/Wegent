import type {
  BindRuntimeTaskIMSessionsRequest,
  BindRuntimeTaskIMSessionsResponse,
  DeleteDeviceWorkspaceRequest,
  DeleteDeviceWorkspaceResponse,
  DeviceWorkspaceResponse,
  DeviceWorkspacePrepareRequest,
  DeviceWorkspacePrepareResponse,
  DeviceWorkspaceUpsert,
  RuntimeGlobalIMNotificationUpdateRequest,
  RuntimeIMNotificationSettingsResponse,
  RuntimeSendRequest,
  RuntimeSendResponse,
  RuntimeTaskAddress,
  RuntimeTaskArchiveResponse,
  RuntimeTaskCreateRequest,
  RuntimeTaskCreateResponse,
  RuntimeTaskForkRequest,
  RuntimeTaskForkResponse,
  RuntimeTaskIMNotificationSubscriptionRequest,
  RuntimeTaskIMNotificationSubscriptionResponse,
  RuntimeTranscriptRequest,
  RuntimeTranscriptResponse,
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
    sendRuntimeMessage(data: RuntimeSendRequest): Promise<RuntimeSendResponse> {
      return client.post('/runtime-work/send', data)
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
    createRuntimeTask(data: RuntimeTaskCreateRequest): Promise<RuntimeTaskCreateResponse> {
      return client.post('/runtime-work/create', data)
    },
    forkRuntimeTask(data: RuntimeTaskForkRequest): Promise<RuntimeTaskForkResponse> {
      return client.post('/runtime-work/fork', data)
    },
  }
}
