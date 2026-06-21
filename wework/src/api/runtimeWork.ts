import type {
  BindRuntimeTaskIMSessionsRequest,
  BindRuntimeTaskIMSessionsResponse,
  DeviceWorkspaceResponse,
  DeviceWorkspaceUpsert,
  RuntimeSendRequest,
  RuntimeSendResponse,
  RuntimeTaskAddress,
  RuntimeTaskArchiveResponse,
  RuntimeTaskCreateRequest,
  RuntimeTaskCreateResponse,
  RuntimeTaskForkRequest,
  RuntimeTaskForkResponse,
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
