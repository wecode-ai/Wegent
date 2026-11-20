// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConfirmationDialog } from './ConfirmationDialog'
import { useDialogRequests } from './useDialogRequests'
let root: Root, container: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
const labels = {
  cancel: 'Cancel',
  confirm: 'Delete',
  pending: 'Deleting',
  failed: 'Failed',
}
const button = (suffix: string) =>
  container.querySelector<HTMLButtonElement>(`[data-testid="confirm-${suffix}"]`)!
function dialog(onConfirm: () => Promise<void>, onClose: () => void, key = 'a') {
  return createElement(ConfirmationDialog, {
    key,
    title: key,
    subject: key,
    description: 'Delete?',
    labels,
    testIdPrefix: 'confirm',
    onConfirm,
    onClose,
  })
}
it('does not close a replacement dialog when an earlier deletion finishes', async () => {
  let done!: () => void
  const closeA = vi.fn(),
    closeB = vi.fn()
  await act(async () =>
    root.render(
      dialog(
        () =>
          new Promise(resolve => {
            done = resolve
          }),
        closeA
      )
    )
  )
  await act(async () => button('confirm').click())
  await act(async () => root.render(dialog(async () => {}, closeB, 'b')))
  await act(async () => done())
  expect(closeA).not.toHaveBeenCalled()
  expect(closeB).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alertdialog"]')?.getAttribute('aria-label')).toBe('b')
})
it('retains keyboard focus while pending and restores an actionable control after failure', async () => {
  let fail!: (reason: Error) => void
  const close = vi.fn()
  await act(async () =>
    root.render(
      dialog(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject
          }),
        close
      )
    )
  )
  button('confirm').focus()
  await act(async () => button('confirm').click())
  const popup = container.querySelector('[role="alertdialog"]')!
  expect(document.activeElement).toBe(popup)
  expect(
    popup.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      })
    )
  ).toBe(false)
  popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(close).not.toHaveBeenCalled()
  await act(async () => fail(new Error('Retry deletion')))
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Retry deletion')
  expect(document.activeElement).toBe(button('confirm'))
  expect(button('confirm').disabled).toBe(false)
})

it('isolates background controls and restores their state and focus after closing', async () => {
  const opener = document.createElement('button')
  opener.textContent = 'Project navigation'
  document.body.append(opener)
  opener.focus()
  await act(async () => root.render(dialog(async () => {}, vi.fn())))
  await vi.waitFor(() => expect(opener.hasAttribute('inert')).toBe(true))
  await vi.waitFor(() => expect(document.activeElement).toBe(button('cancel')))
  await act(async () => root.render(null))
  expect(opener.hasAttribute('inert')).toBe(false)
  expect(document.activeElement).toBe(opener)
  opener.remove()
})

it('settles queued requests through explicit approval, cancellation and owner disposal', async () => {
  let requests!: ReturnType<typeof useDialogRequests>
  function Host() {
    requests = useDialogRequests((_key, fallback) => fallback)
    return requests.dialogs
  }
  await act(async () => root.render(createElement(Host)))
  let approval!: Promise<boolean>
  let queued!: Promise<string | null>
  await act(async () => {
    approval = requests.confirm('Delete resource?')
    queued = requests.prompt('Reason', ' draft ')
  })
  expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1)
  expect(document.querySelector('[data-testid="text-input-request"]')).toBeNull()
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[data-testid="confirmation-request-confirm"]')!
      .click()
  )
  expect(await approval).toBe(true)
  expect(
    document.querySelector<HTMLInputElement>('[data-testid="text-input-request"]')!.value
  ).toBe(' draft ')
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[data-testid="text-input-request-cancel-button"]')!
      .click()
  )
  expect(await queued).toBeNull()
  let emptyReason!: Promise<string | null>
  await act(async () => {
    emptyReason = requests.prompt('Optional reason')
  })
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[data-testid="text-input-request-confirm"]')!.click()
  )
  expect(await emptyReason).toBe('')
  let cancelled!: Promise<boolean>
  let disposed!: Promise<string | null>
  await act(async () => {
    cancelled = requests.confirm('Delete another resource?')
    disposed = requests.prompt('Another reason')
  })
  await act(async () => root.render(null))
  expect(await cancelled).toBe(false)
  expect(await disposed).toBeNull()
  expect(await requests.confirm('Stale action')).toBe(false)
  expect(await requests.prompt('Stale input')).toBeNull()
})
