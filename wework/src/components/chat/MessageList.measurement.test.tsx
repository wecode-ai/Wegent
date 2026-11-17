import { act, renderHook } from '@testing-library/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { afterEach, expect, test, vi } from 'vitest'
import {
  useMessageRowMeasure,
  useMessageRowMeasurements,
} from '../../../../packages/collaboration/src/conversation/useMessageRowMeasurements'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

test('commits a restored row before paint while a native scroll event is still active', () => {
  const viewport = document.createElement('div')
  const list = document.createElement('div')
  const row = document.createElement('article')
  row.dataset.index = '9'
  list.append(row)
  viewport.append(list)
  document.body.append(viewport)
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 736, 220))
  let observeOffset: (offset: number, scrolling: boolean) => void = () => {}
  const unregisteredMeasurements: HTMLElement[] = []
  const { result } = renderHook(() => {
    const measureElement = useMessageRowMeasure()
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
      count: 10,
      getScrollElement: () => viewport,
      estimateSize: () => 220,
      initialRect: { width: 736, height: 883 },
      observeElementRect: (_instance, callback) => callback({ width: 736, height: 883 }),
      observeElementOffset: (_instance, callback) => {
        observeOffset = callback
        callback(0, false)
      },
      scrollToFn: vi.fn(),
      measureElement,
      onChange: instance => {
        if (
          instance.itemSizeCache.get(9) === 24 &&
          instance.elementsCache.get(9) !== list.firstElementChild
        ) {
          unregisteredMeasurements.push(list.firstElementChild as HTMLElement)
        }
      },
    })
    const measurements = useMessageRowMeasurements({ current: list }, virtualizer, true)
    return { virtualizer, ...measurements }
  })
  act(() => observeOffset(1300, true))
  expect(result.current.virtualizer.isScrolling).toBe(true)
  const restored = document.createElement('article')
  restored.dataset.index = '9'
  vi.spyOn(restored, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 736, 24))
  row.replaceWith(restored)

  act(() => result.current.measureRows([restored]))

  expect(result.current.virtualizer.isScrolling).toBe(true)
  expect(result.current.virtualizer.itemSizeCache.get(9)).toBe(24)
  expect(result.current.virtualizer.getVirtualItems().find(item => item.index === 9)?.size).toBe(24)
  expect(unregisteredMeasurements).toEqual([])
})

test('measures every restored row before paint during a native scroll', () => {
  const viewport = document.createElement('div')
  const list = document.createElement('div')
  viewport.append(list)
  document.body.append(viewport)
  const count = 80
  const makeRows = (height: number) =>
    Array.from({ length: count }, (_, index) => {
      const row = document.createElement('article')
      row.dataset.index = String(index)
      row.dataset.messageRow = ''
      row.getBoundingClientRect = () => new DOMRect(0, 0, 736, height)
      return row
    })
  list.append(...makeRows(220))
  let observeOffset: (offset: number, scrolling: boolean) => void = () => {}
  const { result, rerender } = renderHook(() => {
    const measureElement = useMessageRowMeasure()
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLElement>({
      count,
      getScrollElement: () => viewport,
      estimateSize: () => 220,
      rangeExtractor: () => Array.from({ length: count }, (_, index) => index),
      initialRect: { width: 736, height: 883 },
      observeElementRect: (_instance, callback) => callback({ width: 736, height: 883 }),
      observeElementOffset: (_instance, callback) => {
        observeOffset = callback
        callback(0, false)
      },
      scrollToFn: (offset, { adjustments = 0 }) => observeOffset(offset + adjustments, false),
      measureElement,
    })
    useMessageRowMeasurements({ current: list }, virtualizer, true)
    return virtualizer
  })
  act(() => observeOffset(13000, true))
  list.replaceChildren(...makeRows(24))

  expect(() => rerender()).not.toThrow()
  expect(result.current.elementsCache.size).toBe(count)
  expect(result.current.getVirtualItems().map(item => item.size)).toEqual(
    Array.from({ length: count }, () => 24)
  )
})
