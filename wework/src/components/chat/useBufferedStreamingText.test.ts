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

  test('drains a quickly completed stream over multiple frames', () => {
    vi.useFakeTimers()
    const complete = `A${'b'.repeat(80)}`
    const { result, rerender } = renderHook(
      ({ content, streaming }) => useBufferedStreamingText(content, streaming),
      { initialProps: { content: 'A', streaming: true } }
    )

    rerender({ content: complete, streaming: false })
    expect(result.current).toBe('A')

    act(() => vi.advanceTimersToNextFrame())
    expect(result.current.length).toBeGreaterThan(1)
    expect(result.current.length).toBeLessThan(complete.length)

    act(() => vi.runAllTimers())
    expect(result.current).toBe(complete)
  })

  test('does not split a surrogate pair while draining completed content', () => {
    vi.useFakeTimers()
    const complete = `A${'b'.repeat(9)}😀${'c'.repeat(68)}`
    const { result, rerender } = renderHook(
      ({ content, streaming }) => useBufferedStreamingText(content, streaming),
      { initialProps: { content: 'A', streaming: true } }
    )

    rerender({ content: complete, streaming: false })
    act(() => vi.advanceTimersToNextFrame())
    expect(result.current).toBe(`A${'b'.repeat(9)}`)

    act(() => vi.runAllTimers())
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
