import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useBufferedStreamingText } from './useBufferedStreamingText'

describe('useBufferedStreamingText', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('coalesces streaming updates into the next animation frame', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ content }) => useBufferedStreamingText(content, true),
      { initialProps: { content: 'Hello' } }
    )

    rerender({ content: 'Hello world' })
    rerender({ content: 'Hello world again' })
    expect(result.current).toBe('Hello')

    act(() => vi.advanceTimersToNextFrame())
    expect(result.current).toBe('Hello world again')
  })

  test('shows the authoritative completed snapshot immediately', () => {
    const complete = `A${'b'.repeat(80)}`
    const { result, rerender } = renderHook(
      ({ content, streaming }) => useBufferedStreamingText(content, streaming),
      { initialProps: { content: 'A', streaming: true } }
    )

    rerender({ content: complete, streaming: false })
    expect(result.current).toBe(complete)
  })

  test('replaces non-append content immediately', () => {
    const { result, rerender } = renderHook(
      ({ content, streaming }) => useBufferedStreamingText(content, streaming),
      { initialProps: { content: 'partial', streaming: true } }
    )

    rerender({ content: 'replacement', streaming: false })
    expect(result.current).toBe('replacement')
  })
})
