import { act, fireEvent, renderHook } from '@testing-library/react'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useConversationFind } from './useConversationFind'

vi.mock('@/lib/platform', () => ({ getPlatform: () => 'mac' }))

function message(
  id: string,
  content: string,
  role: WorkbenchMessage['role'] = 'assistant'
): WorkbenchMessage {
  return { id, content, role, status: 'done', createdAt: '2026-10-14T00:00:00Z' }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('conversation search indexing', () => {
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

  test('updates streaming replacements and new history while retaining unchanged matches', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
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

    const updatedStreaming = { ...streaming, content: 'needle needle' }
    rerender({ messages: [...history, updatedStreaming] })
    expect(result.current.result.matches).toBe(3)
    expect(result.current.searchTarget?.messageId).toBe('history')

    act(() => result.current.changeQuery('missing'))
    act(() => vi.advanceTimersByTime(150))
    expect(result.current.result.matches).toBe(0)
    expect(result.current.searchTarget).toBeNull()

    const replacedHistory = { ...history[0], content: 'missing' }
    const olderHistory = message('older', 'missing', 'user')
    rerender({ messages: [olderHistory, replacedHistory, history[1], updatedStreaming] })
    expect(result.current.result.matches).toBe(2)
    expect(result.current.searchTarget?.messageId).toBe('older')
    act(() => result.current.step(1))
    expect(result.current.searchTarget?.messageId).toBe('history')
  })
})
