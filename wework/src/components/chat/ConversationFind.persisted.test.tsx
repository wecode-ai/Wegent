import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { RuntimeTranscriptSearchResponse } from '@wegent/chat-core/runtime'
import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  AssistantMessage,
  ConversationTranslationProvider,
} from '@wegent/collaboration/conversation'
import { conversationSearchRanges } from '../../../../packages/collaboration/src/conversation/useConversationSearchTarget'
import { useConversationFind } from './useConversationFind'
import { ConversationFindBar } from './ConversationFindBar'
import '@/i18n'

vi.mock('@/lib/platform', () => ({ getPlatform: () => 'mac' }))

function message(id: string, content: string): WorkbenchMessage {
  return { id, content, role: 'assistant', status: 'done', createdAt: '2026-10-14T00:00:00Z' }
}

function partialContextMessage(): WorkbenchMessage {
  return {
    ...message('partial-context', ''),
    blocks: [
      {
        id: 'context-narrative',
        subtaskId: 'context-turn',
        type: 'text',
        content: 'needle',
        status: 'done',
        createdAt: 0,
      },
    ],
    runtimeDisplayItems: [{ id: 'context-narrative', type: 'block' }],
  }
}

function pluginResultMarker(overrides: Record<string, unknown> = {}): string {
  return `[WEGENT_PLUGIN_RESULT]${JSON.stringify({
    schemaVersion: 1,
    taskId: 'task',
    relativePath: 'plugins/result',
    name: 'result',
    displayName: 'Hidden needle metadata',
    description: 'Plugin result',
    version: '1',
    listingType: 'plugin',
    logo: '',
    sha256: 'a'.repeat(64),
    status: 'ready',
    ...overrides,
  })}`
}

