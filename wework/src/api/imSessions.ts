import type { IMPrivateSessionListResponse, IMStandInBinding } from '@/types/api'
import type { HttpClient } from './http'

export function createImSessionApi(client: HttpClient) {
  return {
    bindStandIn(sessionKey: string, binding: IMStandInBinding): Promise<IMStandInBinding> {
      return client.put(`/im/private-sessions/${encodeURIComponent(sessionKey)}/stand-in`, binding)
    },
    listPrivateSessions(): Promise<IMPrivateSessionListResponse> {
      return client.get('/im/private-sessions')
    },
  }
}
