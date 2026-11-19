import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { CloudModelCatalogSyncDialogHost } from './cloudModelCatalogSync'
import { requestCloudModelCatalogSync } from './cloudModelCatalogSyncRequest'

function request(modelName = 'Model A', sync = vi.fn(async () => {})) {
  return { deviceId: 'cloud-device', deviceName: 'Cloud Executor', modelName, sync }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}

test('keeps queued confirmations separate and restores focus after the last response', async () => {
  const user = userEvent.setup()
  render(
    <>
      <button type="button">Choose model</button>
      <CloudModelCatalogSyncDialogHost />
    </>
  )
  const opener = screen.getByRole('button', { name: 'Choose model' })
  opener.focus()
  const second = request('Model B')
  let one!: Promise<boolean>, two!: Promise<boolean>
  act(() => {
    one = requestCloudModelCatalogSync(request())
    two = requestCloudModelCatalogSync(second)
  })
  const cancel = screen.getByTestId('cloud-model-catalog-sync-cancel-button')
  await waitFor(() => expect(cancel).toHaveFocus())
  await user.click(cancel)
  await expect(one).resolves.toBe(false)
  expect(screen.getByRole('dialog')).toHaveTextContent('Model B')
  expect(cancel).toHaveFocus()
  await user.click(screen.getByTestId('cloud-model-catalog-sync-confirm-button'))
  await expect(two).resolves.toBe(true)
  expect(second.sync).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(opener).toHaveFocus())
})

test('does not cancel or confirm a second request while the reviewed sync is running', async () => {
  const pending = deferred()
  const operation = request(
      'Model A',
      vi.fn(() => pending.promise)
    ),
    next = request('Model B')
  render(<CloudModelCatalogSyncDialogHost />)
  let one!: Promise<boolean>, two!: Promise<boolean>
  act(() => {
    one = requestCloudModelCatalogSync(operation)
    two = requestCloudModelCatalogSync(next)
  })
  const confirm = screen.getByTestId('cloud-model-catalog-sync-confirm-button')
  fireEvent.click(confirm)
  fireEvent.click(confirm)
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', bubbles: true })
  expect(screen.getByTestId('cloud-model-catalog-sync-cancel-button')).toBeDisabled()
  expect(screen.getByRole('dialog')).toHaveTextContent('Model A')
  expect(operation.sync).toHaveBeenCalledTimes(1)
  expect(next.sync).not.toHaveBeenCalled()
  await act(async () => pending.resolve())
  await expect(one).resolves.toBe(true)
  expect(screen.getByRole('dialog')).toHaveTextContent('Model B')
  expect(screen.getByTestId('cloud-model-catalog-sync-cancel-button')).toHaveFocus()
  fireEvent.click(screen.getByTestId('cloud-model-catalog-sync-cancel-button'))
  await expect(two).resolves.toBe(false)
})

test('keeps the current failure visible when a later confirmation arrives and allows retry', async () => {
  const sync = vi.fn().mockRejectedValueOnce(new Error('Cloud busy')).mockResolvedValue(undefined)
  render(<CloudModelCatalogSyncDialogHost />)
  let one!: Promise<boolean>, two!: Promise<boolean>
  act(() => {
    one = requestCloudModelCatalogSync(request('Model A', sync))
  })
  fireEvent.click(screen.getByTestId('cloud-model-catalog-sync-confirm-button'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Cloud busy')
  act(() => {
    two = requestCloudModelCatalogSync(request('Model B'))
  })
  expect(screen.getByRole('alert')).toHaveTextContent('Cloud busy')
  fireEvent.click(screen.getByTestId('cloud-model-catalog-sync-confirm-button'))
  await act(async () => {
    await one
  })
  await expect(one).resolves.toBe(true)
  expect(screen.getByRole('dialog')).toHaveTextContent('Model B')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(sync).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByTestId('cloud-model-catalog-sync-cancel-button'))
  await expect(two).resolves.toBe(false)
})

test('releases unconfirmed callers when the host unmounts without starting synchronization', async () => {
  const { unmount } = render(<CloudModelCatalogSyncDialogHost />)
  const first = request(),
    second = request('Model B')
  let one!: Promise<boolean>, two!: Promise<boolean>
  act(() => {
    one = requestCloudModelCatalogSync(first)
    two = requestCloudModelCatalogSync(second)
  })
  unmount()
  await expect(one).resolves.toBe(false)
  await expect(two).resolves.toBe(false)
  expect(first.sync).not.toHaveBeenCalled()
  expect(second.sync).not.toHaveBeenCalled()
})

test('finishes the confirmed sync after host unmount without starting the next queued sync', async () => {
  const pending = deferred(),
    next = request('Model B')
  const { unmount } = render(<CloudModelCatalogSyncDialogHost />)
  let one!: Promise<boolean>, two!: Promise<boolean>
  act(() => {
    one = requestCloudModelCatalogSync(
      request(
        'Model A',
        vi.fn(() => pending.promise)
      )
    )
    two = requestCloudModelCatalogSync(next)
  })
  fireEvent.click(screen.getByTestId('cloud-model-catalog-sync-confirm-button'))
  unmount()
  await expect(two).resolves.toBe(false)
  await act(async () => pending.resolve())
  await expect(one).resolves.toBe(true)
  expect(next.sync).not.toHaveBeenCalled()
})
