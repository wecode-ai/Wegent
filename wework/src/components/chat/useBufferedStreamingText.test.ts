import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { computeStreamingRevealStep, useBufferedStreamingText } from './useBufferedStreamingText'

describe('useBufferedStreamingText', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('reveals coalesced streaming updates progressively', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ content }) => useBufferedStreamingText(content, true),
      { initialProps: { content: 'Hello' } }
    )

    rerender({ content: 'Hello world' })
    rerender({ content: 'Hello world again' })
    expect(result.current).toBe('Hello')

    act(() => vi.advanceTimersByTime(32))
    expect('Hello world again'.startsWith(result.current)).toBe(true)
    expect(result.current.length).toBeGreaterThan('Hello'.length)
    expect(result.current).not.toBe('Hello world again')

    act(() => vi.advanceTimersByTime(500))
    expect(result.current).toBe('Hello world again')
  })

  test('flushes the latest content in a hidden background window', () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
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

  test('keeps the authoritative snapshot after reduced motion is toggled off', () => {
    vi.useFakeTimers()
    const complete = `A${'b'.repeat(80)}`
    const { result, rerender } = renderHook(
      ({ content, reducedMotion }) => useBufferedStreamingText(content, true, { reducedMotion }),
      {
        initialProps: {
          content: 'A',
          reducedMotion: false,
        },
      }
    )

    rerender({ content: complete, reducedMotion: false })
    act(() => vi.advanceTimersByTime(32))
    expect(result.current).not.toBe(complete)

    rerender({ content: complete, reducedMotion: true })
    expect(result.current).toBe(complete)
    act(() => vi.runOnlyPendingTimers())

    rerender({ content: complete, reducedMotion: false })
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

  test('does not split Unicode code points while revealing', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ content }) => useBufferedStreamingText(content, true),
      { initialProps: { content: '' } }
    )

    rerender({ content: '😀你好' })
    act(() => vi.advanceTimersByTime(32))

    expect(['', '😀', '😀你', '😀你好']).toContain(result.current)
  })
})

describe('computeStreamingRevealStep', () => {
  test('accelerates as the backlog grows without exceeding it', () => {
    const small = computeStreamingRevealStep(4, 16, 0)
    const large = computeStreamingRevealStep(400, 16, 0)

    expect(large.speedCps).toBeGreaterThan(small.speedCps)
    expect(large.revealChars).toBeGreaterThan(small.revealChars)
    expect(large.revealChars).toBeLessThanOrEqual(400)
  })

  test('retains fractional reveal debt for stable low-speed motion', () => {
    const first = computeStreamingRevealStep(2, 5, 0)
    const second = computeStreamingRevealStep(2, 5, first.debt)

    expect(first.revealChars).toBe(0)
    expect(first.debt).toBeGreaterThan(0)
    expect(second.debt).toBeGreaterThan(first.debt)
  })

  test('applies layout backpressure to the reveal rate', () => {
    const fullSpeed = computeStreamingRevealStep(200, 32, 0, 1)
    const pressured = computeStreamingRevealStep(200, 32, 0, 0.55)

    expect(pressured.revealChars).toBeLessThan(fullSpeed.revealChars)
    expect(pressured.speedCps).toBe(fullSpeed.speedCps)
  })
})
