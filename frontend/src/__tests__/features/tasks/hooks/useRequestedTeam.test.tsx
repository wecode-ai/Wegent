import { act, renderHook, waitFor } from '@testing-library/react'
import { teamApis } from '@/apis/team'
import { useRequestedTeam } from '@/features/tasks/hooks/useRequestedTeam'
import type { Team } from '@/types/api'

let mockUserId = 1
jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: mockUserId } }),
}))
jest.mock('@/apis/team', () => ({ teamApis: { getTeam: jest.fn() } }))
const fetchTeam = jest.mocked(teamApis.getTeam)

beforeEach(() => {
  mockUserId = 1
  fetchTeam.mockReset()
})

it('resolves the requested agent even when catalog pagination omitted it', async () => {
  const team = { id: 10, name: 'requested' } as Team
  fetchTeam.mockResolvedValue(team)
  const { result } = renderHook(() => useRequestedTeam('10', true))
  await waitFor(() => expect(result.current).toBe(team))
  expect(fetchTeam).toHaveBeenCalledWith(10)
})

it('ignores a late response after navigating to a different agent or user', async () => {
  let resolveFirst!: (team: Team) => void
  fetchTeam.mockReturnValueOnce(
    new Promise(resolve => {
      resolveFirst = resolve
    })
  )
  fetchTeam.mockResolvedValueOnce({ id: 20 } as Team)
  const { result, rerender } = renderHook(({ id }) => useRequestedTeam(id, true), {
    initialProps: { id: '10' },
  })
  rerender({ id: '20' })
  await waitFor(() => expect(result.current?.id).toBe(20))
  await act(async () => resolveFirst({ id: 10 } as Team))
  expect(result.current?.id).toBe(20)
  mockUserId = 2
  fetchTeam.mockReturnValue(new Promise(() => {}))
  rerender({ id: '20' })
  expect(result.current).toBeNull()
})

it('does not fetch absent, invalid, or disabled selections', () => {
  for (const id of [null, '', 'bad', '-1', '1.5']) renderHook(() => useRequestedTeam(id, true))
  renderHook(() => useRequestedTeam('10', false))
  expect(fetchTeam).not.toHaveBeenCalled()
})
