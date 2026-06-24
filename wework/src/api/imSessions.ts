import type { IMBotPurpose, IMPrivateSessionListResponse } from '@/types/api'
import type { HttpClient } from './http'

export function createImSessionApi(client: HttpClient) {
  return {
    listPrivateSessions(botPurpose?: IMBotPurpose): Promise<IMPrivateSessionListResponse> {
      const query = botPurpose ? `?bot_purpose=${encodeURIComponent(botPurpose)}` : ''
      return client.get(`/im/private-sessions${query}`)
    },
  }
}
