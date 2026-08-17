import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { CloudModelCatalogSyncDialogHost } from './cloudModelCatalogSync'
import { requestCloudModelCatalogSync } from './cloudModelCatalogSyncRequest'

describe('CloudModelCatalogSyncDialogHost', () => {
  test('cancels without synchronizing', async () => {
    const sync = vi.fn()
    render(<CloudModelCatalogSyncDialogHost />)

    let result!: Promise<boolean>
    act(() => {
      result = requestCloudModelCatalogSync({
        deviceId: 'cloud-device',
        deviceName: 'Cloud Executor',
        modelName: 'Local Responses',
        sync,
      })
    })

    expect(await screen.findByTestId('cloud-model-catalog-sync-dialog')).toHaveTextContent(
      'Local Responses'
    )
    expect(screen.getByTestId('cloud-model-catalog-sync-dialog')).toHaveTextContent(
      'Cloud Executor'
    )

    await userEvent.click(screen.getByTestId('cloud-model-catalog-sync-cancel-button'))

    await expect(result).resolves.toBe(false)
    expect(sync).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.queryByTestId('cloud-model-catalog-sync-dialog')).not.toBeInTheDocument()
    )
  })

  test('synchronizes before resolving confirmation', async () => {
    const sync = vi.fn().mockResolvedValue(undefined)
    render(<CloudModelCatalogSyncDialogHost />)

    let result!: Promise<boolean>
    act(() => {
      result = requestCloudModelCatalogSync({
        deviceId: 'cloud-device',
        deviceName: 'Cloud Executor',
        modelName: 'Local Responses',
        sync,
      })
    })
    await screen.findByTestId('cloud-model-catalog-sync-dialog')

    await userEvent.click(screen.getByTestId('cloud-model-catalog-sync-confirm-button'))

    await expect(result).resolves.toBe(true)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  test('keeps the dialog open when synchronization fails', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('Cloud Codex is busy'))
    render(<CloudModelCatalogSyncDialogHost />)

    act(() => {
      void requestCloudModelCatalogSync({
        deviceId: 'cloud-device',
        deviceName: 'Cloud Executor',
        modelName: 'Local Responses',
        sync,
      })
    })
    await screen.findByTestId('cloud-model-catalog-sync-dialog')

    await userEvent.click(screen.getByTestId('cloud-model-catalog-sync-confirm-button'))

    expect(await screen.findByTestId('cloud-model-catalog-sync-error')).toHaveTextContent(
      'Cloud Codex is busy'
    )
    expect(screen.getByTestId('cloud-model-catalog-sync-dialog')).toBeInTheDocument()
  })

  test('traps focus, cancels with Escape, and restores focus', async () => {
    const user = userEvent.setup()
    render(
      <>
        <button type="button">Before dialog</button>
        <CloudModelCatalogSyncDialogHost />
      </>
    )
    const beforeDialog = screen.getByRole('button', { name: 'Before dialog' })
    beforeDialog.focus()

    let result!: Promise<boolean>
    act(() => {
      result = requestCloudModelCatalogSync({
        deviceId: 'cloud-device',
        deviceName: 'Cloud Executor',
        modelName: 'Local Responses',
        sync: vi.fn(),
      })
    })

    const cancelButton = await screen.findByTestId('cloud-model-catalog-sync-cancel-button')
    const confirmButton = screen.getByTestId('cloud-model-catalog-sync-confirm-button')
    await waitFor(() => expect(cancelButton).toHaveFocus())

    await user.tab({ shift: true })
    expect(confirmButton).toHaveFocus()
    await user.tab()
    expect(cancelButton).toHaveFocus()

    await user.keyboard('{Escape}')

    await expect(result).resolves.toBe(false)
    await waitFor(() => expect(beforeDialog).toHaveFocus())
  })
})