function FindHarness(props: Parameters<typeof useConversationFind>[0]) {
  return <ConversationFindBar find={useConversationFind(props, true)} />
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('persisted conversation find', () => {
  test('searches loaded text without loading older pages or gaps when persisted search is unavailable', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const loadBefore = vi.fn()
    const loadGap = vi.fn()
    const { result } = renderHook(() =>
      useConversationFind(
        {
          messages: [message('latest', 'needle')],
          hasMoreBefore: true,
          loadedTranscriptRanges: [
            { start: 100, end: 110 },
            { start: 200, end: 210 },
          ],
          onLoadMoreBefore: loadBefore,
          onLoadTranscriptGap: loadGap,
          transcriptError: 'unrelated history error',
        },
        true
      )
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
      vi.advanceTimersByTime(150)
    })
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.result).toEqual({ matches: 1, active: 1, isCapped: false })
    expect(result.current.historyFailed).toBe(false)
    expect(loadBefore).not.toHaveBeenCalled()
    expect(loadGap).not.toHaveBeenCalled()
  })

  test('searches temporary context pages when persisted search is unavailable', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { result } = renderHook(() =>
      useConversationFind(
        {
          messages: [message('latest', 'latest')],
          searchMessages: [partialContextMessage()],
        },
        true
      )
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
    })
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.result).toEqual({ matches: 1, active: 1, isCapped: false })
    expect(result.current.searchTarget).toMatchObject({
      messageId: 'partial-context',
      occurrence: 0,
      source: 'page',
    })
    expect(result.current.historyFailed).toBe(false)
  })

  test('uses persisted hits without adding a narrative duplicate from a partial context page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const target = { itemId: 'final-item', occurrence: 0, cursor: 'final-cursor' }
    const search = vi.fn().mockResolvedValue({
      matches: [target],
      totalMatches: 1,
      isCapped: false,
    })
    const hydrate = vi.fn()
    const original = [message('latest', 'latest')]
    const visibleTarget: WorkbenchMessage = {
      ...message('visible-target', 'needle'),
      runtimeDisplayItems: [{ id: target.itemId, type: 'assistant_text', content: 'needle' }],
    }
    const props: Parameters<typeof useConversationFind>[0] = {
      messages: original,
      searchMessages: [visibleTarget],
      onSearchTranscript: search,
      onEnsureSearchMatch: hydrate,
    }
    const { result, rerender } = renderHook(props => useConversationFind(props, true), {
      initialProps: props,
    })
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
    })
    await act(async () => vi.advanceTimersByTime(150))
    expect(result.current.result).toEqual({ matches: 1, active: 1, isCapped: false })

    // The final body hiding this narrative item is outside the temporary page.
    rerender({ ...props, searchMessages: [partialContextMessage(), visibleTarget] })
    expect(result.current.result).toEqual({ matches: 1, active: 1, isCapped: false })
    act(() => result.current.step(1))
    expect(result.current.searchTarget).toMatchObject({
      messageId: visibleTarget.id,
      occurrence: 0,
      source: 'page',
    })
    expect(hydrate).not.toHaveBeenCalled()
    expect(result.current.historyFailed).toBe(false)
    act(() => result.current.close())
    expect(result.current.searchTarget).toBeNull()
    expect(props.messages).toBe(original)
  })

  test('searches a large persisted history once and hydrates only its selected match', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let finishHydration!: () => void
    const target = { itemId: 'old-item', turnId: 'turn', occurrence: 0, cursor: 'old-cursor' }
    const search = vi.fn().mockResolvedValue({
      matches: [target],
      totalMatches: 100_000,
      isCapped: true,
    })
    const hydrate = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishHydration = resolve
        })
    )
    const loadBefore = vi.fn()
    const loadGap = vi.fn()
    const props: Parameters<typeof useConversationFind>[0] = {
      messages: [message('latest', 'latest')],
      hasMoreBefore: true,
      onLoadMoreBefore: loadBefore,
      onLoadTranscriptGap: loadGap,
      onSearchTranscript: search,
      onEnsureSearchMatch: hydrate,
    }
    const { result, rerender } = renderHook(props => useConversationFind(props, true), {
      initialProps: props,
    })
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
    })
    await act(async () => vi.advanceTimersByTime(149))
    expect(search).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(1))
    expect(search).toHaveBeenCalledExactlyOnceWith('needle', expect.any(AbortSignal))
    expect(hydrate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(target),
      expect.any(AbortSignal)
    )
    expect(result.current.searchTarget).toBeNull()
    expect(result.current.isLoading).toBe(true)
    const older = {
      ...message('projected-old', 'needle'),
      runtimeDisplayItems: [{ id: 'old-item', type: 'assistant_text' as const, content: 'needle' }],
    }
    rerender({ ...props, messages: [older, ...props.messages] })
    expect(result.current.searchTarget).toBeNull()
    await act(async () => finishHydration())
    expect(result.current.searchTarget?.messageId).toBe('projected-old')
    expect(result.current.result).toEqual({ matches: 100_000, active: 1, isCapped: true })
    expect(result.current.isLoading).toBe(false)
    expect(loadBefore).not.toHaveBeenCalled()
    expect(loadGap).not.toHaveBeenCalled()
    expect(search).toHaveBeenCalledTimes(1)
  })

  test('resolves hydrated item occurrences after hiding a valid plugin result marker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const targets = [0, 1].map(occurrence => ({
      itemId: 'old-item',
      occurrence,
      cursor: 'old-cursor',
    }))
    const search = vi.fn().mockResolvedValue({ matches: targets, totalMatches: 2, isCapped: false })
    let finishHydration!: () => void
    const hydrate = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishHydration = resolve
        })
    )
    const props: Parameters<typeof useConversationFind>[0] = {
      messages: [message('latest', 'latest')],
      onSearchTranscript: search,
      onEnsureSearchMatch: hydrate,
    }
    const { result, rerender } = renderHook(props => useConversationFind(props, true), {
      initialProps: props,
    })
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
    })
    await act(async () => vi.advanceTimersByTime(150))
    expect(hydrate).toHaveBeenCalledOnce()
    const content = `needle **needle**\n${pluginResultMarker()}`
    rerender({
      ...props,
      searchMessages: [
        {
          ...message('projected-old', content),
          runtimeDisplayItems: [{ id: 'old-item', type: 'assistant_text', content }],
        },
      ],
    })
    await act(async () => finishHydration())
    expect(result.current.searchTarget).toMatchObject({
      messageId: 'projected-old',
      occurrence: 0,
      source: 'page',
    })
    act(() => result.current.step(1))
    expect(result.current.searchTarget).toMatchObject({ occurrence: 1, source: 'page' })
    await act(async () => vi.advanceTimersByTime(1500))
    expect(result.current.result).toEqual({ matches: 2, active: 2, isCapped: false })
    expect(result.current.historyFailed).toBe(false)
    expect(result.current.isLoading).toBe(false)
    expect(hydrate).toHaveBeenCalledOnce()
  })

  test.each(['live', 'page'] as const)(
    'resolves one visible final-body hit after a hidden duplicate block is hydrated into %s messages',
    async location => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const target = { itemId: 'final-item', occurrence: 0, cursor: 'old-cursor' }
      const search = vi.fn().mockResolvedValue({
        matches: [target],
        totalMatches: 1,
        isCapped: false,
      })
      let finishHydration!: () => void
      const hydrate = vi.fn(
        () =>
          new Promise<void>(resolve => {
            finishHydration = resolve
          })
      )
      const props: Parameters<typeof useConversationFind>[0] = {
        messages: [message('latest', 'latest')],
        onSearchTranscript: search,
        onEnsureSearchMatch: hydrate,
      }
      const { result, rerender } = renderHook(props => useConversationFind(props, true), {
        initialProps: props,
      })
      act(() => {
        fireEvent.keyDown(window, { key: 'f', metaKey: true })
        result.current.changeQuery('needle')
      })
      await act(async () => vi.advanceTimersByTime(150))
      expect(hydrate).toHaveBeenCalledOnce()

      const projected: WorkbenchMessage = {
        ...message('projected-old', 'needle'),
        blocks: [
          {
            id: 'duplicate-block',
            subtaskId: 'turn',
            type: 'text',
            content: 'needle',
            status: 'done',
            createdAt: 0,
          },
        ],
        runtimeDisplayItems: [
          { id: 'duplicate-block', type: 'block' },
          { id: target.itemId, type: 'assistant_text', content: 'needle' },
        ],
      }
      rerender({
        ...props,
        ...(location === 'live'
          ? { messages: [projected, ...props.messages] }
          : { searchMessages: [projected] }),
      })
      await act(async () => finishHydration())
      await act(async () => vi.advanceTimersByTime(1500))

      expect(result.current.result).toEqual({ matches: 1, active: 1, isCapped: false })
      expect(result.current.searchTarget).toMatchObject({
        messageId: projected.id,
        occurrence: 0,
        ...(location === 'page' ? { source: 'page' } : {}),
      })
      expect(result.current.historyFailed).toBe(false)
      expect(result.current.isLoading).toBe(false)

      const { container } = render(
        <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
          <AssistantMessage
            message={projected}
            devices={[]}
            imageServices={{
              identity: image => String(image.id),
              load: vi.fn(),
              download: vi.fn(),
            }}
          />
        </ConversationTranslationProvider>
      )
      const ranges = conversationSearchRanges(container, 'needle', 250)
      expect(ranges.map(range => range.toString())).toEqual(['needle'])
      expect(ranges[result.current.searchTarget!.occurrence].toString()).toBe('needle')
      act(() => result.current.close())
      expect(result.current.searchTarget).toBeNull()
      expect(props.messages).toEqual([message('latest', 'latest')])
    }
  )

  test('deduplicates plugin result items shared by live messages, reading pages and persisted search', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const content = `needle\n${pluginResultMarker()}`
    const item = { id: 'shared-item', type: 'assistant_text' as const, content }
    const search = vi.fn().mockResolvedValue({
      matches: [{ itemId: item.id, occurrence: 0, cursor: 'shared-cursor' }],
      totalMatches: 1,
      isCapped: false,
    })
    const hydrate = vi.fn()
    const { result } = renderHook(() =>
      useConversationFind(
        {
          messages: [{ ...message('live-projection', content), runtimeDisplayItems: [item] }],
          searchMessages: [
            {
              ...message('page-projection', `older\n\n${content}`),
              runtimeDisplayItems: [
                { id: 'preceding-item', type: 'assistant_text', content: 'older' },
                item,
              ],
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
    expect(result.current.result).toEqual({ matches: 1, active: 1, isCapped: false })
    expect(result.current.searchTarget).toMatchObject({
      messageId: 'page-projection',
      occurrence: 0,
      source: 'page',
    })
    expect(hydrate).not.toHaveBeenCalled()
  })

  test.each([
    ['invalid JSON', '[WEGENT_PLUGIN_RESULT]not-json needle'],
    [
      'unsafe relative path',
      pluginResultMarker({ relativePath: '../result', displayName: 'invalid needle' }),
    ],
  ])('keeps an %s plugin marker searchable by item', async (_reason, marker) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const content = `needle\n${marker}`
    const search = vi.fn().mockResolvedValue({
      matches: [0, 1].map(occurrence => ({ itemId: 'item', occurrence, cursor: 'cursor' })),
      totalMatches: 2,
      isCapped: false,
    })
    const hydrate = vi.fn()
    const { result } = renderHook(() =>
      useConversationFind(
        {
          messages: [
            {
              ...message('projection', content),
              runtimeDisplayItems: [{ id: 'item', type: 'assistant_text', content }],
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
    expect(result.current.result).toEqual({ matches: 2, active: 1, isCapped: false })
    act(() => result.current.step(1))
    expect(result.current.searchTarget).toMatchObject({ messageId: 'projection', occurrence: 1 })
    expect(result.current.historyFailed).toBe(false)
    expect(hydrate).not.toHaveBeenCalled()
  })

  test('deduplicates canonical region matches and resolves changed projection ids', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const projected = {
      ...message('projection-new', 'needle\n\nneedle needle'),
      runtimeDisplayItems: [
        { id: 'first-item', type: 'assistant_text' as const, content: 'needle' },
        { id: 'second-item', type: 'assistant_text' as const, content: 'needle needle' },
      ],
    }
    const search = vi.fn().mockResolvedValue({
      matches: [
        {
          messageId: 'projection-old',
          itemId: 'first-item',
          regionId: 'first-item',
          occurrence: 0,
          range: { start: 0, end: 6 },
          cursor: 'first-cursor',
        },
        {
          messageId: 'projection-old',
          itemId: 'first-item',
          regionId: 'first-item',
          occurrence: 1,
          range: { start: 7, end: 13 },
          cursor: 'second-cursor',
        },
      ],
      totalMatches: 2,
      isCapped: false,
    })
    const hydrate = vi.fn()
    const props = {
      messages: [projected],
      onSearchTranscript: search,
      onEnsureSearchMatch: hydrate,
    }
    const { result, rerender } = renderHook(props => useConversationFind(props, true), {
      initialProps: props,
    })
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
    })
    await act(async () => vi.advanceTimersByTime(150))
    expect(result.current.result).toEqual({ matches: 3, active: 1, isCapped: false })
    act(() => result.current.step(1))
    expect(result.current.searchTarget?.occurrence).toBe(1)
    expect(result.current.searchTarget).toMatchObject({
      regionId: 'first-item',
      range: { start: 7, end: 13 },
    })
    rerender({ ...props, messages: [{ ...projected, id: 'projection-rebuilt' }] })
    expect(result.current.searchTarget?.messageId).toBe('projection-rebuilt')
    expect(result.current.searchTarget?.occurrence).toBe(1)
    act(() => result.current.step(1))
    expect(result.current.searchTarget?.occurrence).toBe(2)
    expect(hydrate).not.toHaveBeenCalled()
    expect(search).toHaveBeenCalledOnce()
  })

  test('keeps live items when a reading page has the same projected message id and overlapping items', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const separator: NonNullable<WorkbenchMessage['blocks']>[number] = {
      id: 'tool-boundary',
      subtaskId: 'turn',
      type: 'tool',
      toolName: 'shell',
      toolInput: {},
      status: 'done',
      createdAt: 0,
    }
    const live: WorkbenchMessage = {
      ...message('same-projection', 'needle\n\nneedle'),
      blocks: [separator],
      runtimeDisplayItems: [
        { id: 'shared-item', type: 'assistant_text', content: 'needle' },
        { id: separator.id, type: 'block' },
        { id: 'streaming-item', type: 'assistant_text', content: 'needle' },
      ],
    }
    const page: WorkbenchMessage = {
      ...message('same-projection', 'needle\n\nneedle'),
      blocks: [separator],
      runtimeDisplayItems: [
        { id: 'old-item', type: 'assistant_text', content: 'needle' },
        { id: separator.id, type: 'block' },
        { id: 'shared-item', type: 'assistant_text', content: 'needle' },
      ],
    }
    const search = vi.fn().mockResolvedValue({
      matches: [
        {
          itemId: 'old-item',
          regionId: 'old-item',
          occurrence: 0,
          range: { start: 0, end: 6 },
          cursor: 'old',
        },
        {
          itemId: 'shared-item',
          regionId: 'shared-item',
          occurrence: 0,
          range: { start: 0, end: 6 },
          cursor: 'shared',
        },
      ],
      totalMatches: 2,
      isCapped: false,
    })
    const hydrate = vi.fn()
    const { result } = renderHook(() =>
      useConversationFind(
        {
          messages: [live],
          searchMessages: [page],
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
    expect(result.current.result).toEqual({ matches: 3, active: 1, isCapped: false })
    expect(result.current.searchTarget).toMatchObject({
      messageId: 'same-projection',
      occurrence: 0,
      source: 'page',
    })
    act(() => result.current.step(1))
    expect(result.current.searchTarget).toMatchObject({ occurrence: 1, source: 'page' })
    act(() => result.current.step(1))
    expect(result.current.searchTarget?.occurrence).toBe(1)
    expect(result.current.searchTarget).not.toHaveProperty('source')
    expect(hydrate).not.toHaveBeenCalled()
    expect(search).toHaveBeenCalledOnce()
  })

  test('resolves a selected canonical range after the complete assistant region loads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const selectedMatch = {
      itemId: 'preceding-item',
      regionId: 'preceding-item',
      occurrence: 3,
      range: { start: 21, end: 27 },
      cursor: 'target-cursor',
    }
    const search = vi
      .fn()
      .mockResolvedValue({ matches: [selectedMatch], totalMatches: 1, isCapped: false })
    let finishHydration!: () => void
    const hydrate = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishHydration = resolve
        })
    )
    const props: Parameters<typeof useConversationFind>[0] = {
      messages: [],
      onSearchTranscript: search,
      onEnsureSearchMatch: hydrate,
    }
    const { result, rerender } = renderHook(props => useConversationFind(props, true), {
      initialProps: props,
    })
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
    })
    await act(async () => vi.advanceTimersByTime(150))
    expect(result.current.searchTarget).toBeNull()
    await act(async () => finishHydration())
    expect(result.current.searchTarget).toBeNull()
    expect(result.current.isLoading).toBe(true)
    rerender({
      ...props,
      messages: [
        {
          ...message('merged-projection', 'needle needle\n\nneedle needle'),
          runtimeDisplayItems: [
            { id: 'preceding-item', type: 'assistant_text', content: 'needle needle' },
            { id: 'target-item', type: 'assistant_text', content: 'needle needle' },
          ],
        },
      ],
    })
    expect(result.current.searchTarget?.messageId).toBe('merged-projection')
    expect(result.current.searchTarget?.occurrence).toBe(3)
    expect(result.current.searchTarget).toMatchObject({
      regionId: 'preceding-item',
      range: { start: 21, end: 27 },
    })
    expect(result.current.isLoading).toBe(false)
    expect(hydrate).toHaveBeenCalledOnce()
  })

  test.each(['replace', 'clear', 'close', 'inactive', 'switch'] as const)(
    'aborts stale persisted search on %s and ignores its completion',
    async reason => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let finishOld!: (response: { matches: []; totalMatches: number; isCapped: boolean }) => void
      const search = vi.fn<
        NonNullable<Parameters<typeof useConversationFind>[0]['onSearchTranscript']>
      >(
        () =>
          new Promise<{ matches: []; totalMatches: number; isCapped: boolean }>(resolve => {
            finishOld = resolve
          })
      )
      const hydrate = vi.fn()
      const props = {
        conversationKey: 'old-task',
        messages: [],
        onSearchTranscript: search,
        onEnsureSearchMatch: hydrate,
        active: true,
      }
      const { result, rerender } = renderHook(
        ({ active, ...props }) => useConversationFind(props, active),
        { initialProps: props }
      )
      act(() => {
        fireEvent.keyDown(window, { key: 'f', metaKey: true })
        result.current.changeQuery('old')
      })
      await act(async () => vi.advanceTimersByTime(150))
      const signal = search.mock.calls[0][1]
      act(() => {
        if (reason === 'replace') result.current.changeQuery('new')
        if (reason === 'clear') result.current.changeQuery('')
        if (reason === 'close') result.current.close()
        if (reason === 'inactive') rerender({ ...props, active: false })
        if (reason === 'switch') rerender({ ...props, conversationKey: 'new-task' })
      })
      expect(signal.aborted).toBe(true)
      await act(async () => finishOld({ matches: [], totalMatches: 999, isCapped: false }))
      expect(result.current.result.matches).toBe(0)
      expect(hydrate).not.toHaveBeenCalled()
      expect(result.current.historyFailed).toBe(false)
    }
  )

  test('aborts selected-match hydration when the query changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const target = { itemId: 'old-item', occurrence: 0, cursor: 'old-cursor' }
    const search = vi
      .fn()
      .mockResolvedValue({ matches: [target], totalMatches: 1, isCapped: false })
    let finishHydration!: () => void
    const hydrate = vi.fn<
      NonNullable<Parameters<typeof useConversationFind>[0]['onEnsureSearchMatch']>
    >(
      () =>
        new Promise<void>(resolve => {
          finishHydration = resolve
        })
    )
    const { result } = renderHook(() =>
      useConversationFind(
        { messages: [], onSearchTranscript: search, onEnsureSearchMatch: hydrate },
        true
      )
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('old')
    })
    await act(async () => vi.advanceTimersByTime(150))
    expect(hydrate).toHaveBeenCalledOnce()
    act(() => result.current.changeQuery('new'))
    expect(hydrate.mock.calls[0][1].aborted).toBe(true)
    await act(async () => finishHydration())
    expect(result.current.searchTarget).toBeNull()
    expect(result.current.historyFailed).toBe(false)
    expect(hydrate).toHaveBeenCalledOnce()
  })

  test('does not reload an old match while the replacement query is searching', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const oldTarget = { itemId: 'old-item', occurrence: 0, cursor: 'old-cursor' }
    const newTarget = { itemId: 'new-item', occurrence: 0, cursor: 'new-cursor' }
    let finishSearch!: (response: RuntimeTranscriptSearchResponse) => void
    const search = vi
      .fn<NonNullable<Parameters<typeof useConversationFind>[0]['onSearchTranscript']>>()
      .mockResolvedValueOnce({ matches: [oldTarget], totalMatches: 1, isCapped: false })
      .mockImplementation(
        () =>
          new Promise(resolve => {
            finishSearch = resolve
          })
      )
    const hydrate = vi.fn().mockResolvedValue(undefined)
    const props: Parameters<typeof useConversationFind>[0] = {
      messages: [],
      onSearchTranscript: search,
      onEnsureSearchMatch: hydrate,
    }
    const { result, rerender } = renderHook(props => useConversationFind(props, true), {
      initialProps: props,
    })
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('old')
    })
    await act(async () => vi.advanceTimersByTime(150))
    expect(hydrate).toHaveBeenCalledOnce()
    rerender({
      ...props,
      searchMessages: [
        {
          ...message('projected-old', 'old'),
          runtimeDisplayItems: [{ id: 'old-item', type: 'assistant_text', content: 'old' }],
        },
      ],
    })
    expect(result.current.searchTarget?.messageId).toBe('projected-old')

    act(() => result.current.changeQuery('new'))
    rerender(props)
    await act(async () => vi.advanceTimersByTime(150))
    expect(search).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTime(1500))
    expect(result.current.isLoading).toBe(true)
    expect(result.current.historyFailed).toBe(false)
    expect(hydrate).toHaveBeenCalledOnce()

    await act(async () => finishSearch({ matches: [newTarget], totalMatches: 1, isCapped: false }))
    expect(hydrate).toHaveBeenCalledTimes(2)
    expect(hydrate).toHaveBeenLastCalledWith(
      expect.objectContaining(newTarget),
      expect.any(AbortSignal)
    )
  })

  test('retry repeats a failed search without reloading the transcript', async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(new Error('search unavailable'))
      .mockResolvedValue({ matches: [], totalMatches: 0, isCapped: false })
    const reload = vi.fn()
    const hydrate = vi.fn()
    render(
      <FindHarness
        messages={[message('current', 'needle')]}
        onSearchTranscript={search}
        onEnsureSearchMatch={hydrate}
        onLoadMoreBefore={reload}
        hasMoreBefore
      />
    )
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    fireEvent.change(screen.getByTestId('conversation-find-input'), { target: { value: 'needle' } })
    await waitFor(() => expect(screen.getByTestId('conversation-find-retry')).toBeInTheDocument())
    expect(screen.getByTestId('conversation-find-retry')).toHaveTextContent('搜索失败')
    fireEvent.click(screen.getByTestId('conversation-find-retry'))
    await waitFor(() =>
      expect(screen.queryByTestId('conversation-find-loading-icon')).not.toBeInTheDocument()
    )
    expect(search).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('conversation-find-count')).toHaveTextContent('1 / 1')
    expect(reload).not.toHaveBeenCalled()
    expect(hydrate).not.toHaveBeenCalled()
  })

  test('retry repeats only a failed selected-match load', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const target = { itemId: 'old-item', occurrence: 0, cursor: 'old-cursor' }
    const search = vi
      .fn()
      .mockResolvedValue({ matches: [target], totalMatches: 1, isCapped: false })
    const hydrate = vi
      .fn()
      .mockRejectedValueOnce(new Error('load unavailable'))
      .mockResolvedValue(undefined)
    const props: Parameters<typeof useConversationFind>[0] = {
      messages: [],
      onSearchTranscript: search,
      onEnsureSearchMatch: hydrate,
    }
    const { result, rerender } = renderHook(props => useConversationFind(props, true), {
      initialProps: props,
    })
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
    })
    await act(async () => vi.advanceTimersByTime(150))
    expect(result.current.historyFailed).toBe(true)
    expect(result.current.failure).toBe('load')
    expect(result.current.isLoading).toBe(false)
    await act(async () => result.current.retry())
    expect(hydrate).toHaveBeenCalledTimes(2)
    expect(result.current.isLoading).toBe(true)
    rerender({
      ...props,
      messages: [
        {
          ...message('loaded', 'needle'),
          runtimeDisplayItems: [{ id: 'old-item', type: 'assistant_text', content: 'needle' }],
        },
      ],
    })
    expect(result.current.historyFailed).toBe(false)
    expect(result.current.searchTarget?.messageId).toBe('loaded')
    expect(search).toHaveBeenCalledOnce()
  })

  test('classifies an unresolved completed load as location failure and rebuilds its search', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const search = vi
      .fn()
      .mockResolvedValueOnce({
        matches: [{ itemId: 'missing', occurrence: 0, cursor: 'missing-cursor' }],
        totalMatches: 1,
        isCapped: false,
      })
      .mockResolvedValue({ matches: [], totalMatches: 0, isCapped: false })
    const hydrate = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useConversationFind(
        { messages: [], onSearchTranscript: search, onEnsureSearchMatch: hydrate },
        true
      )
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
    })
    await act(async () => vi.advanceTimersByTime(150))
    act(() => vi.advanceTimersByTime(1500))
    expect(result.current.failure).toBe('locate')
    expect(result.current.historyFailed).toBe(false)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.searchTarget).toBeNull()
    expect(hydrate).toHaveBeenCalledOnce()
    act(() => result.current.retry())
    await act(async () => vi.advanceTimersByTime(150))
    expect(search).toHaveBeenCalledTimes(2)
    expect(hydrate).toHaveBeenCalledOnce()
    expect(result.current.failure).toBeNull()
    expect(result.current.result.matches).toBe(0)
  })
})
