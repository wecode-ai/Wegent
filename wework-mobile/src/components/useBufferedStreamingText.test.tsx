import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBufferedStreamingText } from '../../../packages/collaboration/src/markdown/useBufferedStreamingText'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('native streaming presentation buffer', () => {
  let renderer: ReactTestRenderer | undefined
  let displayed = ''
  function Probe({ content, streaming }: { content: string; streaming: boolean }) {
    displayed = useBufferedStreamingText(content, streaming, 48)
    return null
  }
  async function update(content: string, streaming = true) {
    await act(() => {
      const element = <Probe content={content} streaming={streaming} />
      if (renderer) renderer.update(element)
      else renderer = create(element)
    })
  }
  const advance = async (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 16)
    )
    vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  })
  afterEach(async () => {
    if (renderer) await act(() => renderer!.unmount())
    renderer = undefined
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('coalesces continuous deltas without restarting the flush deadline', async () => {
    await update('A')
    await update('Ab')
    for (const content of ['Abc', 'Abcd', 'Abcde', 'Abcdef']) {
      await advance(10)
      await update(content)
    }
    expect(displayed).toBe('A')
    await advance(24)
    expect(displayed).toBe('Abcdef')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('publishes the first glyph immediately instead of showing an empty row', async () => {
    await update('')
    await update('你')
    expect(displayed).toBe('你')
    await update('你好😀')
    expect(displayed).toBe('你')
    await advance(64)
    expect(displayed).toBe('你好😀')
  })

  it.each(['completed', 'failed', 'cancelled'])(
    'shows the authoritative terminal snapshot immediately: %s',
    async state => {
      await update('Draft')
      await update('Draft with pending text')
      await update(`Final ${state} snapshot`, false)
      expect(displayed).toBe(`Final ${state} snapshot`)
      await advance(200)
      expect(displayed).toBe(`Final ${state} snapshot`)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('replaces changed or cleared content during streaming and cancels stale work', async () => {
    await update('Previous')
    await update('Previous pending')
    await update('Replacement')
    expect(displayed).toBe('Replacement')
    await update('')
    expect(displayed).toBe('')
    await advance(200)
    expect(displayed).toBe('')
  })

  it('flushes with a bounded timer if native frames stop', async () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    await update('A')
    await update('A trailing text')
    await advance(148)
    expect(displayed).toBe('A trailing text')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases both batch and frame work on unmount', async () => {
    await update('A')
    await update('A pending')
    await advance(48)
    await act(() => renderer!.unmount())
    renderer = undefined
    expect(vi.getTimerCount()).toBe(0)
  })
})
