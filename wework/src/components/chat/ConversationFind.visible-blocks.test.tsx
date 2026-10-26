import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { createCollaborationTranslator } from '@wegent/collaboration'
import {
  AssistantMessage,
  ConversationTranslationProvider,
} from '@wegent/collaboration/conversation'
import { conversationSearchRanges } from '../../../../packages/collaboration/src/conversation/useConversationSearchTarget'
import {
  conversationSearchText,
  deduplicateConversationSearchIndex,
  findConversationMatches,
  resolveConversationMatch,
} from './conversationSearch'
import { useConversationFind } from './useConversationFind'
import '@/i18n'

vi.mock('@/lib/platform', () => ({ getPlatform: () => 'mac' }))

function projectedMessage(state: 'failed' | 'cancelled' | 'done' | 'partial' | 'empty') {
  const content =
    state === 'cancelled'
      ? 'interrupted'
      : state === 'partial'
        ? 'Useful partial needle'
        : state === 'empty'
          ? ''
          : 'API error: failed'
  const message: WorkbenchMessage = {
    id: 'projection',
    role: 'assistant',
    content,
    error: 'API error: failed',
    status: state === 'failed' ? 'failed' : 'done',
    runtimeStatus:
      state === 'cancelled' || state === 'partial'
        ? 'cancelled'
        : state === 'failed'
          ? 'failed'
          : 'done',
    createdAt: '2026-10-23T00:00:00Z',
    blocks: ['first-block', 'second-block'].map((id, index) => ({
      id,
      subtaskId: 'turn',
      type: 'text',
      content: index === 0 ? '**needle** needle' : 'needle',
      status: 'done',
      createdAt: index,
    })),
    runtimeDisplayItems: [
      { id: 'first-block', type: 'block' },
      { id: 'second-block', type: 'block' },
      { id: 'final-item', type: 'assistant_text', content },
    ],
  }
  return message
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('visible process text in terminal conversation search', () => {
  test.each(['failed', 'cancelled', 'empty', 'done', 'partial'] as const)(
    'preserves visible block item identities after %s turns',
    state => {
      const projected = projectedMessage(state)
      const text = conversationSearchText(projected)
      const index = deduplicateConversationSearchIndex([
        { messageId: projected.id, message: projected, text },
      ])
      const visibleFinal = state === 'done' || state === 'partial'
      expect(index.map(entry => entry.itemId)).toEqual([
        'first-block',
        'second-block',
        ...(visibleFinal ? ['final-item'] : []),
      ])
      expect(text).toBe(`needle needle\nneedle${visibleFinal ? `\n${projected.content}` : ''}`)
      const matches = findConversationMatches(index, 'needle')
      expect(matches.totalMatches).toBe(state === 'partial' ? 4 : 3)
      expect(matches.matches.slice(0, 3)).toEqual([
        {
          messageId: 'first-block',
          occurrence: 0,
          regionId: 'first-block',
          range: { start: 0, end: 6 },
        },
        {
          messageId: 'first-block',
          occurrence: 1,
          regionId: 'first-block',
          range: { start: 7, end: 13 },
        },
        {
          messageId: 'second-block',
          occurrence: 0,
          regionId: 'second-block',
          range: { start: 0, end: 6 },
        },
      ])
      const hiddenQuery = state === 'cancelled' ? 'interrupted' : 'API error: failed'
      expect(findConversationMatches(index, hiddenQuery).totalMatches).toBe(
        state === 'done' ? 1 : 0
      )
      expect(
        resolveConversationMatch(
          { itemId: 'second-block', messageId: '', occurrence: 0 },
          [projected],
          'needle'
        )
      ).toEqual({
        messageId: projected.id,
        occurrence: 2,
        regionId: 'second-block',
        range: { start: 0, end: 6 },
      })
    }
  )

  test('keeps block identities when a visible final item contains only citation metadata', () => {
    const projected = projectedMessage('done')
    projected.content = '\uE200cite\uE202turn0search2\uE201'
    projected.runtimeDisplayItems![2] = {
      id: 'final-item',
      type: 'assistant_text',
      content: projected.content,
    }
    const index = deduplicateConversationSearchIndex([
      { messageId: projected.id, message: projected, text: conversationSearchText(projected) },
    ])
    expect(conversationSearchText(projected)).toBe('needle needle\nneedle\n')
    expect(index.map(({ itemId, text }) => ({ itemId, text }))).toEqual([
      { itemId: 'first-block', text: 'needle needle' },
      { itemId: 'second-block', text: 'needle' },
      { itemId: 'final-item', text: '' },
    ])
    expect(findConversationMatches(index, 'needle').matches).toEqual([
      {
        messageId: 'first-block',
        occurrence: 0,
        regionId: 'first-block',
        range: { start: 0, end: 6 },
      },
      {
        messageId: 'first-block',
        occurrence: 1,
        regionId: 'first-block',
        range: { start: 7, end: 13 },
      },
      {
        messageId: 'second-block',
        occurrence: 0,
        regionId: 'second-block',
        range: { start: 0, end: 6 },
      },
    ])
    expect(
      resolveConversationMatch(
        { itemId: 'second-block', messageId: '', occurrence: 0 },
        [projected],
        'needle'
      )
    ).toEqual({
      messageId: projected.id,
      occurrence: 2,
      regionId: 'second-block',
      range: { start: 0, end: 6 },
    })
  })

  test.each(['failed', 'cancelled', 'empty'] as const)(
    'has no searchable units for %s messages without visible blocks',
    state => {
      const projected = { ...projectedMessage(state), blocks: [] }
      const index = deduplicateConversationSearchIndex([
        { messageId: projected.id, message: projected, text: conversationSearchText(projected) },
      ])
      expect(conversationSearchText(projected)).toBe('')
      expect(index).toEqual([])
    }
  )

  test.each([
    ['failed', 'live'],
    ['failed', 'page'],
    ['cancelled', 'live'],
    ['cancelled', 'page'],
  ] as const)(
    'locates every visible block after hydrating %s history into %s',
    async (state, location) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const hits = [
        { itemId: 'first-block', occurrence: 0, cursor: 'old-cursor' },
        { itemId: 'first-block', occurrence: 1, cursor: 'old-cursor' },
        { itemId: 'second-block', occurrence: 0, cursor: 'old-cursor' },
      ]
      const search = vi.fn().mockResolvedValue({ matches: hits, totalMatches: 3, isCapped: false })
      let finishHydration!: () => void
      const hydrate = vi.fn(
        () =>
          new Promise<void>(resolve => {
            finishHydration = resolve
          })
      )
      const original: WorkbenchMessage[] = [
        {
          id: 'latest',
          role: 'user',
          content: 'Latest prompt',
          status: 'done',
          createdAt: '2026-10-23T01:00:00Z',
        },
      ]
      const props: Parameters<typeof useConversationFind>[0] = {
        messages: original,
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

      const projected = projectedMessage(state)
      rerender({
        ...props,
        ...(location === 'live'
          ? { messages: [projected, ...original] }
          : { searchMessages: [projected] }),
      })
      await act(async () => finishHydration())
      await act(async () => vi.advanceTimersByTime(1500))

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
      expect(ranges.map(range => range.toString())).toEqual(['needle', 'needle', 'needle'])
      expect(container.querySelector('[data-testid="assistant-message-content"]')).toBeNull()
      expect(container.querySelectorAll('[data-testid="process-text-block"]')).toHaveLength(2)
      for (let occurrence = 0; occurrence < 3; occurrence += 1) {
        expect(result.current.result).toEqual({
          matches: 3,
          active: occurrence + 1,
          isCapped: false,
        })
        expect(result.current.searchTarget).toMatchObject({
          messageId: projected.id,
          occurrence,
          ...(location === 'page' ? { source: 'page' } : {}),
        })
        expect(result.current.historyFailed).toBe(false)
        expect(result.current.isLoading).toBe(false)
        expect(
          ranges[result.current.searchTarget!.occurrence].startContainer.parentElement?.closest(
            '[data-testid="process-text-block"]'
          )
        ).not.toBeNull()
        if (occurrence < 2) act(() => result.current.step(1))
      }
      expect(hydrate).toHaveBeenCalledOnce()
      for (const query of ['interrupted', 'API error: failed']) {
        expect(conversationSearchRanges(container, query, 250)).toEqual([])
      }
      act(() => result.current.close())
      rerender(props)
      expect(result.current.searchTarget).toBeNull()
      expect(props.messages).toBe(original)
      expect(original).toHaveLength(1)
    }
  )
})
