import { describe, expect, it, vi } from 'vitest'
import type { HttpClient } from './http'
import { createProjectChatAgentApi } from './projectChatAgents'

describe('createProjectChatAgentApi', () => {
  it('uses the versioned cloud project routes', async () => {
    const client = {
      get: vi.fn(async () => []),
      post: vi.fn(async () => ({})),
      patch: vi.fn(async () => ({})),
    } as unknown as HttpClient
    const api = createProjectChatAgentApi(client)
    const input = { name: 'Reviewer', runtime: 'codex' as const, model: null, systemPrompt: '' }

    await api.list('123')
    await api.create('123', input)
    await api.update('123', '456', { version: 1, name: 'Builder' })

    expect(client.get).toHaveBeenCalledWith('/v1/cloud-projects/123/chat-agents')
    expect(client.post).toHaveBeenCalledWith('/v1/cloud-projects/123/chat-agents', input)
    expect(client.patch).toHaveBeenCalledWith('/v1/cloud-projects/123/chat-agents/456', {
      version: 1,
      name: 'Builder',
    })
  })
})
