import { describe, expect, it, vi } from 'vitest'
import type { HttpClient } from './http'
import { createProjectAutomationApi } from './projectAutomations'

function clientWithClaim(row: Record<string, unknown>): HttpClient {
  return {
    get: vi.fn(),
    getBlob: vi.fn(),
    post: vi.fn(async () => row),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }
}

describe('createProjectAutomationApi', () => {
  it('maps only the transient runtime payload returned by a device claim', async () => {
    const runtimePayload = {
      taskId: 'codex-queue-9',
      modelId: 'local-model',
      bot: [{ id: 'agent-1', name: 'Board robot', shell_type: 'Codex' }],
    }
    const client = clientWithClaim({
      id: 9,
      loopItemId: 'TASK-9',
      cloudProjectId: 'project-1',
      taskTitle: 'Handle task',
      agentId: 'agent-1',
      executionEnvironment: 'local',
      executionDeviceId: 'local-device',
      status: 'running',
      runtimeTaskId: 'codex-queue-9',
      runtimePayload,
      executionPayload: { modelId: 'persisted-legacy-model' },
      version: 1,
      createdAt: '2026-08-13T00:00:00Z',
      updatedAt: '2026-08-13T00:00:00Z',
    })

    const claimed = await createProjectAutomationApi(client).claimNext({
      execution_device_id: 'local-device',
      device_capacity: 5,
      lease_seconds: 300,
    })

    expect(claimed?.runtime_payload).toEqual(runtimePayload)
    expect(claimed?.agent_name).toBe('Board robot')
    expect(claimed?.agent_model).toBe('local-model')
    expect(claimed).not.toHaveProperty('execution_payload')
  })

  it('does not revive a removed persisted execution payload field', async () => {
    const client = clientWithClaim({
      id: 9,
      loopItemId: 'TASK-9',
      cloudProjectId: 'project-1',
      taskTitle: 'Handle task',
      executionPayload: { modelId: 'persisted-legacy-model' },
    })

    const claimed = await createProjectAutomationApi(client).claimNext({
      execution_device_id: 'local-device',
      device_capacity: 5,
      lease_seconds: 300,
    })

    expect(claimed?.runtime_payload).toBeNull()
    expect(claimed?.agent_model).toBeNull()
  })
})
