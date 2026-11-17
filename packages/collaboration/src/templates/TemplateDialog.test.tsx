// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDialogKeyboard } from '../controls/useDialogKeyboard'
import { TemplateDialog } from './TemplateDialog'

let root: Root
let container: HTMLDivElement
const closeProject = vi.fn()

function Harness({ busy = false }: { busy?: boolean }) {
  const ref = useDialogKeyboard<HTMLDivElement>(closeProject)
  const [open, setOpen] = useState(false)
  return (
    <div ref={ref} role="dialog" aria-label="Create project">
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
    </div>
  )
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  closeProject.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false
    },
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it.each([false, true])(
  'handles Escape only in the top native template modal, busy=%s',
  async busy => {
    await act(async () => root.render(<Harness busy={busy} />))
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="preview-template"]')!
    trigger.focus()
    await act(async () => trigger.click())
    const dialog = container.querySelector<HTMLDialogElement>('dialog')!
    await act(async () =>
      dialog.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    )
    expect(closeProject).not.toHaveBeenCalled()
    expect(
      (container.querySelector('[data-testid="project-draft"]') as HTMLInputElement).value
    ).toBe('Keep my project draft')
    expect(Boolean(container.querySelector('dialog'))).toBe(busy)
    if (!busy) {
      expect(document.activeElement).toBe(trigger)
      await act(async () =>
        trigger.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        )
      )
      expect(closeProject).toHaveBeenCalledOnce()
    }
  }
)
