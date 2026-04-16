import { apiClient } from './client'

export type QuotaData = {
  quota: number
  usage: number
  remaining: number
  usage_rate: number
  user: string
  quota_source?: string
}

export const quotaApis = {
  async fetchQuota(): Promise<QuotaData | null> {
    try {
      const response = await apiClient.get<{ data?: QuotaData; quota_source?: string }>(
        '/quota/claude/quota'
      )

      const data = response?.data
      if (data) {
        return {
          ...data,
          quota_source: response.quota_source || data.quota_source,
        }
      }

      return null
    } catch {
      return null
    }
  },
}
