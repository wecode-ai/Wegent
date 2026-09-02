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
})
