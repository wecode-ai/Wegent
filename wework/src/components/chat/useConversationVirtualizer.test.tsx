import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  useConversationVirtualizer,
  type ConversationVirtualizer,
} from '../../../../packages/collaboration/src/conversation/useConversationVirtualizer'
import {
  getConversationDiagnosticsSnapshot,
  resetConversationDiagnosticsForTest,
  startConversationDiagnosticCapture,
} from '../../../../packages/collaboration/src/conversation/conversationDiagnostics'

function fixture(enabled = true) {
  const viewport = document.createElement('div')
  const list = document.createElement('div')
  viewport.append(list)
  document.body.append(viewport)
  Object.defineProperties(viewport, {
    clientHeight: { value: 200 },
    clientWidth: { value: 800 },
    scrollHeight: { value: 1120 },
  })
  viewport.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    viewport.scrollTop = Number(top)
  })
  viewport.getBoundingClientRect = () => new DOMRect(0, 100, 800, 200)
  list.getBoundingClientRect = () => new DOMRect(0, 140 - viewport.scrollTop, 800, 1000)
  const engineRef = { current: null as ConversationVirtualizer | null }
  const adjusted = vi.fn()
  const hook = renderHook(() =>
    useConversationVirtualizer({
      count: 10,
      enabled,
      estimateSize: () => 100,
      initialRect: { width: 800, height: 200 },
      initialDistanceFromBottomPx: 300,
      listRef: { current: list },
      scrollElementRef: { current: viewport },
      virtualizerRef: engineRef,
      scrollTailHeight: 80,
      onScrollAdjustment: adjusted,
    })
  )
  return { ...hook, viewport, list, engineRef, adjusted }
}

afterEach(() => {
  document.body.replaceChildren()
  resetConversationDiagnosticsForTest()
})

describe('normal conversation virtualizer integration', () => {
  test('counts the prefix and footer once and uses public DOM coordinates', () => {
    const current = fixture()
    const engine = current.result.current.virtualizer
    expect(current.engineRef.current).toBe(engine)
    expect(engine.options.scrollMargin).toBe(40)
    expect(engine.options.paddingEnd).toBe(80)
    expect(engine.getTotalSize()).toBe(1080)
    expect(engine.getVirtualItems()[0]?.start).toBeGreaterThanOrEqual(40)
    const previousTop = current.viewport.scrollTop
    act(() => engine.scrollToOffset(420, { behavior: 'auto' }))
    expect(current.viewport.scrollTop).toBe(420)
    expect(current.adjusted).toHaveBeenLastCalledWith(420 - previousTop)
    current.unmount()
    expect(current.engineRef.current).toBeNull()
  })

  test('does not expose a disabled engine to the nonvirtual controller', () => {
    const current = fixture(false)
    expect(current.engineRef.current).toBeNull()
    expect(current.result.current.virtualizer.getVirtualItems()).toEqual([])
    current.unmount()
  })

  test('reports the applied offset when the native scroll range clamps a measurement write', () => {
    const current = fixture()
    current.viewport.scrollTop = 400
    current.viewport.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      current.viewport.scrollTop = Math.min(920, Math.max(0, Number(top)))
    })
    const engine = current.result.current.virtualizer
    act(() => engine.options.scrollToFn(1000, { adjustments: 100 }, engine))
    expect(current.viewport.scrollTop).toBe(920)
    expect(current.adjusted).toHaveBeenLastCalledWith(520)
    current.unmount()
  })

  test('records real engine writes only during explicit diagnostic capture', () => {
    const current = fixture()
    act(() => current.result.current.virtualizer.scrollToOffset(400))
    expect(getConversationDiagnosticsSnapshot()).toBeNull()
    startConversationDiagnosticCapture()
    act(() => current.result.current.virtualizer.scrollToOffset(500))
    expect(getConversationDiagnosticsSnapshot()?.events.at(-1)).toMatchObject({
      name: 'scroll-write',
      details: { writeSource: 1, targetScrollTop: 500, scrollTop: 500 },
    })
    current.unmount()
  })
})
