// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { DefaultModal } from '../project-create/ProjectCreatePrimitives'
import { ModelSelector } from './ModelSelector'
import { useDialogKeyboard } from './useDialogKeyboard'
import { hideOthers } from 'aria-hidden'
import { isolateModalBackground } from './dialogAccessibility'

let container: HTMLDivElement
let background: HTMLButtonElement
let preserved: HTMLDivElement
let root: Root
const isolationBoundary = '[inert], [aria-hidden="true"]'
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  background = document.createElement('button')
  background.textContent = 'Background action'
  background.setAttribute('aria-hidden', 'false')
  preserved = document.createElement('div')
  preserved.setAttribute('aria-hidden', 'true')
  preserved.setAttribute('inert', '')
  container = document.createElement('div')
  document.body.append(background, preserved, container)
  background.focus()
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  background.remove()
  preserved.remove()
  container.remove()
})
const get = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const model = { name: 'model', type: 'public' as const, displayName: 'Model' }
const translate = createCollaborationTranslator('en')

it('leaves a preexisting inert attribute under its React owner when a layer closes', () => {
  function Layer({ onClose }: { onClose: () => void }) {
    const ref = useDialogKeyboard<HTMLDivElement>(onClose)
    return (
      <div ref={ref} role="dialog" aria-modal="true">
        <button onClick={onClose} data-testid="close-owned-layer">
          Close
        </button>
      </div>
    )
  }
  function Host() {
    const [open, setOpen] = useState(true)
    return (
      <>
        <section data-testid="react-owned-background" inert={open}>
          Owner content
        </section>
        {open && <Layer onClose={() => setOpen(false)} />}
      </>
    )
  }
  act(() => root.render(<Host />))
  expect(get('react-owned-background').hasAttribute('inert')).toBe(true)
  act(() => get('close-owned-layer').click())
  expect(get('react-owned-background').hasAttribute('inert')).toBe(false)
})

it.each(['popover-first', 'modal-first'] as const)(
  'restores background attributes after overlapping Radix aria isolation (%s)',
  order => {
    background.removeAttribute('aria-hidden')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    container.append(dialog)
    const restoreModal = isolateModalBackground(dialog)!
    const popover = document.createElement('div')
    document.body.append(popover)
    const restorePopover = hideOthers(popover)
    try {
      expect(background.getAttribute('aria-hidden')).toBe('true')
      expect(background.hasAttribute('inert')).toBe(true)
      if (order === 'popover-first') {
        restorePopover()
        restoreModal()
      } else {
        restoreModal()
        restorePopover()
      }
      expect(background.hasAttribute('inert')).toBe(false)
      expect(background.hasAttribute('aria-hidden')).toBe(false)
    } finally {
      popover.remove()
      dialog.remove()
    }
  }
)

it.each([false, true])(
  'isolates the main modal and real model portal, then restores prior background state (mobile=%s)',
  isMobile => {
    function Host() {
      const [open, setOpen] = useState(true)
      return open ? (
        <DefaultModal title="Create project" closeLabel="Close" onClose={() => setOpen(false)}>
          <input data-testid="project-name" />
          <p role="status" aria-live="polite">
            Generation status
          </p>
          <ModelSelector
            translate={translate}
            isMobile={isMobile}
            models={[model]}
            selectedModel={model}
            selectedModelOptions={{}}
            onSelectModel={vi.fn()}
            onSelectModelOption={vi.fn()}
            onOpenModelSettings={vi.fn()}
          />
        </DefaultModal>
      ) : null
    }
    act(() => root.render(<Host />))
    const main = get('collaboration-project-create-dialog')
    expect(background.closest(isolationBoundary)).not.toBeNull()
    expect(main.closest(isolationBoundary)).toBeNull()
    expect(main.contains(document.activeElement)).toBe(true)
    const trigger = get('model-selector-button')
    act(() => {
      trigger.focus()
      trigger.click()
    })
    const picker = get('model-selector-menu').closest<HTMLElement>('[role="dialog"]')!
    expect(picker.closest(isolationBoundary)).toBeNull()
    expect(main.closest(isolationBoundary)).not.toBeNull()
    expect(picker.contains(document.activeElement)).toBe(true)
    act(() =>
      picker.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    )
    expect(document.querySelector('[data-testid="model-selector-menu"]')).toBeNull()
    expect(main.isConnected).toBe(true)
    expect(main.closest(isolationBoundary)).toBeNull()
    expect(background.closest(isolationBoundary)).not.toBeNull()
    expect(document.activeElement).toBe(trigger)
    act(() => get('collaboration-project-create-close').click())
    expect(background.getAttribute('aria-hidden')).toBe('false')
    expect(background.hasAttribute('inert')).toBe(false)
    expect(preserved.getAttribute('aria-hidden')).toBe('true')
    expect(preserved.getAttribute('inert')).toBe('')
    expect(document.activeElement).toBe(background)
  }
)

it.each([
  { trap: false, modal: true },
  { trap: true, modal: false },
])(
  'keeps non-modal configuration surfaces outside the isolation lifecycle ($trap/$modal)',
  ({ trap, modal }) => {
    function Configuration() {
      const ref = useDialogKeyboard<HTMLDivElement>(vi.fn(), true, undefined, trap)
      return (
        <div ref={ref} role="dialog" aria-modal={modal || undefined}>
          <input />
        </div>
      )
    }
    act(() => root.render(<Configuration />))
    expect(background.getAttribute('aria-hidden')).toBe('false')
    expect(background.hasAttribute('inert')).toBe(false)
  }
)
