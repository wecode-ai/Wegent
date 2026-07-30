import { describe, expect, test, vi } from 'vitest'
import type { HttpClient } from './http'
import { createAutomationApi } from './automations'
import type { AutomationMutation } from '@/types/automation'

const mutation: AutomationMutation = {
  source: 'cloud',
  name: 'Daily brief',
  description: '',
  prompt: 'Summarize the project',
  schedule: { type: 'cron', expression: '0 9 * * 1-5' },
  timezone: 'Asia/Shanghai',
  enabled: true,
  conversationMode: 'independent',
  notificationPolicy: 'all_runs',
  taskRequest: {
    deviceId: 'cloud-device',
    workspacePath: '/workspace',
    teamId: 1,
    runtime: 'codex',
    message: 'Summarize the project',
  },
}

describe('createAutomationApi', () => {
  test('routes CRUD operations through runtime automation endpoints', async () => {
    const get = vi.fn().mockResolvedValue({ items: [] })
    const post = vi.fn().mockResolvedValue({})
    const put = vi.fn().mockResolvedValue({})
    const del = vi.fn().mockResolvedValue({ deleted: true })
    const api = createAutomationApi({ get, post, put, delete: del } as unknown as HttpClient)

    await api.listAutomations()
    await api.getAutomation('cloud:7')
    await api.createAutomation(mutation)
    await api.updateAutomation('cloud:7', mutation)
    await api.toggleAutomation('cloud:7', false)
    await api.runAutomationNow('cloud:7')
    await api.listAutomationRuns('cloud:7')
    await api.deleteAutomation('cloud:7')

    expect(get).toHaveBeenNthCalledWith(1, '/runtime-automations')
    expect(get).toHaveBeenNthCalledWith(2, '/runtime-automations/cloud:7')
    expect(post).toHaveBeenCalledWith('/runtime-automations', mutation)
    expect(put).toHaveBeenCalledWith('/runtime-automations/cloud:7', mutation)
    expect(post).toHaveBeenCalledWith('/runtime-automations/cloud:7/toggle', {
      enabled: false,
    })
    expect(post).toHaveBeenCalledWith('/runtime-automations/cloud:7/run', {})
    expect(get).toHaveBeenNthCalledWith(3, '/runtime-automations/runs?automation_id=cloud%3A7')
    expect(del).toHaveBeenCalledWith('/runtime-automations/cloud:7')
  })
})
