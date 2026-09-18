import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TeamProvider, useTeamContext } from '@/contexts/TeamContext'
import { teamApis } from '@/apis/team'
import { TEAM_FETCH_RETRY_DELAYS_MS } from '@/features/tasks/service/teamService'

jest.mock('@/apis/team', () => ({ teamApis: { getAllTeams: jest.fn() } }))
jest.mock('@/features/common/UserContext', () => ({ useUser: () => ({ user: { id: 1 } }) }))
const getAll = jest.mocked(teamApis.getAllTeams)
const wrapper = ({ children }: { children: ReactNode }) => <TeamProvider>{children}</TeamProvider>
beforeEach(() => {
  getAll.mockReset()
  getAll.mockResolvedValue({ total: 0, items: [] })
})

it('does not preload a catalog for consumers that only manage resources', async () => {
  const { result } = renderHook(() => useTeamContext({ enabled: false }), { wrapper })
  await act(async () => {})
  expect(getAll).not.toHaveBeenCalled()
  act(() => result.current.invalidateTeams())
  expect(getAll).not.toHaveBeenCalled()
})

it('loads when a selector needs data, shares it, and refreshes active consumers after invalidation', async () => {
  const { result } = renderHook(() => ({ first: useTeamContext(), second: useTeamContext() }), {
    wrapper,
  })
  await waitFor(() => expect(result.current.first.isTeamsLoading).toBe(false))
  expect(getAll).toHaveBeenCalledTimes(1)
  act(() => result.current.first.invalidateTeams())
  await waitFor(() => expect(result.current.first.isTeamsLoading).toBe(false))
  expect(getAll).toHaveBeenCalledTimes(2)
})

it('preserves the catalog and exposes a failed refresh after retries are exhausted', async () => {
  const team = { id: 1, updated_at: '2026-09-01T00:00:00Z' } as Awaited<
    ReturnType<typeof teamApis.getAllTeams>
  >['items'][number]
  getAll.mockResolvedValue({ total: 1, items: [team] })
  const { result } = renderHook(() => useTeamContext(), { wrapper })
  await waitFor(() => expect(result.current.teams).toEqual([team]))

  jest.useFakeTimers()
  const error = new Error('Catalog unavailable')
  const log = jest.spyOn(console, 'error').mockImplementation(() => {})
  getAll.mockRejectedValue(error)
  try {
    await act(async () => {
      const refresh = result.current.refreshTeams()
      const assertion = expect(refresh).rejects.toBe(error)
      await jest.advanceTimersByTimeAsync(
        TEAM_FETCH_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)
      )
      await assertion
    })
    expect(result.current.teams).toEqual([team])
    expect(result.current.loadError).toBe(error)
    expect(result.current.isTeamsLoading).toBe(false)
    expect(getAll).toHaveBeenCalledTimes(4)

    getAll.mockResolvedValue({ total: 1, items: [team] })
    await act(async () => {
      await result.current.refreshTeams()
    })
    expect(result.current.loadError).toBeNull()
  } finally {
    log.mockRestore()
    jest.useRealTimers()
  }
})

it('cancels an in-flight catalog when its provider unmounts', async () => {
  getAll.mockImplementation(() => new Promise(() => {}))
  const { unmount } = renderHook(() => useTeamContext(), { wrapper })
  const signal = getAll.mock.calls[0][3]?.signal
  expect(signal?.aborted).toBe(false)
  unmount()
  expect(signal?.aborted).toBe(true)
})
