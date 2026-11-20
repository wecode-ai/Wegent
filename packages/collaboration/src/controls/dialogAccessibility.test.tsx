import { settle } from '@ui-sdk/core/testing'
import { useRef } from 'react'
import { DialogSurface } from './DialogSurface'
// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { DefaultModal } from '../project-create/ProjectCreatePrimitives'
import { ModelSelector } from './ModelSelector'
import { Tooltip } from './Tooltip'

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
    const ref = useRef<HTMLDivElement>(null)
    return (
      <DialogSurface onClose={onClose} render={<div ref={ref} />}>
        <button onClick={onClose} data-testid="close-owned-layer">
          Close
        </button>
      </DialogSurface>
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
  'restores background attributes after overlapping SDK layers (%s)',
  async order => {
    background.removeAttribute('aria-hidden')
    const render = (modal: boolean, popup: boolean) => (
      <>
        {modal && (
          <DialogSurface onClose={() => {}} render={<div aria-label="Outer" />}>
            <button>Outer action</button>
          </DialogSurface>
        )}
        {popup && (
          <DialogSurface onClose={() => {}} render={<div aria-label="Inner" />}>
            <button>Inner action</button>
          </DialogSurface>
        )}
      </>
    )
    await act(async () => root.render(render(true, true)))
    await act(async () => {
      await vi.waitFor(() => expect(background.closest('[inert]')).not.toBeNull())
    })
    await act(async () => root.render(render(order === 'popover-first', order !== 'popover-first')))
    expect(background.closest('[inert]')).not.toBeNull()
    expect(preserved.getAttribute('aria-hidden')).toBe('true')
    expect(preserved.hasAttribute('inert')).toBe(true)
    await act(async () => root.render(render(false, false)))
    expect(background.hasAttribute('inert')).toBe(false)
    expect(background.hasAttribute('aria-hidden')).toBe(false)
    expect(preserved.getAttribute('aria-hidden')).toBe('true')
    expect(preserved.hasAttribute('inert')).toBe(true)
  }
)

it.each([false, true])(
  'isolates the main modal and real model portal, then restores prior background state (mobile=%s)',
  async isMobile => {
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
    await act(async () => root.render(<Host />))
    await act(async () => {
      await vi.waitFor(() => expect(background.closest(isolationBoundary)).not.toBeNull())
    })
    const main = get('collaboration-project-create-dialog')
    expect(background.closest(isolationBoundary)).not.toBeNull()
    expect(main.closest(isolationBoundary)).toBeNull()
    expect(main.contains(document.activeElement)).toBe(true)
    const trigger = get('model-selector-button')
    await act(async () => {
      trigger.focus()
      trigger.click()
      await settle()
    })
    await act(async () => {
      await vi.waitFor(() => expect(get('project-name').closest(isolationBoundary)).not.toBeNull())
    })
    const picker = get('model-selector-menu').closest<HTMLElement>('[role="dialog"]')!
    expect(picker.closest(isolationBoundary)).toBeNull()
    expect(get('project-name').closest(isolationBoundary)).not.toBeNull()
    expect(main.querySelector('[role="status"]')?.closest(isolationBoundary)).toBeNull()
    expect(picker.contains(document.activeElement)).toBe(true)
    await act(async () => {
      picker.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
      await settle()
    })
    expect(document.querySelector('[data-testid="model-selector-menu"]')).toBeNull()
    expect(main.isConnected).toBe(true)
    expect(main.closest(isolationBoundary)).toBeNull()
    expect(background.closest(isolationBoundary)).not.toBeNull()
    expect(document.activeElement).toBe(trigger)
    await act(async () => {
      get('collaboration-project-create-close').click()
      await settle()
    })
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
      const ref = useRef<HTMLDivElement>(null)
      return (
        <DialogSurface
          onClose={vi.fn()}
          modal={trap}
          render={<div ref={ref} aria-modal={modal || undefined} />}
        >
          <input />
        </DialogSurface>
      )
    }
    act(() => root.render(<Configuration />))
    expect(background.getAttribute('aria-hidden')).toBe('false')
    expect(background.hasAttribute('inert')).toBe(false)
  }
)

it('dismisses an open tooltip when its trigger opens another surface', async () => {
  const render = (disabled: boolean) => (
    <Tooltip label="Select a model" testId="keyboard-tooltip" disabled={disabled}>
      <button data-testid="keyboard-tooltip-trigger">Model</button>
    </Tooltip>
  )
  await act(async () => root.render(render(false)))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  await act(async () => get('keyboard-tooltip-trigger').focus())
  expect(get('keyboard-tooltip')?.hasAttribute('data-open')).toBe(true)
  await act(async () => root.render(render(true)))
  expect(get('keyboard-tooltip')?.hasAttribute('data-open') ?? false).toBe(false)
  await act(async () => root.render(render(false)))
  expect(get('keyboard-tooltip')?.hasAttribute('data-open') ?? false).toBe(false)
})
