import { act, renderHook } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { useBufferedStreamingText } from './useBufferedStreamingText'

describe('useBufferedStreamingText', () => {
  test('coalesces streaming updates before rendering the latest content', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ content }) => useBufferedStreamingText(content, true),
      { initialProps: { content: 'Hello' } }
    )

    rerender({ content: 'Hello world' })
    rerender({ content: 'Hello world again' })
    expect(result.current).toBe('Hello')

    act(() => vi.advanceTimersByTime(50))
    expect(result.current).toBe('Hello world again')
    vi.useRealTimers()
  })

  test('renders completed content immediately and cancels a pending update', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ content, streaming }) => useBufferedStreamingText(content, streaming),
      { initialProps: { content: 'partial', streaming: true } }
    )

    rerender({ content: 'partial update', streaming: true })
    rerender({ content: 'complete', streaming: false })
    expect(result.current).toBe('complete')

    act(() => vi.runOnlyPendingTimers())
    expect(result.current).toBe('complete')
    vi.useRealTimers()
  })
})
