import type {
  BindRuntimeTaskIMSessionsRequest,
  BindRuntimeTaskIMSessionsResponse,
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
  RuntimeTranscriptResponse,
  RuntimeWorkListResponse,
} from '@/types/api'
import type { HttpClient } from './http'

const WEWORK_CLIENT_ORIGIN = 'wework'

function withClientOrigin(path: string): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}client_origin=${WEWORK_CLIENT_ORIGIN}`
}

export function createRuntimeWorkApi(client: HttpClient) {
  return {
    listRuntimeWork(): Promise<RuntimeWorkListResponse> {
      return client.get(withClientOrigin('/runtime-work'))
    },
    upsertDeviceWorkspace(data: DeviceWorkspaceUpsert): Promise<DeviceWorkspaceResponse> {
      return client.post('/runtime-work/device-workspaces', data)
    },
    prepareDeviceWorkspace(
      data: DeviceWorkspacePrepareRequest
    ): Promise<DeviceWorkspacePrepareResponse> {
      return client.post('/runtime-work/device-workspaces/prepare', data)
    },
    getRuntimeTranscript(address: RuntimeTaskAddress): Promise<RuntimeTranscriptResponse> {
      return client.post('/runtime-work/transcript', address)
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
