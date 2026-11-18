import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlobalIconButtonTooltip } from './GlobalIconButtonTooltip'

describe('GlobalIconButtonTooltip ownership', () => {
  let container: HTMLDivElement
  let root: Root
  let button: HTMLButtonElement
  let customTrigger: HTMLSpanElement
  const tooltip = () => document.querySelector('[data-testid="global-icon-button-tooltip"]')
  const hover = (element: Element) =>
    act(() => element.dispatchEvent(new Event('pointerover', { bubbles: true })))
  const showPendingTooltip = () => act(() => vi.runOnlyPendingTimers())

  beforeEach(() => {
    vi.useFakeTimers()
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() =>
      root.render(
        <>
          <button type="button" aria-label="Close detail">
            ×
          </button>
          <span data-tooltip-trigger="">Assignment receipt</span>
          <GlobalIconButtonTooltip />
        </>
      )
    )
    button = container.querySelector('button')!
    customTrigger = container.querySelector('[data-tooltip-trigger]')!
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('shows the fallback tooltip for an ordinary icon button', () => {
    hover(button)
    showPendingTooltip()
    expect(tooltip()?.textContent).toBe('Close detail')
  })

  it('leaves a nested custom tooltip trigger to its own provider', () => {
    const nestedTrigger = document.createElement('span')
    nestedTrigger.dataset.tooltipTrigger = ''
    button.append(nestedTrigger)
    hover(nestedTrigger)
    showPendingTooltip()
    expect(tooltip()).toBeNull()
  })

  it('cancels a focused button tooltip when hovering a separate custom tooltip trigger', () => {
    act(() => button.focus())
    hover(customTrigger)
    showPendingTooltip()
    expect(tooltip()).toBeNull()
  })

  it('hides an already visible button tooltip when entering a separate custom tooltip trigger', () => {
    act(() => button.focus())
    showPendingTooltip()
    expect(tooltip()).not.toBeNull()
    hover(customTrigger)
    expect(tooltip()).toBeNull()
  })

  it('waits the full hover delay before showing a tooltip', () => {
    hover(button)
    act(() => vi.advanceTimersByTime(699))
    expect(tooltip()).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(tooltip()?.textContent).toBe('Close detail')
  })

  it.each(['click', 'keydown', 'resize', 'scroll'])('cancels a pending tooltip on %s', type => {
    hover(button)
    act(() => {
      if (type === 'keydown') document.dispatchEvent(new KeyboardEvent(type, { key: 'Escape' }))
      else if (type === 'resize') window.dispatchEvent(new Event(type))
      else document.dispatchEvent(new Event(type, { bubbles: true }))
    })
    showPendingTooltip()
    expect(tooltip()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears a pending delay and removes native listeners when its host unmounts', () => {
    hover(button)
    expect(vi.getTimerCount()).toBe(1)
    act(() =>
      root.render(
        <button type="button" aria-label="New button">
          ×
        </button>
      )
    )
    expect(vi.getTimerCount()).toBe(0)
    hover(container.querySelector('button')!)
    showPendingTooltip()
    expect(tooltip()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not show a delayed tooltip for a button removed from the document', () => {
    const transientButton = document.createElement('button')
    transientButton.setAttribute('aria-label', 'Temporary action')
    document.body.append(transientButton)
    hover(transientButton)
    transientButton.remove()
    showPendingTooltip()
    expect(tooltip()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('measures the mounted tooltip before revealing its position', () => {
    const measurement = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return this.tagName === 'BUTTON'
          ? ({ left: 100, top: 100, right: 120, bottom: 120, width: 20, height: 20 } as DOMRect)
          : ({ left: 0, top: 0, right: 80, bottom: 24, width: 80, height: 24 } as DOMRect)
      })
    try {
      hover(button)
      showPendingTooltip()
      expect((tooltip() as HTMLElement).style.left).toBe('70px')
      expect((tooltip() as HTMLElement).style.top).toBe('128px')
      expect(tooltip()?.classList.contains('opacity-100')).toBe(true)
    } finally {
      measurement.mockRestore()
    }
  })
})
