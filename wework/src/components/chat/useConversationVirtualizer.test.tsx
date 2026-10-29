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
  vi.unstubAllGlobals()
})

describe('normal conversation virtualizer integration', () => {
  test.each([6, 20])(
    'initializes %i transcript rows after the hidden viewport becomes visible',
    async count => {
      const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = []
      vi.stubGlobal(
        'ResizeObserver',
        class {
          record: (typeof observers)[number]
          constructor(callback: ResizeObserverCallback) {
            this.record = { callback, targets: new Set() }
            observers.push(this.record)
          }
          observe(target: Element) {
            this.record.targets.add(target)
          }
          unobserve(target: Element) {
            this.record.targets.delete(target)
          }
          disconnect() {
            this.record.targets.clear()
          }
        }
      )
      let height = 0
      const contentHeight = count * 70 + (count - 1) * 16 + 40
      const viewport = document.createElement('div')
      const list = document.createElement('div')
      viewport.append(list)
      document.body.append(viewport)
      Object.defineProperties(viewport, {
        clientHeight: { get: () => height },
        clientWidth: { value: 800 },
        scrollHeight: { get: () => (height === 0 ? 0 : contentHeight) },
      })
      viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, height)
      list.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 800, contentHeight)
      viewport.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
        // Browsers do not emit a scroll event when a clamped write leaves zero unchanged.
        const previous = viewport.scrollTop
        viewport.scrollTop = Math.max(0, Math.min(Number(top), viewport.scrollHeight - height))
        if (viewport.scrollTop !== previous)
          queueMicrotask(() => viewport.dispatchEvent(new Event('scroll')))
      })
      const hook = renderHook(() =>
        useConversationVirtualizer({
          count,
          enabled: true,
          estimateSize: () => 70,
          gap: 16,
          paddingStart: 32,
          paddingEnd: 8,
          overscan: 2,
          initialDistanceFromBottomPx: 0,
          listRef: { current: list },
          scrollElementRef: { current: viewport },
        })
      )
      await act(async () => {
        height = 638
        for (const observer of observers) {
          if (!observer.targets.has(viewport)) continue
          observer.callback(
            [
              {
                target: viewport,
                borderBoxSize: [{ inlineSize: 800, blockSize: height }],
                contentRect: viewport.getBoundingClientRect(),
              } as unknown as ResizeObserverEntry,
            ],
            {} as ResizeObserver
          )
        }
      })
      expect(viewport.scrollTop).toBe(Math.max(0, contentHeight - height))
      expect(hook.result.current.virtualizer.getTotalSize()).toBe(contentHeight)
      const indexes = hook.result.current.virtualizer.getVirtualItems().map(row => row.index)
      if (contentHeight <= height) expect(indexes).toEqual([0, 1, 2, 3, 4, 5])
      else expect(indexes.at(-1)).toBe(count - 1)
      hook.unmount()
    }
  )

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

test('reads back a clamped no-op initial write when the browser emits no scroll event', () => {
  const viewport = document.createElement('div')
  const list = document.createElement('div')
  viewport.append(list)
  document.body.append(viewport)
  Object.defineProperties(viewport, {
    clientHeight: { value: 800 },
    clientWidth: { value: 800 },
    scrollHeight: { value: 800 },
  })
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 800)
  list.getBoundingClientRect = () => new DOMRect(0, 0, 800, 400)
  viewport.scrollTo = vi.fn(() => {
    viewport.scrollTop = 0
  })
  const hook = renderHook(() =>
    useConversationVirtualizer({
      count: 6,
      enabled: true,
      estimateSize: () => 220,
      initialRect: { width: 800, height: 800 },
      initialDistanceFromBottomPx: 0,
      listRef: { current: list },
      scrollElementRef: { current: viewport },
    })
  )
  expect(viewport.scrollTop).toBe(0)
  expect(hook.result.current.virtualizer.scrollOffset).toBe(0)
  expect(hook.result.current.virtualizer.getVirtualItems()[0]?.index).toBe(0)
  hook.unmount()
})
