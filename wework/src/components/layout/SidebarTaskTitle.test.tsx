import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarTaskTitle } from './SidebarTaskTitle'
import {
  WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT,
  WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT,
} from './workbenchPaneDrag'

let width = 200
let textWidth = 300
let hovered = false
let keyboardFocus = false
let reducedMotion = false
let boundsReads = 0
let scrollWidthReads = 0
const resizes = new Set<() => void>()
let media: EventTarget

function fixture(text = '包含中文和 English 的完整任务标题', withActions = false) {
  return (
    <div data-sidebar-task-row data-testid="row" role="button" tabIndex={0}>
      <SidebarTaskTitle text={text} testId="title" textTestId="text" />
      {withActions && (
        <button data-sidebar-title-actions data-testid="actions">
          Archive
        </button>
      )}
    </div>
  )
}

function enter() {
  hovered = true
  fireEvent.pointerEnter(screen.getByTestId('row'))
}

function leave() {
  hovered = false
  fireEvent.pointerLeave(screen.getByTestId('row'))
}

function advance(milliseconds: number) {
  act(() => vi.advanceTimersByTime(milliseconds))
}

function offset() {
  const translation = screen.getByTestId('text').style.transform.match(/translateX\(([-\d.]+)px\)/)
  return translation ? Math.abs(Number(translation[1])) : 0
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
    ],
  })
  width = 200
  textWidth = 300
  hovered = false
  keyboardFocus = false
  reducedMotion = false
  boundsReads = 0
  scrollWidthReads = 0
  resizes.clear()
  media = new EventTarget()
  Object.defineProperty(media, 'matches', { get: () => reducedMotion })
  vi.stubGlobal('matchMedia', () => media)
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      callback: () => void
      constructor(callback: ResizeObserverCallback) {
        this.callback = () => callback([], this)
        resizes.add(this.callback)
      }
      observe() {}
      unobserve() {}
      disconnect() {
        resizes.delete(this.callback)
      }
    }
  )
  const nativeMatches = Element.prototype.matches
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (selector) {
    if (selector === ':hover') return hovered
    if (selector === ':focus-visible') return keyboardFocus
    return nativeMatches.call(this, selector)
  })
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function () {
    scrollWidthReads++
    return this.dataset.testid === 'text' ? textWidth : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    boundsReads++
    const actions = this.dataset.testid === 'actions'
    const left = actions ? 170 : 0
    const measuredWidth = actions ? 72 : width
    return {
      x: left,
      y: 0,
      left,
      top: 0,
      width: measuredWidth,
      right: left + measuredWidth,
      height: 20,
      bottom: 20,
      toJSON: () => ({}),
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('SidebarTaskTitle', () => {
  it('does not measure or observe idle titles on mount', () => {
    const addGlobalListener = vi.spyOn(window, 'addEventListener')
    render(
      <>
        {fixture('First title')}
        {fixture('Second title')}
      </>
    )

    expect(boundsReads).toBe(0)
    expect(scrollWidthReads).toBe(0)
    expect(resizes.size).toBe(0)
    expect(addGlobalListener.mock.calls.filter(([name]) => name === 'pointerup')).toHaveLength(0)
    expect(
      addGlobalListener.mock.calls.filter(
        ([name]) => name === WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT
      )
    ).toHaveLength(1)
  })

  it('fades overflow, delays scrolling, stops at the end and returns only on exit', () => {
    render(fixture())
    const title = screen.getByTestId('title')
    const viewport = screen.getByTestId('text').parentElement!
    expect(title).not.toHaveAttribute('data-overflow')
    enter()
    expect(title).toHaveAttribute('data-overflow', 'true')
    expect(viewport.style.getPropertyValue('--sidebar-title-fade-end')).toBe('12px')
    advance(599)
    expect(offset()).toBe(0)
    advance(1000)
    expect(offset()).toBeGreaterThan(20)
    expect(offset()).toBeLessThan(30)
    expect(viewport.style.getPropertyValue('--sidebar-title-fade-start')).toBe('12px')
    advance(4500)
    expect(offset()).toBe(100)
    expect(title).toHaveAttribute('data-scroll-state', 'end')
    expect(viewport.style.getPropertyValue('--sidebar-title-fade-end')).toBe('0px')
    advance(5000)
    expect(offset()).toBe(100)
    leave()
    advance(80)
    expect(offset()).toBeGreaterThan(0)
    expect(offset()).toBeLessThan(100)
    advance(80)
    act(() => vi.advanceTimersToNextFrame())
    expect(offset()).toBe(0)
    expect(title).toHaveAttribute('data-scroll-state', 'idle')
    expect(resizes.size).toBe(0)
  })

  it('does not fade or animate a fitting title', () => {
    textWidth = 100
    render(fixture('短标题'))
    enter()
    advance(6000)
    expect(screen.getByTestId('title')).toHaveAttribute('data-overflow', 'false')
    expect(offset()).toBe(0)
    expect(
      screen.getByTestId('text').parentElement!.style.getPropertyValue('--sidebar-title-fade-end')
    ).toBe('0px')
  })

  it('cancels a brief hover and starts a fresh delay on re-entry', () => {
    render(fixture())
    enter()
    advance(300)
    leave()
    advance(1000)
    expect(offset()).toBe(0)
    enter()
    advance(599)
    expect(offset()).toBe(0)
    advance(1000)
    expect(offset()).toBeGreaterThan(0)
  })

  it('clips around overlay actions without changing the title container width', () => {
    render(fixture(undefined, true))
    const title = screen.getByTestId('title')
    enter()
    expect(title.style.width).toBe('')
    expect(screen.getByTestId('text').parentElement!.style.width).toBe('166px')
    advance(8000)
    expect(offset()).toBe(134)
    leave()
    advance(160)
    expect(screen.getByTestId('text').parentElement!.style.width).toBe('')
  })

  it('remeasures resizing and title changes and stops during a drag', () => {
    const view = render(fixture())
    enter()
    advance(1200)
    expect(offset()).toBeGreaterThan(0)
    width = 400
    act(() => resizes.forEach(resize => resize()))
    expect(offset()).toBe(0)
    expect(screen.getByTestId('title')).toHaveAttribute('data-overflow', 'false')
    textWidth = 500
    view.rerender(fixture('Updated title'))
    advance(1200)
    expect(offset()).toBeGreaterThan(0)
    act(() => window.dispatchEvent(new Event(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT)))
    advance(6000)
    expect(offset()).toBe(0)
  })

  it('supports keyboard focus and responds to reduced motion changes', () => {
    render(fixture())
    keyboardFocus = true
    fireEvent.focusIn(screen.getByTestId('row'))
    advance(1200)
    expect(offset()).toBeGreaterThan(0)
    reducedMotion = true
    act(() => media.dispatchEvent(new Event('change')))
    advance(6000)
    expect(offset()).toBe(0)
    reducedMotion = false
    act(() => media.dispatchEvent(new Event('change')))
    advance(1200)
    expect(offset()).toBeGreaterThan(0)
    fireEvent.focusOut(screen.getByTestId('row'))
    advance(160)
    expect(offset()).toBe(0)
  })

  it('keeps an idle title still when a pane drag starts before hover', () => {
    render(fixture())
    act(() => window.dispatchEvent(new Event(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT)))
    enter()
    advance(6000)
    expect(offset()).toBe(0)
    act(() => window.dispatchEvent(new Event(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT)))
    advance(1200)
    expect(offset()).toBeGreaterThan(0)
  })

  it('cleans up pending motion on unmount', () => {
    const view = render(fixture())
    enter()
    view.unmount()
    expect(resizes.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
