import { apiClient } from './client'

export type QuotaData = {
  quota: number
  remaining: number
  usage: number
  user: string
  user_quota_detail: {
    demand_quota: number
    monthly_quota: number
    monthly_usage: number
    permanent_quota: number
    permanent_usage: number
    task_quota: number
  }
}

export const copilotApis = {
  async fetchQuota(): Promise<QuotaData | null> {
    try {
      const json = await apiClient.get<any>('/copilot/claude/quota')
      if (json.status === 'success') {
        return json.data
      }
      return null
    } catch (e) {
      return null
    }
  }
}