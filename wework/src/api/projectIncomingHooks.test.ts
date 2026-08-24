import { describe, expect, test, vi } from 'vitest'
import type { HttpClient } from './http'
import { createProjectIncomingHookApi } from './projectIncomingHooks'

describe('createProjectIncomingHookApi', () => {
  test('uses project-scoped management endpoints', async () => {
    const client = {
      get: vi.fn().mockResolvedValue([]),
      post: vi.fn().mockResolvedValue({ id: 'hook-1' }),
      patch: vi.fn().mockResolvedValue({ id: 'hook-1', status: 'disabled' }),
    } as unknown as HttpClient
    const api = createProjectIncomingHookApi(client)

    await api.list('project-1')
    await api.create('project-1', 'GitHub')
    await api.update('project-1', 'hook-1', { version: 1, status: 'disabled' })
    await api.rotate('project-1', 'hook-1')

    expect(client.get).toHaveBeenCalledWith('/v1/cloud-projects/project-1/incoming-hooks')
    expect(client.post).toHaveBeenNthCalledWith(1, '/v1/cloud-projects/project-1/incoming-hooks', {
      name: 'GitHub',
    })
    expect(client.patch).toHaveBeenCalledWith(
      '/v1/cloud-projects/project-1/incoming-hooks/hook-1',
      { version: 1, status: 'disabled' }
    )
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      '/v1/cloud-projects/project-1/incoming-hooks/hook-1/rotate'
    )
  })
})
