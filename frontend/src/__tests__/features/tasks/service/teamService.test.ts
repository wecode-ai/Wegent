// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { teamApis } from '@/apis/team'
import { TEAM_FETCH_RETRY_DELAYS_MS, teamService } from '@/features/tasks/service/teamService'
import type { Team } from '@/types/api'

jest.mock('@/apis/team', () => ({
  teamApis: {
    getAllTeams: jest.fn(),
  },
}))

const mockGetAllTeams = teamApis.getAllTeams as jest.MockedFunction<typeof teamApis.getAllTeams>

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
    mockGetAllTeams.mockRejectedValueOnce(new Error('network error'))
    mockGetAllTeams.mockResolvedValueOnce({ total: 1, items: [makeTeam(1)] })

    const request = teamService.fetchTeamsWithRetry()
    await jest.advanceTimersByTimeAsync(TEAM_FETCH_RETRY_DELAYS_MS[0])

    await expect(request).resolves.toEqual([makeTeam(1)])
    expect(mockGetAllTeams).toHaveBeenCalledTimes(2)
  })

  it('throws after every retry is exhausted', async () => {
    mockGetAllTeams.mockRejectedValue(new Error('network error'))

    const request = teamService.fetchTeamsWithRetry()
    const assertion = expect(request).rejects.toThrow('network error')
    await jest.advanceTimersByTimeAsync(
      TEAM_FETCH_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)
    )

    await assertion
    expect(mockGetAllTeams).toHaveBeenCalledTimes(TEAM_FETCH_RETRY_DELAYS_MS.length + 1)
  })

  it('aborts pending retries when the signal is aborted', async () => {
    mockGetAllTeams.mockRejectedValue(new Error('network error'))

    const abortController = new AbortController()
    const request = teamService.fetchTeamsWithRetry(abortController.signal)
    const assertion = expect(request).rejects.toThrow('Aborted')

    abortController.abort()

    await assertion
    expect(mockGetAllTeams).toHaveBeenCalledTimes(1)
  })

  it('does not send another request after aborting during a retry delay', async () => {
    mockGetAllTeams.mockRejectedValueOnce(new Error('network error'))
    mockGetAllTeams.mockResolvedValueOnce({ total: 1, items: [makeTeam(1)] })

    const abortController = new AbortController()
    const request = teamService.fetchTeamsWithRetry(abortController.signal)
    const assertion = expect(request).rejects.toThrow('Aborted')

    await jest.advanceTimersByTimeAsync(TEAM_FETCH_RETRY_DELAYS_MS[0] - 1)
    abortController.abort()

    await assertion
    expect(mockGetAllTeams).toHaveBeenCalledTimes(1)
  })
})
