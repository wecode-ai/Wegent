import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useBufferedStreamingText } from './useBufferedStreamingText'

describe('useBufferedStreamingText', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
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

  test('flushes the latest content when an animation frame is unavailable', () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const { result, rerender } = renderHook(
      ({ content }) => useBufferedStreamingText(content, true),
      { initialProps: { content: 'Partial response' } }
    )

    rerender({ content: 'Partial response with the appended text' })
    expect(result.current).toBe('Partial response')

    act(() => vi.advanceTimersByTime(100))
    expect(result.current).toBe('Partial response with the appended text')
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
