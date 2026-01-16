import { apiClient } from './client'

export type QuotaData = {
  open?: boolean
  quota: number
  remaining: number
  usage: number
  user: string
  quota_source?: string
  user_quota_detail: {
    demand_quota: number
    monthly_quota: number
    monthly_usage: number
    permanent_quota: number
    permanent_usage: number
    task_quota: number
  }
}

export const quotaApis = {
  async fetchQuota(): Promise<QuotaData | null> {
    try {
      const response = await apiClient.get<{ data?: QuotaData; quota_source?: string }>(
        '/quota/claude/quota'
      )

      // Check response structure and extract actual data from data field
      const data = response?.data
      if (data) {
        // Merge quota_source from response root level to data, return QuotaData compliant object
        return {
          ...data,
          quota_source: response.quota_source || data.quota_source,
        }
      }

      // Return null for empty object or missing required fields
      return null
    } catch {
      return null
    }
  },
}
