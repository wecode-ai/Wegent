import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { resolveAsyncRequestUserInputReplies } from '@wegent/chat-core/runtime-user-input'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { ConversationTranslationProvider, UserMessage } from '@wegent/collaboration/conversation'
import { conversationSearchRanges } from '../../../../packages/collaboration/src/conversation/useConversationSearchTarget'
import { resolveConversationMatch } from './conversationSearch'
import { useConversationFind } from './useConversationFind'

vi.mock('@/lib/platform', () => ({ getPlatform: () => 'mac' }))

function message(
  id: string,
  content: string,
  role: WorkbenchMessage['role'] = 'assistant'
): WorkbenchMessage {
  return { id, content, role, status: 'done', createdAt: '2026-10-14T00:00:00Z' }
}

function questionMessage(question: string): WorkbenchMessage {
  return {
    ...message('question', ''),
    blocks: [
      {
        id: 'question-block',
        subtaskId: 'question-turn',
        type: 'tool',
        toolName: 'request_user_input',
        status: 'done',
        createdAt: 0,
        renderPayload: {
          kind: 'request_user_input',
          delivery: 'async',
          questions: [{ id: 'question', question }],
        },
      },
    ],
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('persisted async question replies', () => {
  for (const location of ['live', 'page'] as const) {
    test.each([
      { query: 'question-only', count: 1 },
      { query: '**literal-answer**', count: 1 },
      { query: 'needle', count: 3 },
    ])(
      'resolves and highlights $query in hydrated ' + location + ' messages',
      async ({ query, count }) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const reply = message('client-reply', '**literal-answer** needle', 'user')
        const question = questionMessage('question-only needle needle?')
        const matches = Array.from({ length: count }, (_, occurrence) => ({
          messageId: reply.id,
          itemId: 'provider-reply',
          replyQuestions: ['question-only needle needle?'],
          occurrence,
          cursor: 'reply-cursor',
        }))
        const search = vi.fn().mockResolvedValue({ matches, totalMatches: count, isCapped: false })
        let finishHydration!: () => void
        const hydrate = vi.fn(
          () =>
            new Promise<void>(resolve => {
              finishHydration = resolve
            })
        )
        const original = [message('latest', 'Latest conversation')]
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
          result.current.changeQuery(query)
        })
        await act(async () => vi.advanceTimersByTime(150))
        expect(hydrate).toHaveBeenCalledOnce()
        expect(result.current.searchTarget).toBeNull()

        const hydrated = [question, reply]
        rerender({
          ...props,
          ...(location === 'live'
            ? { messages: [...hydrated, ...original] }
            : { searchMessages: hydrated }),
        })
        await act(async () => finishHydration())
        await act(async () => vi.advanceTimersByTime(1500))
        expect(result.current.result).toEqual({ matches: count, active: 1, isCapped: false })
        expect(result.current.historyFailed).toBe(false)
        expect(result.current.isLoading).toBe(false)

        const { container } = render(
          <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
            <UserMessage
              message={reply}
              replyQuestions={resolveAsyncRequestUserInputReplies(hydrated).get(reply.id)}
              services={{ images: { identity: vi.fn(), load: vi.fn(), download: vi.fn() } }}
            />
          </ConversationTranslationProvider>
        )
        const ranges = conversationSearchRanges(container, query, 250)
        expect(ranges.map(range => range.toString())).toEqual(Array(count).fill(query))
        for (let occurrence = 0; occurrence < count; occurrence += 1) {
          expect(result.current.searchTarget).toMatchObject({ messageId: reply.id, occurrence })
          expect(result.current.searchTarget?.matchCounts.get(reply.id)).toBe(count)
          if (location === 'page') expect(result.current.searchTarget?.source).toBe('page')
          act(() => result.current.step(1))
        }
        expect(hydrate).toHaveBeenCalledOnce()
        act(() => result.current.close())
        expect(result.current.searchTarget).toBeNull()
        expect(original).toEqual([message('latest', 'Latest conversation')])
      }
    )
  }

  test.each([false, true])(
    'hydrates question context before accepting an already loaded answer (stale question: %s)',
    async staleQuestion => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const reply = message('client-reply', 'needle', 'user')
      const question = questionMessage('needle needle?')
      const matches = Array.from({ length: 3 }, (_, occurrence) => ({
        messageId: reply.id,
        itemId: 'provider-reply',
        replyQuestions: ['needle needle?'],
        occurrence,
        cursor: 'reply-cursor',
      }))
      let finishHydration!: () => void
      const hydrate = vi.fn(
        () =>
          new Promise<void>(resolve => {
            finishHydration = resolve
          })
      )
      const props: Parameters<typeof useConversationFind>[0] = {
        messages: [...(staleQuestion ? [questionMessage('Different needle?')] : []), reply],
        onSearchTranscript: vi
          .fn()
          .mockResolvedValue({ matches, totalMatches: 3, isCapped: false }),
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
      expect(result.current.searchTarget).toBeNull()

      rerender({ ...props, searchMessages: [question, reply] })
      await act(async () => finishHydration())
      await act(async () => vi.advanceTimersByTime(1500))
      expect(result.current.searchTarget).toMatchObject({
        messageId: reply.id,
        occurrence: 0,
        source: 'page',
      })
      expect(result.current.result).toEqual({ matches: 3, active: 1, isCapped: false })
      expect(result.current.historyFailed).toBe(false)
      act(() => result.current.step(1))
      act(() => result.current.step(1))
      expect(result.current.searchTarget?.occurrence).toBe(2)
      expect(hydrate).toHaveBeenCalledOnce()
    }
  )

  test('refreshes historical reply validation when its question changes or disappears', () => {
    const reply = message('reply', '**answer**', 'user')
    const target = { messageId: reply.id, occurrence: 0, cursor: 'reply-cursor' }
    const resolve = (query: string, questions: WorkbenchMessage[]) =>
      resolveConversationMatch(target, [...questions, reply], query)

    // First cache the ordinary Markdown presentation of the same reply object.
    expect(resolve('**answer**', [])).toBeNull()
    expect(resolve('Initial', [questionMessage('Initial question')])).toEqual({
      messageId: reply.id,
      occurrence: 0,
    })
    expect(resolve('Initial', [questionMessage('Updated question')])).toBeNull()
    expect(resolve('Updated', [questionMessage('Updated question')])).toEqual({
      messageId: reply.id,
      occurrence: 0,
    })
    expect(resolve('**answer**', [questionMessage('Updated question')])).toEqual({
      messageId: reply.id,
      occurrence: 0,
    })
    expect(resolve('**answer**', [])).toBeNull()
    expect(resolve('answer', [])).toEqual({ messageId: reply.id, occurrence: 0 })
  })

  test('does not borrow questions from another reading window', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const reply = message('reply', '**answer**', 'user')
    const question = questionMessage('needle?')
    const target = { messageId: reply.id, occurrence: 0, cursor: 'reply-cursor' }
    expect(resolveConversationMatch(target, [reply], 'needle', [question])).toBeNull()
    expect(resolveConversationMatch(target, [question], 'needle', [reply])).toBeNull()
    expect(resolveConversationMatch(target, [reply], '**answer**', [question])).toBeNull()

    const { result } = renderHook(() =>
      useConversationFind({ messages: [reply], searchMessages: [question] }, true)
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
    })
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.result.matches).toBe(0)
    expect(result.current.searchTarget).toBeNull()
  })
})
