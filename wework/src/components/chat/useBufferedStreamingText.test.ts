import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useBufferedStreamingText } from './useBufferedStreamingText'

describe('useBufferedStreamingText', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
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

  test('cancels a pending fallback timer for a completed replacement', () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const { result, rerender } = renderHook(
      ({ content, streaming }) => useBufferedStreamingText(content, streaming),
      { initialProps: { content: 'Partial response', streaming: true } }
    )

    rerender({
      content: 'Partial response with the appended text',
      streaming: true,
    })
    rerender({ content: 'Authoritative completed response', streaming: false })

    act(() => vi.advanceTimersByTime(100))
    expect(result.current).toBe('Authoritative completed response')
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

  test('does not expose partial Unicode updates before the frame flush', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ content }) => useBufferedStreamingText(content, true),
      { initialProps: { content: '' } }
    )

    rerender({ content: '😀你好' })
    act(() => vi.advanceTimersByTime(32))

    expect(result.current).toBe('😀你好')
  })
})

test('keeps the original batch deadline while more text arrives', () => {
  vi.useFakeTimers()
  try {
    const { result, rerender, unmount } = renderHook(
      ({ content }) => useBufferedStreamingText(content, true, 100),
      { initialProps: { content: 'A' } }
    )
    rerender({ content: 'AB' })
    act(() => vi.advanceTimersByTime(90))
    rerender({ content: 'ABC' })
    expect(result.current).toBe('A')
    act(() => vi.advanceTimersByTime(10))
    act(() => vi.advanceTimersToNextFrame())
    expect(result.current).toBe('ABC')
    unmount()
  } finally {
    vi.useRealTimers()
  }
})

test.each([0, 100])('cancels all pending scheduling on detach (batch=%s)', async interval => {
  vi.useFakeTimers()
  try {
    const { rerender, unmount } = renderHook(
      ({ content }) => useBufferedStreamingText(content, true, interval),
      { initialProps: { content: 'A' } }
    )
    rerender({ content: 'AB' })
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await act(async () => unmount())
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test('ignores an already queued old animation frame after replacing the content', () => {
  vi.useFakeTimers()
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  try {
    const { result, rerender, unmount } = renderHook(
      ({ content }) => useBufferedStreamingText(content, true),
      { initialProps: { content: 'A' } }
    )
    rerender({ content: 'AB' })
    rerender({ content: 'X' })
    rerender({ content: 'XY' })
    act(() => frames[0](0))
    expect(result.current).toBe('X')
    act(() => frames[1](16))
    expect(result.current).toBe('XY')
    unmount()
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
