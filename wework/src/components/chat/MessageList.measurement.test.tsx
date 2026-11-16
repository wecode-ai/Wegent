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
})
