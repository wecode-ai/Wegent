import type { BindTaskIMSessionsResponse, IMPrivateSessionListResponse } from '@/types/api'
import type { HttpClient } from './http'

export function createImSessionApi(client: HttpClient) {
  return {
    listPrivateSessions(): Promise<IMPrivateSessionListResponse> {
      return client.get('/im/private-sessions')
    },
    bindTaskSessions(taskId: number, sessionKeys: string[]): Promise<BindTaskIMSessionsResponse> {
      return client.post(`/tasks/${taskId}/im-sessions`, {
        session_keys: sessionKeys,
      })
    },
  }
}
