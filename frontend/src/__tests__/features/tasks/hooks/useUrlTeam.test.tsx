import { act, renderHook, waitFor } from '@testing-library/react'
import { teamApis } from '@/apis/team'
import { useUrlTeam } from '@/features/tasks/hooks/useUrlTeam'
import type { Team } from '@/types/api'

let mockUserId = 1
jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: mockUserId } }),
}))
jest.mock('@/apis/team', () => ({ teamApis: { getTeam: jest.fn() } }))
const team = { id: 65, name: 'URL agent', bind_mode: ['chat'] } as Team
const getTeam = jest.mocked(teamApis.getTeam)

beforeEach(() => {
  mockUserId = 1
  getTeam.mockReset()
})

it('reads an explicit agent independently of the paginated catalog', async () => {
  getTeam.mockResolvedValue(team)
  const { result } = renderHook(() => useUrlTeam('65', true))
  await waitFor(() => expect(result.current).toBe(team))
  expect(getTeam).toHaveBeenCalledWith(65, expect.any(AbortSignal))
})

it('ignores stale responses after URL and account changes', async () => {
  let resolveOld!: (team: Team) => void
  getTeam.mockReturnValueOnce(new Promise(resolve => (resolveOld = resolve)))
  getTeam.mockResolvedValueOnce({ ...team, id: 66 })
  const { result, rerender } = renderHook(({ id }) => useUrlTeam(id, true), {
    initialProps: { id: '65' },
  })
  const signal = getTeam.mock.calls[0][1]
  rerender({ id: '66' })
  await waitFor(() => expect(result.current?.id).toBe(66))
  await act(async () => resolveOld(team))
  expect(signal?.aborted).toBe(true)
  expect(result.current?.id).toBe(66)

  mockUserId = 2
  getTeam.mockReturnValueOnce(new Promise(() => {}))
  rerender({ id: '66' })
  expect(result.current).toBeNull()
})

it.each([null, '', 'bad', '0', '-1', '1.5'])('does not request an invalid ID: %s', id => {
  renderHook(() => useUrlTeam(id, true))
  expect(getTeam).not.toHaveBeenCalled()
})

it('does not contribute to an existing task or after leaving the explicit URL', async () => {
  getTeam.mockResolvedValue(team)
  const { result, rerender } = renderHook(({ enabled }) => useUrlTeam('65', enabled), {
    initialProps: { enabled: false },
  })
  expect(getTeam).not.toHaveBeenCalled()
  rerender({ enabled: true })
  await waitFor(() => expect(result.current).toBe(team))
  rerender({ enabled: false })
  expect(result.current).toBeNull()
})

it('does not replace an unavailable explicit agent with a catalog default', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {})
  getTeam.mockRejectedValue(new Error('Forbidden'))
  const { result } = renderHook(() => useUrlTeam('65', true))
  await waitFor(() => expect(log).toHaveBeenCalled())
  expect(result.current).toBeNull()
  log.mockRestore()
})
