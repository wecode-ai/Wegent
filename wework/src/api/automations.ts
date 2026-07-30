import type {
  Automation,
  AutomationListResponse,
  AutomationMutation,
  AutomationRun,
  AutomationRunListResponse,
} from '@/types/automation'
import type { HttpClient } from './http'

export function createAutomationApi(client: HttpClient) {
  return {
    listAutomations(): Promise<AutomationListResponse> {
      return client.get('/runtime-automations')
    },
    getAutomation(automationId: string): Promise<{ automation: Automation }> {
      return client.get(`/runtime-automations/${automationId}`)
    },
    createAutomation(data: AutomationMutation): Promise<{ automation: Automation }> {
      return client.post('/runtime-automations', data)
    },
    updateAutomation(
      automationId: string,
      data: AutomationMutation
    ): Promise<{ automation: Automation }> {
      return client.put(`/runtime-automations/${automationId}`, data)
    },
    deleteAutomation(automationId: string): Promise<{ deleted: boolean }> {
      return client.delete(`/runtime-automations/${automationId}`)
    },
    toggleAutomation(automationId: string, enabled: boolean): Promise<{ automation: Automation }> {
      return client.post(`/runtime-automations/${automationId}/toggle`, { enabled })
    },
    runAutomationNow(automationId: string): Promise<{ run: AutomationRun | null }> {
      return client.post(`/runtime-automations/${automationId}/run`, {})
    },
    listAutomationRuns(automationId?: string): Promise<AutomationRunListResponse> {
      const query = automationId ? `?automation_id=${encodeURIComponent(automationId)}` : ''
      return client.get(`/runtime-automations/runs${query}`)
    },
  }
}
