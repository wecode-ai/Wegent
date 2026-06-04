import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { PluginUploadDialog } from './PluginUploadDialog'

describe('PluginUploadDialog', () => {
  test('rejects plugin packages larger than 50MB before upload', async () => {
    const onUpload = vi.fn()
    render(
      <PluginUploadDialog
        isUploading={false}
        onCancel={vi.fn()}
        onUpload={onUpload}
      />,
    )

    const file = new File(['x'], 'large-plugin.zip', { type: 'application/zip' })
    Object.defineProperty(file, 'size', { value: 50 * 1024 * 1024 + 1 })
    await userEvent.upload(screen.getByTestId('plugin-upload-file-input'), file)

    expect(screen.getByText('插件安装包不能超过 50MB')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('plugin-upload-confirm-button'))
    expect(onUpload).not.toHaveBeenCalled()
  })

  test('accepts uppercase zip filenames and surfaces upload failures', async () => {
    const onUpload = vi.fn().mockRejectedValue(new Error('Backend rejected package'))
    render(
      <PluginUploadDialog
        isUploading={false}
        onCancel={vi.fn()}
        onUpload={onUpload}
      />,
    )

    const file = new File(['zip'], 'plugin.ZIP', { type: 'application/zip' })
    await userEvent.upload(screen.getByTestId('plugin-upload-file-input'), file)
    await userEvent.click(screen.getByTestId('plugin-upload-confirm-button'))

    expect(onUpload).toHaveBeenCalledWith(file)
    expect(await screen.findByText('Backend rejected package')).toBeInTheDocument()
  })
})
