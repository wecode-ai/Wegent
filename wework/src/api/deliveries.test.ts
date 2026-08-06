import { describe, expect, it, vi } from 'vitest'
import type { HttpClient } from './http'
import { createDeliveryApi } from './deliveries'

describe('createDeliveryApi queue and assignment routes', () => {
  it('lists loop items with queue filters', async () => {
    const client = {
      get: vi.fn(async () => ({ items: [] })),
    } as unknown as HttpClient
    const api = createDeliveryApi(client)

    await api.listLoopItems(123, {
      assigneeType: 'agent',
      assigneeId: 'bot-1',
      executionState: 'queued',
    })

    expect(client.get).toHaveBeenCalledWith(
      '/v1/cloud-projects/123/loop-items?assignee_type=agent&assignee_id=bot-1&execution_state=queued'
    )
  })

  it('assigns a task to a robot through the project route', async () => {
    const client = {
      post: vi.fn(async () => ({})),
    } as unknown as HttpClient
    const api = createDeliveryApi(client)

    await api.assignLoopItem(123, 'task-1', {
      version: 3,
      assigneeType: 'agent',
      assigneeId: 'bot-1',
    })

    expect(client.post).toHaveBeenCalledWith('/v1/cloud-projects/123/loop-items/task-1/assign', {
      version: 3,
      assigneeType: 'agent',
      assigneeId: 'bot-1',
    })
  })

  it('approves and rejects pending robot runs', async () => {
    const client = {
      post: vi.fn(async () => ({})),
    } as unknown as HttpClient
    const api = createDeliveryApi(client)

    await api.approveLoopItemRun(123, 'task-1', 4)
    await api.rejectLoopItemRun(123, 'task-1', 4, 'not now')

    expect(client.post).toHaveBeenNthCalledWith(
      1,
      '/v1/cloud-projects/123/loop-items/task-1/approve',
      { version: 4 }
    )
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      '/v1/cloud-projects/123/loop-items/task-1/reject',
      { version: 4, reason: 'not now' }
    )
  })
})
