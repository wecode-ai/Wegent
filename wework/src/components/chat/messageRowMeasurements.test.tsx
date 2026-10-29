import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  useMessageRowMeasure,
  useMessageRowMeasurements,
} from '../../../../packages/collaboration/src/conversation/useMessageRowMeasurements'
import type { ConversationVirtualizer } from '../../../../packages/collaboration/src/conversation/useConversationVirtualizer'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

test.each([606.47, 1334.31, 2523.78])(
  'initial and observed heights both round %s consistently, without re-reading observed DOM',
  async height => {
    const row = document.createElement('div')
    row.dataset.index = '0'
    const bounds = vi
      .spyOn(row, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 700, height))
    const engine = {
      options: { estimateSize: () => 220 },
      getVirtualItems: () => [{ index: 0, size: 220 }],
      getTotalSize: () => 220,
    } as unknown as ConversationVirtualizer
    const callback = vi.fn()
    const hook = renderHook(() => useMessageRowMeasure(callback))
    expect(hook.result.current(row, undefined, engine)).toBe(Math.round(height))
    bounds.mockClear()
    const entry = {
      target: row,
      borderBoxSize: [{ inlineSize: 700, blockSize: height }],
    } as unknown as ResizeObserverEntry
    expect(hook.result.current(row, entry, engine)).toBe(Math.round(height))
    expect(bounds).not.toHaveBeenCalled()
    await act(async () => {})
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ previousSize: 220, measuredSize: Math.round(height) })
    )
    hook.unmount()
  }
)

test('hidden rows retain valid cached heights', () => {
  const row = document.createElement('div')
  row.dataset.index = '0'
  const engine = {
    getVirtualItems: () => [{ index: 0, size: 444 }],
  } as unknown as ConversationVirtualizer
  const hook = renderHook(() => useMessageRowMeasure())
  expect(hook.result.current(row, undefined, engine)).toBe(444)
})

test('reads initial rows before any virtual writes and does not remeasure unchanged commits', () => {
  const list = document.createElement('div')
  list.innerHTML =
    '<div data-message-row data-index="0"></div><div data-message-row data-index="1"></div>'
  document.body.append(list)
  const order: string[] = []
  const rows = [...list.children] as HTMLElement[]
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => {
      order.push(`read-${index}`)
      return new DOMRect(0, 0, 700, 100)
    }
  })
  const elementsCache = new Map()
  const engine = {
    elementsCache,
    options: { getItemKey: (index: number) => index },
    measureElement: (row: HTMLElement | null) => {
      if (!row) return
      const index = Number(row.dataset.index)
      order.push(`write-${index}`)
      elementsCache.set(index, row)
    },
  } as unknown as ConversationVirtualizer
  const hook = renderHook(() => useMessageRowMeasurements({ current: list }, engine, true))
  expect(order).toEqual(['read-0', 'read-1', 'write-0', 'write-1'])
  order.length = 0
  hook.rerender()
  expect(order).toEqual([])
  hook.unmount()
})

test('native TanStack observer batches multiple changed rows into one notification', () => {
  let notify!: ResizeObserverCallback
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        notify = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  const viewport = document.createElement('div')
  const list = document.createElement('div')
  list.innerHTML =
    '<div data-message-row data-index="0"></div><div data-message-row data-index="1"></div>'
  viewport.append(list)
  document.body.append(viewport)
  const onChange = vi.fn()
  const hook = renderHook(() => {
    const measureElement = useMessageRowMeasure()
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
      count: 2,
      getScrollElement: () => viewport,
      estimateSize: () => 220,
      initialRect: { width: 700, height: 800 },
      observeElementRect: (_engine, callback) => {
        callback({ width: 700, height: 800 })
        return () => {}
      },
      observeElementOffset: (_engine, callback) => {
        callback(0, false)
        return () => {}
      },
      scrollToFn: () => {},
      measureElement,
      onChange,
    })
    useMessageRowMeasurements({ current: list }, virtualizer, true)
    return virtualizer
  })
  onChange.mockClear()
  const rows = [...list.children] as HTMLElement[]
  const bounds = rows.map(row => vi.spyOn(row, 'getBoundingClientRect'))
  act(() =>
    notify(
      rows.map((row, index) => ({
        target: row,
        borderBoxSize: [{ inlineSize: 700, blockSize: 300 + index * 100 }],
      })) as unknown as ResizeObserverEntry[],
      {} as ResizeObserver
    )
  )
  expect(hook.result.current.getVirtualItems().map(item => item.size)).toEqual([300, 400])
  expect(onChange).toHaveBeenCalledTimes(1)
  bounds.forEach(read => expect(read).not.toHaveBeenCalled())
  hook.unmount()
})
