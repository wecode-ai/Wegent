import { describe, expect, test, vi } from 'vitest'
import type { HttpClient } from './http'
import { createTeamApi } from './teams'

describe('createTeamApi', () => {
  test('loads an execution profile directly by id', async () => {
    const get = vi.fn().mockResolvedValue({
      id: 108,
      name: 'restored-team',
      namespace: 'engineering',
      updated_at: '2026-09-02T10:00:00Z',
      workflow: { mode: 'pipeline' },
      bots: [],
    })
    const api = createTeamApi({ get } as unknown as HttpClient)

    await expect(api.getExecutionProfile(108)).resolves.toMatchObject({
      id: 108,
      namespace: 'engineering',
      collaborationMode: 'pipeline',
    })
    expect(get).toHaveBeenCalledWith('/teams/108')
  })
})
