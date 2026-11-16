// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { DefaultModal } from '../project-create/ProjectCreatePrimitives'
import { ModelSelector } from './ModelSelector'
import { useDialogKeyboard } from './useDialogKeyboard'

let container: HTMLDivElement
let background: HTMLButtonElement
let preserved: HTMLDivElement
let root: Root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  background = document.createElement('button')
  background.textContent = 'Background action'
  preserved = document.createElement('div')
  preserved.setAttribute('aria-hidden', 'true')
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

it.each([false, true])(
  'isolates the main modal and real model portal, then restores prior background state (mobile=%s)',
  isMobile => {
    function Host() {
      const [open, setOpen] = useState(true)
      return open ? (
        <DefaultModal title="Create project" closeLabel="Close" onClose={() => setOpen(false)}>
          <input data-testid="project-name" />
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
    expect(background.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(main.closest('[aria-hidden="true"]')).toBeNull()
    expect(main.contains(document.activeElement)).toBe(true)
    const trigger = get('model-selector-button')
    act(() => {
      trigger.focus()
      trigger.click()
    })
    const picker = get('model-selector-menu').closest<HTMLElement>('[role="dialog"]')!
    expect(picker.closest('[aria-hidden="true"]')).toBeNull()
    expect(main.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(picker.contains(document.activeElement)).toBe(true)
    act(() =>
      picker.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    )
    expect(document.querySelector('[data-testid="model-selector-menu"]')).toBeNull()
    expect(main.isConnected).toBe(true)
    expect(main.closest('[aria-hidden="true"]')).toBeNull()
    expect(background.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(document.activeElement).toBe(trigger)
    act(() => get('collaboration-project-create-close').click())
    expect(background.hasAttribute('aria-hidden')).toBe(false)
    expect(preserved.getAttribute('aria-hidden')).toBe('true')
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
    expect(background.hasAttribute('aria-hidden')).toBe(false)
  }
)
