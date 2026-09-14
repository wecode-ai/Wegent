// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { teamApis } from '@/apis/team'
import { TEAM_FETCH_RETRY_DELAYS_MS, teamService } from '@/features/tasks/service/teamService'
import type { Team } from '@/types/api'

jest.mock('@/apis/team', () => ({
  teamApis: {
    getTeams: jest.fn(),
  },
}))

const mockGetTeams = teamApis.getTeams as jest.MockedFunction<typeof teamApis.getTeams>

const makeTeam = (id: number): Team => ({
  id,
  name: `team-${id}`,
  namespace: 'default',
  description: '',
  bots: [],
  workflow: {},
  is_active: true,
  user_id: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
})

describe('teamService.fetchTeamsWithRetry', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('retries a transient failure and returns the team list', async () => {
    mockGetTeams.mockRejectedValueOnce(new Error('network error'))
    mockGetTeams.mockResolvedValueOnce({ total: 1, items: [makeTeam(1)] })

    const request = teamService.fetchTeamsWithRetry()
    await jest.advanceTimersByTimeAsync(TEAM_FETCH_RETRY_DELAYS_MS[0])

    await expect(request).resolves.toEqual([makeTeam(1)])
    expect(mockGetTeams).toHaveBeenCalledTimes(2)
  })

  it('throws after every retry is exhausted', async () => {
    mockGetTeams.mockRejectedValue(new Error('network error'))

    const request = teamService.fetchTeamsWithRetry()
    const assertion = expect(request).rejects.toThrow('network error')
    await jest.advanceTimersByTimeAsync(
      TEAM_FETCH_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)
    )

    await assertion
    expect(mockGetTeams).toHaveBeenCalledTimes(TEAM_FETCH_RETRY_DELAYS_MS.length + 1)
  })

  it('aborts pending retries when the signal is aborted', async () => {
    mockGetTeams.mockRejectedValue(new Error('network error'))

    const abortController = new AbortController()
    const request = teamService.fetchTeamsWithRetry(abortController.signal)
    const assertion = expect(request).rejects.toThrow('Aborted')

    abortController.abort()

    await assertion
    expect(mockGetTeams).toHaveBeenCalledTimes(1)
  })

  it('does not send another request after aborting during a retry delay', async () => {
    mockGetTeams.mockRejectedValueOnce(new Error('network error'))
    mockGetTeams.mockResolvedValueOnce({ total: 1, items: [makeTeam(1)] })

    const abortController = new AbortController()
    const request = teamService.fetchTeamsWithRetry(abortController.signal)
    const assertion = expect(request).rejects.toThrow('Aborted')

    await jest.advanceTimersByTimeAsync(TEAM_FETCH_RETRY_DELAYS_MS[0] - 1)
    abortController.abort()

    await assertion
    expect(mockGetTeams).toHaveBeenCalledTimes(1)
  })
})
