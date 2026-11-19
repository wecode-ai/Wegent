import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { AddMarketDialog } from './AddMarketDialog'

const close = vi.fn()
const submit = vi.fn()
function Harness({
  submitting = false,
  transientOpener = false,
}: {
  submitting?: boolean
  transientOpener?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ source: '/tmp/plugins', gitRef: '', subPath: '' })
  return (
    <>
      <button data-testid="plugins-create-button" onClick={() => setOpen(true)}>
        Create
      </button>
      {transientOpener && !open ? <button onClick={() => setOpen(true)}>Menu item</button> : null}
      <AddMarketDialog
        isOpen={open}
        isSubmitting={submitting}
        formData={form}
        onChange={setForm}
        onSubmit={event => {
          event.preventDefault()
          submit()
        }}
        onClose={() => {
          close()
          setOpen(false)
        }}
      />
    </>
  )
}
const source = () => screen.getByTestId('plugins-marketplace-path-input')
async function open() {
  await userEvent.click(screen.getByTestId('plugins-create-button'))
  await waitFor(() => expect(source()).toHaveFocus())
}
beforeEach(() => {
  vi.clearAllMocks()
})

test('focuses the source, preserves edits across rerenders and restores the opener', async () => {
  render(<Harness />)
  await open()
  await userEvent.type(source(), '/more')
  expect(source()).toHaveValue('/tmp/plugins/more')
  expect(source()).toHaveFocus()
  await userEvent.click(screen.getByTestId('plugins-marketplace-cancel-button'))
  expect(screen.getByTestId('plugins-create-button')).toHaveFocus()
})

test('returns to the create button when the menu item that opened the dialog was removed', async () => {
  render(<Harness transientOpener />)
  await userEvent.click(screen.getByRole('button', { name: 'Menu item' }))
  await waitFor(() => expect(source()).toHaveFocus())
  expect(screen.queryByRole('button', { name: 'Menu item' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByTestId('plugins-marketplace-cancel-button'))
  expect(screen.getByTestId('plugins-create-button')).toHaveFocus()
})

test('wraps Tab at both ends of the dialog', async () => {
  render(<Harness />)
  await open()
  const first = screen.getByRole('link')
  const last = screen.getByTestId('plugins-marketplace-save-button')
  last.focus()
  fireEvent.keyDown(last, { key: 'Tab' })
  expect(first).toHaveFocus()
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  expect(last).toHaveFocus()
})

test('an IME Escape does not close the dialog and a normal Escape does', async () => {
  render(<Harness />)
  await open()
  fireEvent.keyDown(source(), { key: 'Escape', isComposing: true })
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  fireEvent.keyDown(source(), { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
  await waitFor(() => expect(screen.getByTestId('plugins-create-button')).toHaveFocus())
})

test('respects Escape already consumed by an input', async () => {
  render(<Harness />)
  await open()
  source().addEventListener('keydown', event => event.preventDefault())
  fireEvent.keyDown(source(), { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

test('submitting blocks Escape and backdrop dismissal while keeping focus in the dialog', async () => {
  render(<Harness submitting />)
  await open()
  fireEvent.keyDown(source(), { key: 'Escape' })
  fireEvent.click(screen.getByTestId('plugins-marketplace-dialog').parentElement!)
  expect(close).not.toHaveBeenCalled()
  expect(source()).toHaveFocus()
  expect(screen.getByTestId('plugins-marketplace-save-button')).toBeDisabled()
})

test('invalid submissions retain source focus and do not call the submit handler', async () => {
  render(<Harness />)
  await open()
  await userEvent.clear(source())
  await userEvent.type(source(), 'invalid')
  fireEvent.submit(source().closest('form')!)
  expect(submit).not.toHaveBeenCalled()
  expect(source()).toHaveFocus()
  expect(source()).toHaveAttribute('aria-invalid', 'true')
})
