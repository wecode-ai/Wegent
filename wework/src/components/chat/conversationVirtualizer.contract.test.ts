import { Virtualizer } from '@tanstack/react-virtual'
import { describe, expect, test, vi } from 'vitest'

// Exercise the installed engine, including its commit phase; no virtualizer mock.
function createConversation(offset = 350, { count = 10, viewportHeight = 200, overscan = 1 } = {}) {
  let following = true
  let keys = Array.from({ length: count }, (_, index) => `m${index}`)
  let readOffset: (offset: number, scrolling: boolean) => void = () => {}
  const element = document.createElement('div')
  Object.defineProperties(element, {
    clientHeight: { value: viewportHeight },
    scrollHeight: { get: () => virtualizer.getTotalSize() },
  })
  const writes: number[] = []
  const options = () => ({
    count: keys.length,
    getItemKey: (index: number) => keys[index],
    getScrollElement: () => element,
    estimateSize: () => 100,
    overscan,
    initialOffset: offset,
    initialRect: { width: 800, height: viewportHeight },
    anchorTo: 'end' as const,
    followOnAppend: following ? ('auto' as const) : (false as const),
    scrollEndThreshold: following ? 8 : -1,
    observeElementRect: (
      _instance: unknown,
      callback: (rect: { width: number; height: number }) => void
    ) => {
      callback({ width: 800, height: viewportHeight })
    },
    observeElementOffset: (_instance: unknown, callback: typeof readOffset) => {
      readOffset = callback
      callback(element.scrollTop, false)
    },
    scrollToFn: (top: number, { adjustments = 0 }: { adjustments?: number }) => {
      // Match the native DOM clamp when content is shorter than the viewport.
      const end = Math.max(0, virtualizer.getTotalSize() - viewportHeight)
      element.scrollTop = Math.min(end, Math.max(0, top + adjustments))
      writes.push(element.scrollTop)
    },
  })
  element.scrollTop = offset
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>(options())
  const dispose = virtualizer._didMount()
  const commit = () => {
    virtualizer.getVirtualItems()
    virtualizer._willUpdate()
    readOffset(element.scrollTop, false)
  }
  commit()
  writes.length = 0
  return {
    virtualizer,
    element,
    writes,
    dispose,
    commit,
    scroll: (top: number) => {
      element.scrollTop = top
      readOffset(top, true)
    },
    replace: (nextKeys: string[]) => {
      keys = nextKeys
      virtualizer.setOptions(options())
      commit()
    },
    keys: () => keys,
    pause: () => {
      following = false
      virtualizer.cancelScroll()
      virtualizer.setOptions(options())
    },
  }
}

describe('installed TanStack chat contract', () => {
  test('a six-row conversation can retain later text while unmounting its first message', () => {
    const keys = ['base', 'history', 'goal', 'initial', 'cancelled', 'recovered']
    const overflowing = createConversation(300, { count: 6, viewportHeight: 300, overscan: 2 })
    overflowing.replace(keys)
    expect(overflowing.keys()).toEqual(keys)
    expect(overflowing.virtualizer.getVirtualItems().map(row => row.key)).toEqual(keys.slice(1))
    overflowing.dispose()

    const fitting = createConversation(0, { count: 6, viewportHeight: 800, overscan: 2 })
    fitting.replace(keys)
    expect(fitting.element.scrollHeight).toBeLessThanOrEqual(fitting.element.clientHeight)
    expect(fitting.virtualizer.getVirtualItems().map(row => row.key)).toEqual(keys)
    fitting.dispose()
  })

  test('end anchoring keeps short rows at their natural positions and follows once they overflow', () => {
    const fixture = createConversation(0, { count: 4, viewportHeight: 600 })
    expect(fixture.virtualizer.getVirtualItems().map(row => row.start)).toEqual([0, 100, 200, 300])
    expect(fixture.element.scrollTop).toBe(0)
    fixture.replace([...fixture.keys(), 'next'])
    expect(fixture.element.scrollTop).toBe(0)
    fixture.virtualizer.resizeItem(4, 300)
    fixture.commit()
    expect(fixture.element.scrollTop).toBe(100)
    expect(fixture.virtualizer.getVirtualItems()[0]?.start).toBe(0)
    fixture.dispose()
  })

  test('an explicit pause within the end tolerance survives resize and append', () => {
    const fixture = createConversation(800)
    fixture.pause()
    fixture.scroll(797)
    fixture.virtualizer.resizeItem(9, 180)
    fixture.commit()
    expect(fixture.element.scrollTop).toBe(797)
    fixture.replace([...fixture.keys(), 'newest'])
    expect(fixture.element.scrollTop).toBe(797)
    fixture.dispose()
  })
  test('prepend preserves the visible row and offset inside it', () => {
    const fixture = createConversation()
    fixture.replace(['older', ...fixture.keys()])
    expect(fixture.element.scrollTop).toBe(450)
    fixture.dispose()
  })

  test('append follows the end and leaves a reader in history alone', () => {
    for (const offset of [350, 800]) {
      const fixture = createConversation(offset)
      fixture.replace([...fixture.keys(), 'newest'])
      expect(fixture.element.scrollTop).toBe(offset === 800 ? 900 : 350)
      fixture.dispose()
    }
  })

  test('reflow inside the visible long row does not move the reader by its size delta', () => {
    const fixture = createConversation(350)
    fixture.virtualizer.resizeItem(3, 1000)
    fixture.commit()
    fixture.writes.length = 0
    fixture.scroll(600)
    fixture.virtualizer.resizeItem(3, 1100)
    fixture.commit()
    expect(fixture.element.scrollTop).toBe(600)
    fixture.dispose()
  })

  test('cancelScroll releases a command before the reader takes over', () => {
    vi.useFakeTimers()
    const fixture = createConversation()
    fixture.virtualizer.scrollToIndex(8, { align: 'start' })
    fixture.virtualizer.cancelScroll()
    fixture.scroll(350)
    fixture.virtualizer.resizeItem(0, 150)
    fixture.commit()
    vi.advanceTimersByTime(100)
    expect(fixture.element.scrollTop).toBe(400)
    fixture.dispose()
    vi.useRealTimers()
  })
})
