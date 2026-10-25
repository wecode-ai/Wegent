import { act, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useConversationFind } from './useConversationFind'

vi.mock('@/lib/platform', () => ({ getPlatform: () => 'mac' }))

afterEach(() => vi.useRealTimers())

describe('conversation search error stages', () => {
  test('ignores an old target while the next query with the same occurrence is pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const response = { matches: [], totalMatches: 0, isCapped: false }
    let completeSearch!: (value: typeof response) => void
    const search = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockImplementationOnce(() => new Promise(resolve => (completeSearch = resolve)))
    const { result } = renderHook(() =>
      useConversationFind(
        {
          messages: [
            {
              id: 'message',
              role: 'assistant',
              content: 'needle',
              createdAt: '',
              status: 'done',
            },
          ],
          onSearchTranscript: search,
        },
        true
      )
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
    })
    await act(async () => vi.advanceTimersByTime(150))
    const oldTarget = result.current.searchTarget!
    expect(oldTarget).not.toBeNull()
    act(() => result.current.changeQuery('NEEDLE'))
    await act(async () => vi.advanceTimersByTime(150))
    expect(result.current.queryPending).toBe(false)
    expect(result.current.isLoading).toBe(true)
    expect(result.current.searchTarget).toBeNull()
    act(() => result.current.reportNavigationFailure(oldTarget))
    expect(result.current.failure).toBeNull()
    await act(async () => completeSearch(response))
    expect(result.current.searchTarget?.query).toBe('NEEDLE')
    expect(result.current.failure).toBeNull()
  })

  test('rejects stale navigation failures and refreshes an unlocatable result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const search = vi.fn().mockResolvedValue({ matches: [], totalMatches: 0, isCapped: false })
    const hydrate = vi.fn()
    const { result } = renderHook(() =>
      useConversationFind(
        {
          messages: [
            {
              id: 'message',
              role: 'assistant',
              content: 'needle other',
              createdAt: '',
              status: 'done',
            },
          ],
          onSearchTranscript: search,
          onEnsureSearchMatch: hydrate,
        },
        true
      )
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
    })
    await act(async () => vi.advanceTimersByTime(150))
    const firstTarget = result.current.searchTarget!
    expect(firstTarget).not.toBeNull()
    act(() => result.current.reportNavigationFailure(firstTarget))
    expect(result.current.failure).toBe('locate')
    expect(result.current.historyFailed).toBe(false)
    act(() => result.current.retry())
    await act(async () => vi.advanceTimersByTime(150))
    expect(search).toHaveBeenCalledTimes(2)
    expect(hydrate).not.toHaveBeenCalled()
    expect(result.current.failure).toBeNull()
    act(() => result.current.changeQuery('other'))
    await act(async () => vi.advanceTimersByTime(150))
    act(() => result.current.reportNavigationFailure(firstTarget))
    expect(result.current.failure).toBeNull()
    expect(result.current.searchTarget?.query).toBe('other')
    act(() => result.current.close())
    act(() => result.current.reportNavigationFailure(result.current.searchTarget ?? firstTarget))
    expect(result.current.failure).toBeNull()
  })
})
