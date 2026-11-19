import { useRef } from 'react'
import { DialogSurface } from '../controls/DialogSurface'
// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TemplateDialog } from './TemplateDialog'

let root: Root
let container: HTMLDivElement
const closeProject = vi.fn()

function Harness({ busy = false }: { busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <DialogSurface onClose={closeProject} render={<div ref={ref} aria-label="Create project" />}>
      <input defaultValue="Keep my project draft" data-testid="project-draft" />
      <button data-testid="preview-template" onClick={() => setOpen(true)}>
        Preview
      </button>
      {open && (
        <TemplateDialog
          title="Preview template"
          closeLabel="Close"
          busy={busy}
          onClose={() => setOpen(false)}
        >
          <p>Template content</p>
        </TemplateDialog>
      )}
    </DialogSurface>
  )
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  closeProject.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it.each([false, true])('handles Escape only in the top template modal, busy=%s', async busy => {
  await act(async () => root.render(<Harness busy={busy} />))
  const trigger = container.querySelector<HTMLButtonElement>('[data-testid="preview-template"]')!
  trigger.focus()
  await act(async () => trigger.click())
  const dialog = document.querySelector<HTMLElement>(
    '[data-testid="collaboration-template-dialog"]'
  )!
  await act(async () =>
    dialog.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
    )
  )
  expect(closeProject).not.toHaveBeenCalled()
  expect((container.querySelector('[data-testid="project-draft"]') as HTMLInputElement).value).toBe(
    'Keep my project draft'
  )
  expect(Boolean(document.querySelector('[data-testid="collaboration-template-dialog"]'))).toBe(
    busy
  )
  if (!busy) {
    expect(document.activeElement).toBe(trigger)
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        })
      )
    )
    expect(closeProject).toHaveBeenCalledOnce()
  }
})
