// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollaborationTheme, defaultThemeAppearance } from '../theme'
import { IssuePropertiesPopover } from './IssuePropertiesPopover'

describe('IssuePropertiesPopover', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function renderPopover(onClose = vi.fn(), uiFontSize = 14) {
    await act(async () => {
      root.render(
        <CollaborationTheme mode="dark" appearance={{ ...defaultThemeAppearance, uiFontSize }}>
          <IssuePropertiesPopover label="更多信息" onClose={onClose}>
            <input aria-label="添加标签" />
          </IssuePropertiesPopover>
        </CollaborationTheme>
      )
    })
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => trigger.click())
    return trigger
  }

  function getPopover() {
    return document.body.querySelector<HTMLElement>(
      '[data-testid="cloud-todo-more-properties-popover"]'
    )
  }

  it('keeps scoped font settings and an accessible heading across the portal', async () => {
    await renderPopover(vi.fn(), 16)
    const popover = getPopover()!
    expect(container.contains(popover)).toBe(false)
    expect(popover.dataset.theme).toBe('dark')
    expect(popover.style.getPropertyValue('--font-ui')).toBe(defaultThemeAppearance.uiFont)
    expect(popover.style.getPropertyValue('--text-sm')).toBe('15px')
    expect(popover.style.getPropertyValue('--text-base')).toBe('16px')
    expect(popover.style.getPropertyValue('--font-weight-ui')).toBe('445')
    expect(popover.querySelector('h3')?.id).toBe(popover.getAttribute('aria-labelledby'))
    expect(popover.querySelector('h3')?.textContent).toBe('更多信息')
  })

  it('commits focused field drafts before Escape dismisses and returns focus', async () => {
    const onClose = vi.fn(() => expect(getPopover()).not.toBeNull())
    const trigger = await renderPopover(onClose)
    const input = getPopover()!.querySelector<HTMLInputElement>('input')!
    await act(async () => input.focus())
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledOnce()
    expect(getPopover()).toBeNull()
    // Radix restores focus after the portal unmount lifecycle completes.
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})
