import { act, renderHook } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress, RuntimeTranscriptSearchResponse } from '@wegent/chat-core/runtime'
import type { RuntimePaneTranscript } from '@/types/workbench'
import { useRuntimeConversationSearch } from './useRuntimeConversationSearch'

const address: RuntimeTaskAddress = { deviceId: 'device', taskId: 'task' }
const target = { key: 'device:task', address }
const match = { itemId: 'historical-item', turnId: 'turn', occurrence: 0, cursor: 'opaque-match' }
const transcript: RuntimePaneTranscript = {
  messages: [],
  turns: [
    {
      id: 'turn',
      status: 'done',
      items: [{ id: 'historical-item', type: 'assistant_text', content: 'historical needle' }],
    },
  ],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

function contextPage(
  ids: string[],
  pagination: Partial<RuntimePaneTranscript> = {}
): RuntimePaneTranscript {
  return {
    messages: [],
    turns: ids.map(id => ({
      id,
      status: 'done',
      items: [{ id: `${id}-item`, type: 'assistant_text', content: id }],
    })),
    ...pagination,
  }
}

describe('runtime conversation search pages', () => {
  test('serializes disk searches and skips cancelled queries waiting for an earlier scan', async () => {
    const pending = deferred<RuntimeTranscriptSearchResponse>()
    const response = { matches: [match], totalMatches: 1, isCapped: false }
    const searchTranscript = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(response)
    const { result } = renderHook(() =>
      useRuntimeConversationSearch({
        target,
        targetRef: { current: target },
        searchTranscript,
        loadTranscript: vi.fn(),
      })
    )
    const first = new AbortController()
    let firstRequest!: Promise<RuntimeTranscriptSearchResponse>
    await act(async () => {
      firstRequest = result.current.search('first', first.signal)
    })
    expect(searchTranscript).toHaveBeenCalledExactlyOnceWith(address, 'first')
    const firstRejected = expect(firstRequest).rejects.toMatchObject({ name: 'AbortError' })
    first.abort()
    const middle = new AbortController()
    const middleRequest = result.current.search('middle', middle.signal)
    const middleRejected = expect(middleRequest).rejects.toMatchObject({ name: 'AbortError' })
    middle.abort()
    const latestRequest = result.current.search('latest', new AbortController().signal)
    expect(searchTranscript).toHaveBeenCalledTimes(1)
    await act(async () => {
      pending.resolve(response)
      await Promise.all([firstRejected, middleRejected, latestRequest])
    })
    expect(searchTranscript.mock.calls.map(call => call[1])).toEqual(['first', 'latest'])
  })

  test('shares the disk queue with match loading and skips cancelled selections', async () => {
    const pending = deferred<RuntimeTranscriptSearchResponse>()
    const loadTranscript = vi.fn().mockResolvedValue(transcript)
    const { result } = renderHook(() =>
      useRuntimeConversationSearch({
        target,
        targetRef: { current: target },
        searchTranscript: vi.fn(() => pending.promise),
        loadTranscript,
      })
    )
    const signal = new AbortController().signal
    let searchRequest!: Promise<RuntimeTranscriptSearchResponse>
    await act(async () => {
      searchRequest = result.current.search('needle', signal)
    })
    const cancelled = new AbortController()
    const oldSelection = result.current.ensureMatch(match, cancelled.signal)
    const rejected = expect(oldSelection).rejects.toMatchObject({ name: 'AbortError' })
    cancelled.abort()
    const selected = { ...match, cursor: 'latest-match' }
    const latestSelection = result.current.ensureMatch(selected, signal)
    expect(loadTranscript).not.toHaveBeenCalled()
    await act(async () => {
      pending.resolve({ matches: [match], totalMatches: 1, isCapped: false })
      await Promise.all([searchRequest, rejected, latestSelection])
    })
    expect(loadTranscript).toHaveBeenCalledExactlyOnceWith(address, {
      beforeCursor: 'latest-match',
      limit: 5,
    })
  })

  test('keeps only the selected slice and leaves the original conversation untouched', async () => {
    const targetRef = { current: target }
    const searchTranscript = vi.fn().mockResolvedValue({
      matches: [match],
      totalMatches: 1,
      isCapped: false,
    })
    const loadTranscript = vi.fn().mockResolvedValue(transcript)
    const { result } = renderHook(() =>
      useRuntimeConversationSearch({ target, targetRef, searchTranscript, loadTranscript })
    )
    const signal = new AbortController().signal
    await act(async () => {
      await result.current.search('needle', signal)
    })
    expect(searchTranscript).toHaveBeenCalledExactlyOnceWith(address, 'needle')
    expect(loadTranscript).not.toHaveBeenCalled()
    expect(result.current.page).toBeNull()
    await act(async () => {
      await result.current.ensureMatch(match, signal)
    })
    expect(loadTranscript).toHaveBeenCalledExactlyOnceWith(address, {
      beforeCursor: match.cursor,
      limit: 5,
    })
    expect(result.current.page?.messages[0].content).toBe('historical needle')
    const nextTranscript: RuntimePaneTranscript = {
      messages: [],
      turns: [
        {
          ...transcript.turns[0],
          items: [{ id: 'other', type: 'assistant_text', content: 'other needle' }],
        },
      ],
    }
    loadTranscript.mockResolvedValueOnce(nextTranscript)
    await act(async () => {
      await result.current.ensureMatch({ ...match, itemId: 'other', cursor: 'other-match' }, signal)
    })
    expect(result.current.page?.messages).toHaveLength(1)
    expect(result.current.page?.messages[0].content).toBe('other needle')
    expect(transcript.turns[0].items).toHaveLength(1)
    expect(transcript.turns[0].items[0].id).toBe('historical-item')
    act(() => result.current.releasePage())
    expect(result.current.page).toBeNull()
    await act(async () => {
      await result.current.ensureMatch(match, signal)
    })
    await act(async () => {
      await result.current.search('another query', signal)
    })
    expect(result.current.page).toBeNull()
  })

  test('does not publish a page after search is cancelled', async () => {
    const pending = deferred<RuntimePaneTranscript>()
    const loadTranscript = vi.fn(() => pending.promise)
    const { result } = renderHook(() =>
      useRuntimeConversationSearch({
        target,
        targetRef: { current: target },
        searchTranscript: vi.fn(),
        loadTranscript,
      })
    )
    const controller = new AbortController()
    let request!: Promise<void>
    await act(async () => {
      request = result.current.ensureMatch(match, controller.signal)
    })
    expect(loadTranscript).toHaveBeenCalledTimes(1)
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await act(async () => {
      pending.resolve(transcript)
      await rejected
    })
    expect(result.current.page).toBeNull()
  })

  test('isolates both in-flight and previously selected pages when switching tasks', async () => {
    const pending = deferred<RuntimePaneTranscript>()
    const targetRef = { current: target }
    const options = {
      target,
      targetRef,
      searchTranscript: vi.fn(),
      loadTranscript: vi
        .fn()
        .mockResolvedValueOnce(transcript)
        .mockReturnValueOnce(pending.promise),
    }
    const { result, rerender } = renderHook(useRuntimeConversationSearch, { initialProps: options })
    const signal = new AbortController().signal
    await act(async () => {
      await result.current.ensureMatch(match, signal)
    })
    expect(result.current.page).not.toBeNull()
    let request!: Promise<void>
    await act(async () => {
      request = result.current.ensureMatch(match, signal)
    })
    expect(options.loadTranscript).toHaveBeenCalledTimes(2)
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    const nextTarget = { ...target, key: 'device:other', address: { ...address, taskId: 'other' } }
    targetRef.current = nextTarget
    rerender({ ...options, target: nextTarget })
    expect(result.current.page).toBeNull()
    await act(async () => {
      pending.resolve(transcript)
      await rejected
    })
    expect(result.current.page).toBeNull()
    targetRef.current = target
    rerender(options)
    expect(result.current.page).toBeNull()
  })

  test('loads one explicit page in either direction and preserves the opposite boundary', async () => {
    const initial = contextPage(['middle'], {
      hasMoreBefore: true,
      beforeCursor: 'before-middle',
      hasMoreAfter: true,
      afterCursor: 'after-middle',
    })
    initial.turns[0].startedAt = 1
    const before = contextPage(['older', 'previous'], {
      hasMoreBefore: true,
      beforeCursor: 'before-older',
      hasMoreAfter: false,
      afterCursor: 'ignored-after',
    })
    before.turns.forEach(turn => {
      turn.startedAt = 100
    })
    const loadTranscript = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(
        contextPage(['next'], {
          hasMoreBefore: false,
          beforeCursor: 'ignored-before',
          hasMoreAfter: true,
          afterCursor: 'after-next',
        })
      )
      .mockResolvedValueOnce(contextPage(['first'], { hasMoreBefore: false }))
      .mockResolvedValueOnce(contextPage(['last'], { hasMoreAfter: false }))
    const { result } = renderHook(() =>
      useRuntimeConversationSearch({
        target,
        targetRef: { current: target },
        searchTranscript: vi.fn(),
        loadTranscript,
      })
    )
    await act(async () => {
      await result.current.ensureMatch(match, new AbortController().signal)
      await Promise.resolve()
    })
    expect(loadTranscript).toHaveBeenCalledTimes(1)
    expect(result.current.page).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true })
    await act(async () => {
      await result.current.loadMoreContext('before')
    })
    expect(result.current.page?.turns.map(turn => turn.id)).toEqual(['older', 'previous', 'middle'])
    expect(result.current.page).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true })
    expect(loadTranscript).toHaveBeenCalledTimes(2)
    await act(async () => {
      await result.current.loadMoreContext('after')
    })
    expect(result.current.page).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true })
    await act(async () => {
      await result.current.loadMoreContext('before')
    })
    expect(result.current.page).toMatchObject({ hasMoreBefore: false, hasMoreAfter: true })
    await act(async () => {
      await result.current.loadMoreContext('after')
    })
    expect(result.current.page?.turns.map(turn => turn.id)).toEqual([
      'first',
      'older',
      'previous',
      'middle',
      'next',
      'last',
    ])
    expect(result.current.page).toMatchObject({ hasMoreBefore: false, hasMoreAfter: false })
    expect(loadTranscript.mock.calls.map(call => call[1])).toEqual([
      { beforeCursor: match.cursor, limit: 5 },
      { beforeCursor: 'before-middle', limit: 5 },
      { afterCursor: 'after-middle', limit: 5 },
      { beforeCursor: 'before-older', limit: 5 },
      { afterCursor: 'after-next', limit: 5 },
    ])
    await act(async () => {
      await result.current.loadMoreContext('before')
      await result.current.loadMoreContext('after')
    })
    expect(loadTranscript).toHaveBeenCalledTimes(5)
    expect(initial.turns.map(turn => turn.id)).toEqual(['middle'])
  })

  test('merges overlapping pages of a long turn in provider item order', async () => {
    const turnPage = (ids: string[], pagination: Partial<RuntimePaneTranscript>) => ({
      ...contextPage([], pagination),
      turns: [
        {
          id: 'long-turn',
          status: 'done' as const,
          items: ids.map(id => ({ id, type: 'assistant_text' as const, content: id })),
        },
      ],
    })
    const initial = turnPage(['c', 'd'], {
      hasMoreBefore: true,
      beforeCursor: 'before-c',
      hasMoreAfter: true,
      afterCursor: 'after-d',
    })
    const loadTranscript = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(turnPage(['a', 'b', 'c'], { hasMoreBefore: false }))
      .mockResolvedValueOnce(turnPage(['d', 'e', 'f'], { hasMoreAfter: false }))
    const { result } = renderHook(() =>
      useRuntimeConversationSearch({
        target,
        targetRef: { current: target },
        searchTranscript: vi.fn(),
        loadTranscript,
      })
    )
    await act(async () => {
      await result.current.ensureMatch(match, new AbortController().signal)
    })
    await act(async () => {
      await result.current.loadMoreContext('before')
    })
    await act(async () => {
      await result.current.loadMoreContext('after')
    })
    expect(result.current.page?.turns).toHaveLength(1)
    expect(result.current.page?.turns[0].items.map(item => item.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ])
    expect(initial.turns[0].items.map(item => item.id)).toEqual(['c', 'd'])
  })

  test('coalesces repeated clicks without fetching the other direction automatically', async () => {
    const pending = deferred<RuntimePaneTranscript>()
    const loadTranscript = vi
      .fn()
      .mockResolvedValueOnce(
        contextPage(['middle'], {
          hasMoreBefore: true,
          beforeCursor: 'before',
          hasMoreAfter: true,
          afterCursor: 'after',
        })
      )
      .mockReturnValueOnce(pending.promise)
    const { result } = renderHook(() =>
      useRuntimeConversationSearch({
        target,
        targetRef: { current: target },
        searchTranscript: vi.fn(),
        loadTranscript,
      })
    )
    await act(async () => {
      await result.current.ensureMatch(match, new AbortController().signal)
    })
    let request!: Promise<void>
    await act(async () => {
      request = result.current.loadMoreContext('before')
      expect(result.current.loadMoreContext('before')).toBe(request)
      expect(result.current.loadMoreContext('after')).toBe(request)
    })
    expect(result.current.page).toMatchObject({ loadingMoreBefore: true, loadingMoreAfter: false })
    expect(loadTranscript).toHaveBeenCalledTimes(2)
    await act(async () => {
      pending.resolve(contextPage(['previous'], { hasMoreBefore: false }))
      await request
    })
    expect(result.current.page).toMatchObject({ loadingMoreBefore: false, hasMoreAfter: true })
    expect(loadTranscript).toHaveBeenCalledTimes(2)
  })

  test('reports a repeated cursor without merging and permits retrying the same page', async () => {
    const loadTranscript = vi
      .fn()
      .mockResolvedValueOnce(
        contextPage(['middle'], { hasMoreBefore: true, beforeCursor: 'before' })
      )
      .mockResolvedValueOnce(
        contextPage(['duplicate'], { hasMoreBefore: true, beforeCursor: 'before' })
      )
      .mockResolvedValueOnce(contextPage(['previous'], { hasMoreBefore: false }))
    const { result } = renderHook(() =>
      useRuntimeConversationSearch({
        target,
        targetRef: { current: target },
        searchTranscript: vi.fn(),
        loadTranscript,
      })
    )
    await act(async () => {
      await result.current.ensureMatch(match, new AbortController().signal)
    })
    await act(async () => {
      await expect(result.current.loadMoreContext('before')).rejects.toThrow(
        'repeated or missing cursor'
      )
    })
    expect(result.current.page?.turns.map(turn => turn.id)).toEqual(['middle'])
    expect(result.current.page).toMatchObject({
      hasMoreBefore: true,
      loadingMoreBefore: false,
      loadError: 'Conversation context returned a repeated or missing cursor',
    })
    await act(async () => {
      await result.current.loadMoreContext('before')
    })
    expect(result.current.page?.turns.map(turn => turn.id)).toEqual(['previous', 'middle'])
    expect(result.current.page?.loadError).toBeNull()
    expect(loadTranscript.mock.calls.slice(1).map(call => call[1])).toEqual([
      { beforeCursor: 'before', limit: 5 },
      { beforeCursor: 'before', limit: 5 },
    ])
  })

  test('retains context and exposes a failed request until an explicit retry', async () => {
    const loadTranscript = vi
      .fn()
      .mockResolvedValueOnce(contextPage(['middle'], { hasMoreAfter: true, afterCursor: 'after' }))
      .mockRejectedValueOnce(new Error('History read failed'))
      .mockResolvedValueOnce(contextPage(['next'], { hasMoreAfter: false }))
    const { result } = renderHook(() =>
      useRuntimeConversationSearch({
        target,
        targetRef: { current: target },
        searchTranscript: vi.fn(),
        loadTranscript,
      })
    )
    await act(async () => {
      await result.current.ensureMatch(match, new AbortController().signal)
    })
    await act(async () => {
      await expect(result.current.loadMoreContext('after')).rejects.toThrow('History read failed')
    })
    expect(result.current.page?.turns.map(turn => turn.id)).toEqual(['middle'])
    expect(result.current.page).toMatchObject({
      hasMoreAfter: true,
      loadingMoreAfter: false,
      loadError: 'History read failed',
    })
    expect(loadTranscript).toHaveBeenCalledTimes(2)
    await act(async () => {
      await result.current.loadMoreContext('after')
    })
    expect(result.current.page?.turns.map(turn => turn.id)).toEqual(['middle', 'next'])
    expect(result.current.page?.loadError).toBeNull()
    expect(loadTranscript.mock.calls.slice(1).map(call => call[1])).toEqual([
      { afterCursor: 'after', limit: 5 },
      { afterCursor: 'after', limit: 5 },
    ])
  })

  test.each(['close', 'query', 'task'] as const)(
    'discards pending context after changing %s',
    async change => {
      const pending = deferred<RuntimePaneTranscript>()
      const targetRef = { current: target }
      const options = {
        target,
        targetRef,
        searchTranscript: vi
          .fn()
          .mockResolvedValue({ matches: [], totalMatches: 0, isCapped: false }),
        loadTranscript: vi
          .fn()
          .mockResolvedValueOnce(
            contextPage(['middle'], { hasMoreAfter: true, afterCursor: 'after' })
          )
          .mockReturnValueOnce(pending.promise),
      }
      const { result, rerender } = renderHook(useRuntimeConversationSearch, {
        initialProps: options,
      })
      await act(async () => {
        await result.current.ensureMatch(match, new AbortController().signal)
      })
      let request!: Promise<void>
      await act(async () => {
        request = result.current.loadMoreContext('after')
      })
      const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
      let queryRequest: Promise<RuntimeTranscriptSearchResponse> | undefined
      act(() => {
        if (change === 'close') result.current.releasePage()
        if (change === 'query')
          queryRequest = result.current.search('changed', new AbortController().signal)
        if (change === 'task') {
          const nextTarget = { key: 'device:other', address: { ...address, taskId: 'other' } }
          targetRef.current = nextTarget
          rerender({ ...options, target: nextTarget })
        }
      })
      expect(result.current.page).toBeNull()
      await act(async () => {
        pending.resolve(contextPage(['stale-next']))
        await rejected
        await queryRequest
      })
      expect(result.current.page).toBeNull()
      expect(options.loadTranscript).toHaveBeenCalledTimes(2)
    }
  )

  test('replaces pending context with a newly selected match through the same disk queue', async () => {
    const pending = deferred<RuntimePaneTranscript>()
    const loadTranscript = vi
      .fn()
      .mockResolvedValueOnce(contextPage(['middle'], { hasMoreAfter: true, afterCursor: 'after' }))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(contextPage(['selected']))
    const { result } = renderHook(() =>
      useRuntimeConversationSearch({
        target,
        targetRef: { current: target },
        searchTranscript: vi.fn(),
        loadTranscript,
      })
    )
    await act(async () => {
      await result.current.ensureMatch(match, new AbortController().signal)
    })
    let contextRequest!: Promise<void>
    await act(async () => {
      contextRequest = result.current.loadMoreContext('after')
    })
    const rejected = expect(contextRequest).rejects.toMatchObject({ name: 'AbortError' })
    let selectionRequest!: Promise<void>
    act(() => {
      selectionRequest = result.current.ensureMatch(
        { ...match, cursor: 'selected-match' },
        new AbortController().signal
      )
    })
    expect(result.current.page).toBeNull()
    expect(loadTranscript).toHaveBeenCalledTimes(2)
    await act(async () => {
      pending.resolve(contextPage(['stale-next']))
      await Promise.all([rejected, selectionRequest])
    })
    expect(result.current.page?.turns.map(turn => turn.id)).toEqual(['selected'])
    expect(loadTranscript).toHaveBeenLastCalledWith(address, {
      beforeCursor: 'selected-match',
      limit: 5,
    })
  })
})
