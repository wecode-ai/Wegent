import type {
  DeviceWorkspaceResponse,
  DeviceWorkspaceUpsert,
  RuntimeSendRequest,
  RuntimeSendResponse,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  RuntimeTaskCreateResponse,
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
    createRuntimeTask(data: RuntimeTaskCreateRequest): Promise<RuntimeTaskCreateResponse> {
      return client.post('/runtime-work/create', data)
    },
  }
}
