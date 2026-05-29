import type { HttpClient } from './http'

export interface QuotaData {
  quota: number
  usage: number
  remaining: number
  usage_rate: number
  user: string
  quota_source?: string
}

interface QuotaResponse {
  data?: QuotaData
  quota_source?: string
}

export interface QuotaApi {
  fetchQuota(): Promise<QuotaData | null>
}

export function createQuotaApi(client: HttpClient): QuotaApi {
  return {
    async fetchQuota(): Promise<QuotaData | null> {
      const response = await client.get<QuotaResponse>('/quota/claude/quota')
      if (!response.data) {
        return null
      }

      return {
        ...response.data,
        quota_source: response.quota_source || response.data.quota_source,
      }
    },
  }
}
