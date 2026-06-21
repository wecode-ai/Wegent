import type { IMPrivateSessionListResponse } from '@/types/api'
import type { HttpClient } from './http'

export function createImSessionApi(client: HttpClient) {
  return {
    listPrivateSessions(): Promise<IMPrivateSessionListResponse> {
      return client.get('/im/private-sessions')
    },
  }
}
