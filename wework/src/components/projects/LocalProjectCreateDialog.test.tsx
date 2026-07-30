import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { LocalProjectCreateDialog } from './LocalProjectCreateDialog'

const pickerMocks = vi.hoisted(() => ({ open: vi.fn() }))

vi.mock('@/lib/native-directory-picker', () => ({
  openNativeProjectDirectoryPickers: pickerMocks.open,
}))

const baseProps = {
  open: true,
  device: { device_id: 'local-device', name: 'Local' },
  initialRoots: ['/repo/web'],
  onGetDeviceHomeDirectory: vi.fn().mockResolvedValue('/repo'),
  onListDeviceDirectories: vi.fn().mockResolvedValue([]),
  onCreateDeviceDirectory: vi.fn().mockResolvedValue(undefined),
  onClose: vi.fn(),
}

describe('LocalProjectCreateDialog', () => {
  test('creates one project from the selected source folders', async () => {
    pickerMocks.open.mockResolvedValue(['/repo/api'])
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<LocalProjectCreateDialog {...baseProps} onCreate={onCreate} />)

    await userEvent.type(screen.getByTestId('local-project-create-name-input'), 'Product')
    await userEvent.click(screen.getByTestId('add-local-project-create-folders'))
    expect(await screen.findByText('api')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('confirm-local-project-create-button'))

    expect(onCreate).toHaveBeenCalledWith({
      deviceId: 'local-device',
      name: 'Product',
      roots: ['/repo/web', '/repo/api'],
    })
  })

  test('requires a name and at least one source folder', async () => {
    render(<LocalProjectCreateDialog {...baseProps} onCreate={vi.fn()} />)

    expect(screen.getByTestId('confirm-local-project-create-button')).toBeDisabled()
    await userEvent.type(screen.getByTestId('local-project-create-name-input'), 'Product')
    await userEvent.click(screen.getByTestId('remove-local-project-create-root-0'))
    expect(screen.getByTestId('confirm-local-project-create-button')).toBeDisabled()
  })
})
