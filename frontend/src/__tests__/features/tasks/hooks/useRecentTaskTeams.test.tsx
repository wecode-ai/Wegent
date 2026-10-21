import { act, renderHook, waitFor } from '@testing-library/react'
import { userApis } from '@/apis/user'
import { useRecentTaskTeams } from '@/features/tasks/hooks/useRecentTaskTeams'
import type { QuickAccessTeam, TaskType } from '@/types/api'

let mockUserId: number | undefined = 1
jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: mockUserId === undefined ? null : { id: mockUserId } }),
}))
jest.mock('@/apis/user', () => ({ userApis: { getRecentTeams: jest.fn() } }))

const fetchRecent = jest.mocked(userApis.getRecentTeams)
const modes: TaskType[] = ['chat', 'code', 'knowledge', 'task', 'video', 'image']
const team = (id: number): QuickAccessTeam => ({ id, name: `team-${id}`, is_system: false })

function deferredTeams() {
  let resolve!: (teams: QuickAccessTeam[]) => void
  const promise = new Promise<QuickAccessTeam[]>(done => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  mockUserId = 1
  fetchRecent.mockReset()
})

afterEach(() => jest.restoreAllMocks())

it.each(modes)('requests exact %s history without recommendation fallback', async mode => {
  fetchRecent.mockResolvedValue([team(20), team(10)])
  const { result } = renderHook(() => useRecentTaskTeams(mode, true))

  expect(result.current).toEqual({ recentTeamIds: [], isLoading: true })
  await waitFor(() => expect(result.current.isLoading).toBe(false))
  expect(result.current.recentTeamIds).toEqual([20, 10])
  expect(fetchRecent).toHaveBeenCalledWith(mode === 'code', {
    includeFallback: false,
    mode,
    signal: expect.any(AbortSignal),
  })
})

it('settles an empty history', async () => {
  fetchRecent.mockResolvedValue([])
  const { result } = renderHook(() => useRecentTaskTeams('chat', true))

  await waitFor(() => expect(result.current).toEqual({ recentTeamIds: [], isLoading: false }))
})

it('settles a failed request so configured defaults remain available', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {})
  fetchRecent.mockRejectedValue(new Error('Unavailable'))
  const { result } = renderHook(() => useRecentTaskTeams('chat', true))

  await waitFor(() => expect(result.current).toEqual({ recentTeamIds: [], isLoading: false }))
  expect(log).toHaveBeenCalledTimes(1)
})

it('waits for the current user before resolving initial selection', async () => {
  mockUserId = undefined
  fetchRecent.mockResolvedValue([team(20)])
  const { result, rerender } = renderHook(() => useRecentTaskTeams('chat', true))

  expect(result.current).toEqual({ recentTeamIds: [], isLoading: true })
  expect(fetchRecent).not.toHaveBeenCalled()
  mockUserId = 2
  rerender()
  await waitFor(() => expect(result.current.recentTeamIds).toEqual([20]))
  expect(result.current.isLoading).toBe(false)
  expect(fetchRecent).toHaveBeenCalledTimes(1)
})

it('keeps empty history stable across renders while waiting or disabled', () => {
  mockUserId = undefined
  const { result, rerender } = renderHook(({ enabled }) => useRecentTaskTeams('chat', enabled), {
    initialProps: { enabled: true },
  })
  const emptyIds = result.current.recentTeamIds

  rerender({ enabled: true })
  expect(result.current.recentTeamIds).toBe(emptyIds)
  rerender({ enabled: false })
  expect(result.current.recentTeamIds).toBe(emptyIds)
  expect(result.current.isLoading).toBe(false)
  expect(fetchRecent).not.toHaveBeenCalled()
})

it('ignores an old mode response even when the request does not honor abort', async () => {
  const chat = deferredTeams()
  const code = deferredTeams()
  fetchRecent.mockReturnValueOnce(chat.promise).mockReturnValueOnce(code.promise)
  const { result, rerender } = renderHook(
    ({ mode }: { mode: TaskType }) => useRecentTaskTeams(mode, true),
    { initialProps: { mode: 'chat' as TaskType } }
  )
  const chatSignal = fetchRecent.mock.calls[0][1]?.signal

  rerender({ mode: 'code' })
  expect(chatSignal?.aborted).toBe(true)
  expect(result.current).toEqual({ recentTeamIds: [], isLoading: true })
  await act(async () => code.resolve([team(20)]))
  await act(async () => chat.resolve([team(10)]))
  expect(result.current).toEqual({ recentTeamIds: [20], isLoading: false })
})

it('isolates user changes from previously loaded and pending history', async () => {
  const previousUser = deferredTeams()
  const currentUser = deferredTeams()
  fetchRecent.mockReturnValueOnce(previousUser.promise).mockReturnValueOnce(currentUser.promise)
  const { result, rerender } = renderHook(() => useRecentTaskTeams('chat', true))
  const previousSignal = fetchRecent.mock.calls[0][1]?.signal

  mockUserId = 2
  rerender()
  expect(previousSignal?.aborted).toBe(true)
  expect(result.current).toEqual({ recentTeamIds: [], isLoading: true })
  await act(async () => previousUser.resolve([team(10)]))
  expect(result.current).toEqual({ recentTeamIds: [], isLoading: true })
  await act(async () => currentUser.resolve([team(20)]))
  expect(result.current).toEqual({ recentTeamIds: [20], isLoading: false })

  mockUserId = undefined
  rerender()
  expect(result.current).toEqual({ recentTeamIds: [], isLoading: true })
  expect(fetchRecent).toHaveBeenCalledTimes(2)
})

it('does not request disabled history and ignores a request disabled while pending', async () => {
  const pending = deferredTeams()
  fetchRecent.mockReturnValue(pending.promise)
  const { result, rerender } = renderHook(({ enabled }) => useRecentTaskTeams('chat', enabled), {
    initialProps: { enabled: false },
  })

  expect(result.current).toEqual({ recentTeamIds: [], isLoading: false })
  expect(fetchRecent).not.toHaveBeenCalled()
  rerender({ enabled: true })
  const signal = fetchRecent.mock.calls[0][1]?.signal
  expect(result.current.isLoading).toBe(true)
  rerender({ enabled: false })
  expect(signal?.aborted).toBe(true)
  await act(async () => pending.resolve([team(10)]))
  expect(result.current).toEqual({ recentTeamIds: [], isLoading: false })
})

it('fetches fresh history after disabling a completed request', async () => {
  fetchRecent.mockResolvedValueOnce([team(10)])
  const { result, rerender } = renderHook(({ enabled }) => useRecentTaskTeams('chat', enabled), {
    initialProps: { enabled: true },
  })
  await waitFor(() => expect(result.current.recentTeamIds).toEqual([10]))
  rerender({ enabled: false })
  expect(result.current).toEqual({ recentTeamIds: [], isLoading: false })

  const fresh = deferredTeams()
  fetchRecent.mockReturnValueOnce(fresh.promise)
  rerender({ enabled: true })
  expect(result.current).toEqual({ recentTeamIds: [], isLoading: true })
  await act(async () => fresh.resolve([team(20)]))
  expect(result.current).toEqual({ recentTeamIds: [20], isLoading: false })
})

it('aborts history when unmounted and ignores its later response', async () => {
  const pending = deferredTeams()
  fetchRecent.mockReturnValue(pending.promise)
  const { result, unmount } = renderHook(() => useRecentTaskTeams('chat', true))
  const signal = fetchRecent.mock.calls[0][1]?.signal

  unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => pending.resolve([team(10)]))
  expect(result.current).toEqual({ recentTeamIds: [], isLoading: true })
})
