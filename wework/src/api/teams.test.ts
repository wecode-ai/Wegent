import { describe, expect, test, vi } from 'vitest'
import type { Team } from '@/types/api'
import type { HttpClient } from './http'
import { createTeamApi } from './teams'

describe('createTeamApi', () => {
  test('materializes an execution profile from Team detail', async () => {
    const get = vi.fn().mockResolvedValue({
      id: 7,
      name: 'review-team',
      updated_at: '2026-09-02T10:00:00Z',
      workflow: { mode: 'coordinate' },
      bots: [],
    })
    const api = createTeamApi({ get } as unknown as HttpClient)
    const team: Team = {
      id: 7,
      name: 'review-team',
      namespace: 'engineering',
      is_active: true,
    }

    await expect(api.getExecutionProfile(team)).resolves.toEqual({
      id: 7,
      name: 'review-team',
      namespace: 'engineering',
      updatedAt: '2026-09-02T10:00:00Z',
      collaborationMode: 'coordinate',
      bots: [],
    })
    expect(get).toHaveBeenCalledWith('/teams/7')
  })

  test('loads a persisted Team binding directly by id', async () => {
    const get = vi.fn().mockResolvedValue({
      id: 108,
      name: 'restored-team',
      updated_at: '2026-09-02T10:00:00Z',
      workflow: { mode: 'pipeline' },
      bots: [],
    })
    const api = createTeamApi({ get } as unknown as HttpClient)

    await expect(api.getExecutionProfile(108)).resolves.toMatchObject({
      id: 108,
      namespace: 'default',
      collaborationMode: 'pipeline',
    })
    expect(get).toHaveBeenCalledWith('/teams/108')
  })
})
