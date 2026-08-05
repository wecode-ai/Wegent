import type { HttpClient } from './http'

export interface QuotaData {
  open?: boolean
  quota: number
  usage: number
  remaining: number
  usage_rate: number
  user: string
  quota_source?: string
  user_quota_detail?: {
    demand_quota: number
    monthly_quota: number
    monthly_usage: number
    permanent_quota: number
    permanent_usage: number
    task_quota: number
  }
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
