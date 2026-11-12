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
})
