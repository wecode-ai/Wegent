import { act, fireEvent, renderHook } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useConversationFind } from './useConversationFind'

vi.mock('@/lib/platform', () => ({ getPlatform: () => 'mac' }))

afterEach(() => vi.useRealTimers())

describe('conversation search error stages', () => {
  test('keeps loading continuously from a persisted hit through its visible projection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const matches = ['first', 'second'].map(itemId => ({ itemId, occurrence: 0, cursor: itemId }))
    const search = vi.fn().mockResolvedValue({ matches, totalMatches: 2, isCapped: false })
    let finishHydration!: () => void
    const hydrate = vi.fn(() => new Promise<void>(resolve => (finishHydration = resolve)))
    const props: Parameters<typeof useConversationFind>[0] = {
      messages: [],
      onSearchTranscript: search,
      onEnsureSearchMatch: hydrate,
    }
    const states: { active: number; loading: boolean; resolved: boolean }[] = []
    const { result, rerender } = renderHook(
      props => {
        const find = useConversationFind(props, true)
        useLayoutEffect(() => {
          if (find.result.matches === 2)
            states.push({
              active: find.result.active,
              loading: find.isLoading,
              resolved: Boolean(find.searchTarget),
            })
        })
        return find
      },
      { initialProps: props }
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
    })
    await act(async () => vi.advanceTimersByTime(150))
    expect(hydrate).toHaveBeenCalledOnce()
    await act(async () => result.current.step(1))
    expect(hydrate).toHaveBeenCalledTimes(2)
    await act(async () => finishHydration())
    expect(result.current.isLoading).toBe(true)
    expect(states.some(state => state.active === 1)).toBe(true)
    expect(states.some(state => state.active === 2)).toBe(true)
    expect(states.every(state => state.loading && !state.resolved)).toBe(true)

    rerender({
      ...props,
      messages: [
        {
          id: 'visible-second',
          role: 'assistant',
          content: 'needle',
          status: 'done',
          createdAt: '',
          runtimeDisplayItems: [{ id: 'second', type: 'assistant_text', content: 'needle' }],
        },
      ],
    })
    expect(result.current.searchTarget?.messageId).toBe('visible-second')
    expect(result.current.isLoading).toBe(false)
    expect(result.current.failure).toBeNull()
  })

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
