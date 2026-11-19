// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useElementGeometry, type GeometrySnapshot } from './dom-events'

let root: Root
let container: HTMLDivElement
let left = 10
let observers: {
  callback: ResizeObserverCallback
  observe: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}[]
function Probe({ enabled = true, replace = false, label = '' }) {
  const ref = useRef<HTMLDivElement>(null)
  const geometry = useElementGeometry([ref], enabled)
  return (
    <>
      <div key={String(replace)} ref={ref} data-anchor={replace ? 'next' : 'first'}>
        {label}
      </div>
      <output>{JSON.stringify(geometry)}</output>
    </>
  )
}
function snapshot(): GeometrySnapshot | null {
  return JSON.parse(container.querySelector('output')!.textContent!)
}
const notify = (index = observers.length - 1) =>
  act(() => observers[index].callback([], observers[index] as unknown as ResizeObserver))
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  left = 10
  observers = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(this)
      }
    }
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return new DOMRect(left + (this.dataset.anchor === 'next' ? 30 : 0), 20, 80, 40)
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('measures attached refs before display and retains native subscriptions across rerenders', () => {
  act(() => root.render(<Probe />))
  expect(snapshot()?.elements[0]).toMatchObject({
    left: 10,
    right: 90,
    top: 20,
    bottom: 60,
    width: 80,
    height: 40,
    scrollHeight: 0,
  })
  expect(observers).toHaveLength(1)
  act(() => root.render(<Probe label="changed content" />))
  expect(observers).toHaveLength(1)
  expect(observers[0].observe).toHaveBeenCalledExactlyOnceWith(
    container.querySelector('[data-anchor]')
  )
})

test('updates from observed geometry changes and captured descendant scrolls', () => {
  act(() => root.render(<Probe />))
  left = 30
  notify()
  expect(snapshot()?.elements[0]?.left).toBe(30)
  left = 50
  act(() =>
    container.querySelector('[data-anchor]')!.dispatchEvent(new Event('scroll', { bubbles: false }))
  )
  expect(snapshot()?.elements[0]?.left).toBe(50)
})

test('rebinds a replacement element even when the RefObject remains unchanged', () => {
  act(() => root.render(<Probe />))
  act(() => root.render(<Probe replace />))
  expect(observers).toHaveLength(2)
  expect(observers[0].disconnect).toHaveBeenCalledOnce()
  expect(snapshot()?.elements[0]?.left).toBe(40)
  left = 100
  notify(0)
  expect(snapshot()?.elements[0]?.left).toBe(40)
  notify(1)
  expect(snapshot()?.elements[0]?.left).toBe(130)
})

test('disconnects when disabled and reads current geometry when reenabled', () => {
  act(() => root.render(<Probe />))
  act(() => root.render(<Probe enabled={false} />))
  expect(snapshot()).toBeNull()
  expect(observers[0].disconnect).toHaveBeenCalledOnce()
  left = 90
  notify(0)
  act(() => window.dispatchEvent(new Event('resize')))
  expect(snapshot()).toBeNull()
  act(() => root.render(<Probe />))
  expect(snapshot()?.elements[0]?.left).toBe(90)
  expect(observers).toHaveLength(2)
})

test('supports native resize and scroll without ResizeObserver', () => {
  vi.stubGlobal('ResizeObserver', undefined)
  act(() => root.render(<Probe />))
  left = 60
  act(() => window.dispatchEvent(new Event('resize')))
  expect(snapshot()?.elements[0]?.left).toBe(60)
  expect(observers).toHaveLength(0)
})

test('detaches native listeners when the owner unmounts', () => {
  const remove = vi.spyOn(window, 'removeEventListener')
  act(() => root.render(<Probe />))
  act(() => root.render(null))
  expect(observers[0].disconnect).toHaveBeenCalledOnce()
  expect(remove).toHaveBeenCalledWith('resize', expect.any(Function))
  expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function), true)
})
