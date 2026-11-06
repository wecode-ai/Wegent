import { act, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ActivityShimmerText } from './ActivityShimmerText'

const shimmerStyles = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../../packages/collaboration/src/issue-card/activity-shimmer.css'
  ),
  'utf8'
)

let stylesheet: HTMLStyleElement
beforeEach(() => {
  stylesheet = document.createElement('style')
  stylesheet.textContent = shimmerStyles
  document.head.append(stylesheet)
})

afterEach(() => {
  stylesheet.remove()
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
  expect(getComputedStyle(label).getPropertyValue('--activity-shimmer-text-width')).toBe('0px')
  expect(getComputedStyle(label).getPropertyValue('--activity-shimmer-text-offset')).toBe('0px')
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

test('keeps the label readable without an observer and leaves the highlight at zero width', () => {
  vi.stubGlobal('ResizeObserver', undefined)
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  const view = render(<ActivityShimmerText variant="tool">Searching</ActivityShimmerText>)
  const label = view.container.querySelector<HTMLElement>('.activity-shimmer-text')!
  expect(label.textContent).toBe('Searching')
  expect(getComputedStyle(label).getPropertyValue('--activity-shimmer-text-width')).toBe('0px')
  expect(getComputedStyle(label).getPropertyValue('--activity-shimmer-text-offset')).toBe('0px')
  expect(measure).not.toHaveBeenCalled()
})
