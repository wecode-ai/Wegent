import { act, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import * as conversationSearch from './conversationSearch'
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
        subtaskId: 'turn',
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

describe('conversation search indexing', () => {
  test('keeps distinct visible blocks with equal text addressable by their own item ids', () => {
    const projected: WorkbenchMessage = {
      ...message('projection', 'tail'),
      blocks: ['first-block', 'second-block'].map(id => ({
        id,
        subtaskId: 'turn',
        type: 'text' as const,
        content: 'needle',
        status: 'done' as const,
        createdAt: 0,
      })),
      runtimeDisplayItems: [
        { id: 'first-block', type: 'block' },
        { id: 'second-block', type: 'block' },
        { id: 'final-item', type: 'assistant_text', content: 'tail' },
      ],
    }
    const index = conversationSearch.deduplicateConversationSearchIndex([
      {
        messageId: projected.id,
        message: projected,
        text: conversationSearch.conversationSearchText(projected),
      },
    ])
    expect(conversationSearch.findConversationMatches(index, 'needle')).toEqual({
      matches: [
        { messageId: 'first-block', occurrence: 0 },
        { messageId: 'second-block', occurrence: 0 },
      ],
      totalMatches: 2,
      isCapped: false,
    })
    expect(
      conversationSearch.resolveConversationMatch(
        { messageId: '', itemId: 'second-block', occurrence: 0 },
        [projected],
        'needle'
      )
    ).toEqual({ messageId: projected.id, occurrence: 1 })
  })

  test('keeps the navigation target stable while unrelated messages stream', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const matched = message('matched', 'needle')
    const streaming = { ...message('streaming', 'hello'), status: 'streaming' as const }
    const { result, rerender } = renderHook(
      ({ messages }) => useConversationFind({ messages }, true),
      { initialProps: { messages: [matched, streaming] } }
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
    })
    act(() => vi.advanceTimersByTime(150))
    const firstTarget = result.current.searchTarget
    expect(firstTarget?.messageId).toBe('matched')

    rerender({ messages: [matched, { ...streaming, content: 'hello world' }] })
    expect(result.current.searchTarget).toBe(firstTarget)

    act(() => result.current.step(1))
    const requestedTarget = result.current.searchTarget
    expect(requestedTarget).toEqual(firstTarget)
    expect(requestedTarget).not.toBe(firstTarget)
    rerender({ messages: [matched, { ...streaming, content: 'hello world again' }] })
    expect(result.current.searchTarget).toBe(requestedTarget)

    rerender({ messages: [matched, { ...streaming, content: 'hello needle' }] })
    expect(result.current.searchTarget).not.toBe(requestedTarget)
    expect(result.current.searchTarget?.matchCounts).toEqual(
      new Map([
        ['matched', 1],
        ['streaming', 1],
      ])
    )
    act(() => result.current.step(1))
    expect(result.current.searchTarget?.messageId).toBe('streaming')
  })

  test('reuses unchanged message text while indexing streaming replacements and new history', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const searchText = vi.spyOn(conversationSearch, 'conversationSearchText')
    const history = [message('history', '**needle**'), message('empty', '')]
    const streaming = { ...message('streaming', 'needle'), status: 'streaming' as const }
    const { result, rerender } = renderHook(
      ({ messages }) => useConversationFind({ messages }, true),
      { initialProps: { messages: [...history, streaming] } }
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('needle')
    })
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.result.matches).toBe(2)
    expect(searchText).toHaveBeenCalledTimes(3)

    searchText.mockClear()
    const updatedStreaming = { ...streaming, content: 'needle needle' }
    rerender({ messages: [...history, updatedStreaming] })
    expect(result.current.result.matches).toBe(3)
    expect(searchText).toHaveBeenCalledExactlyOnceWith(updatedStreaming)

    searchText.mockClear()
    act(() => result.current.changeQuery('missing'))
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.result.matches).toBe(0)
    expect(searchText).not.toHaveBeenCalled()

    const replacedHistory = { ...history[0], content: 'missing' }
    const olderHistory = message('older', 'missing', 'user')
    rerender({ messages: [olderHistory, replacedHistory, history[1], updatedStreaming] })
    expect(result.current.result.matches).toBe(2)
    expect(result.current.searchTarget?.messageId).toBe('older')
    expect(searchText.mock.calls.map(([item]) => item)).toEqual([olderHistory, replacedHistory])
  })

  test('refreshes projected replies when an earlier question changes or disappears', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const reply = message('reply', '**answer**', 'user')
    const { result, rerender } = renderHook(
      ({ messages }) => useConversationFind({ messages }, true),
      { initialProps: { messages: [questionMessage('Initial question'), reply] } }
    )
    act(() => {
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      result.current.changeQuery('Initial')
    })
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.result.matches).toBe(1)
    expect(result.current.searchTarget?.messageId).toBe('reply')

    rerender({ messages: [questionMessage('Updated question'), reply] })
    expect(result.current.result.matches).toBe(0)
    act(() => result.current.changeQuery('Updated'))
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.result.matches).toBe(1)
    expect(result.current.searchTarget?.messageId).toBe('reply')

    rerender({ messages: [reply] })
    expect(result.current.result.matches).toBe(0)
    act(() => result.current.changeQuery('**answer**'))
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.result.matches).toBe(0)

    rerender({ messages: [questionMessage('Restored question'), reply] })
    expect(result.current.result.matches).toBe(1)
    expect(result.current.searchTarget?.messageId).toBe('reply')
  })
})
