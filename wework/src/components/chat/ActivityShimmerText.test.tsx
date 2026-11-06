import { act, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ActivityShimmerText } from './ActivityShimmerText'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('uses observer dimensions without synchronously measuring each streaming label', () => {
  let notify!: ResizeObserverCallback
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        notify = callback
      }
      observe = observe
      disconnect = disconnect
    }
  )
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  const view = render(<ActivityShimmerText variant="thinking">Working</ActivityShimmerText>)
  const label = view.container.querySelector<HTMLElement>('.activity-shimmer-text')!
  expect(observe).toHaveBeenCalledWith(label)
  act(() => {
    notify(
      [{ borderBoxSize: [{ inlineSize: 80 }], target: label } as ResizeObserverEntry],
      {} as ResizeObserver
    )
  })
  expect(label.style.getPropertyValue('--activity-shimmer-text-width')).toBe('80px')
  expect(label.style.getPropertyValue('--activity-shimmer-text-offset')).toBe('-80px')
  view.rerender(<ActivityShimmerText variant="thinking">Still working</ActivityShimmerText>)
  act(() => {
    notify(
      [{ contentRect: { width: 120 }, target: label } as ResizeObserverEntry],
      {} as ResizeObserver
    )
  })
  expect(label.style.getPropertyValue('--activity-shimmer-text-width')).toBe('120px')
  expect(label.style.getPropertyValue('--activity-shimmer-text-offset')).toBe('-120px')
  expect(measure).not.toHaveBeenCalled()
  view.unmount()
  expect(disconnect).toHaveBeenCalledOnce()
})
