import type {
  LocalCodexBindRequest,
  LocalCodexBindResponse,
  LocalCodexThreadListResponse,
  LocalCodexThreadSummary,
} from '@/types/api'
import type { HttpClient } from './http'

export function createLocalCodexApi(client: HttpClient) {
  return {
    async listLocalCodexThreads(
      deviceId: string,
      limit = 50,
    ): Promise<LocalCodexThreadSummary[]> {
      const query = new URLSearchParams()
      query.set('limit', String(limit))
      const response = await client.get<LocalCodexThreadListResponse>(
        `/local-codex/devices/${encodeURIComponent(deviceId)}/threads?${query.toString()}`,
      )
      return response.threads
    },
    bindLocalCodexThread(
      request: LocalCodexBindRequest,
    ): Promise<LocalCodexBindResponse> {
      return client.post<LocalCodexBindResponse>('/local-codex/threads/bind', request)
    },
  }
}
