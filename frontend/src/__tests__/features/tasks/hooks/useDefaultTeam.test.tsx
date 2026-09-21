import { act, renderHook, waitFor } from '@testing-library/react'
import { teamApis } from '@/apis/team'
import { useDefaultTeam } from '@/features/tasks/hooks/useDefaultTeam'
import type { Team, TaskType } from '@/types/api'

let mockUserId = 1
jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: { id: mockUserId } }),
}))
jest.mock('@/apis/team', () => ({ teamApis: { getDefaultTeam: jest.fn() } }))
const team = { id: 10, name: 'default', default_for_modes: ['chat'] } as Team
const fetchDefault = jest.mocked(teamApis.getDefaultTeam)

beforeEach(() => {
  mockUserId = 1
  fetchDefault.mockReset()
})

it('resolves independently of the catalog and stops contributing after the catalog finishes', async () => {
  fetchDefault.mockResolvedValue(team)
  const { result, rerender } = renderHook(({ enabled }) => useDefaultTeam('chat', enabled), {
    initialProps: { enabled: true },
  })
  await waitFor(() => expect(result.current).toBe(team))
  expect(fetchDefault).toHaveBeenCalledWith('chat', expect.any(AbortSignal))
  rerender({ enabled: false })
  expect(result.current).toBeNull()
  expect(fetchDefault).toHaveBeenCalledTimes(1)
})

it('ignores stale responses when switching from chat to code', async () => {
  let resolveChat!: (value: Team) => void
  fetchDefault.mockReturnValueOnce(
    new Promise(resolve => {
      resolveChat = resolve
    })
  )
  fetchDefault.mockResolvedValueOnce({ ...team, id: 20 })
  const { result, rerender } = renderHook(
    ({ mode }: { mode: TaskType }) => useDefaultTeam(mode, true),
    { initialProps: { mode: 'chat' as TaskType } }
  )
  const chatSignal = fetchDefault.mock.calls[0][1]
  rerender({ mode: 'code' })
  await waitFor(() => expect(result.current?.id).toBe(20))
  await act(async () => resolveChat(team))
  expect(chatSignal?.aborted).toBe(true)
  expect(result.current?.id).toBe(20)
  mockUserId = 2
  fetchDefault.mockResolvedValue(null)
  rerender({ mode: 'code' })
  expect(result.current).toBeNull()
})

it('does not fetch for an explicit selection, completed catalog, or generation mode', () => {
  renderHook(() => useDefaultTeam('chat', false))
  renderHook(() => useDefaultTeam('video', true))
  expect(fetchDefault).not.toHaveBeenCalled()
})

it('leaves list-based selection available if no default is configured or the request fails', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {})
  fetchDefault.mockRejectedValue(new Error('Unavailable'))
  const { result } = renderHook(() => useDefaultTeam('chat', true))
  await waitFor(() => expect(log).toHaveBeenCalled())
  expect(result.current).toBeNull()
  log.mockRestore()
})
