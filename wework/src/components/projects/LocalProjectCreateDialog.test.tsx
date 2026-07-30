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
  test('uses the first source folder name by default', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<LocalProjectCreateDialog {...baseProps} onCreate={onCreate} />)

    expect(screen.getByTestId('local-project-create-name-input')).toHaveValue('web')
    await userEvent.click(screen.getByTestId('confirm-local-project-create-button'))

    expect(onCreate).toHaveBeenCalledWith({
      deviceId: 'local-device',
      name: 'web',
      roots: ['/repo/web'],
    })
  })

  test('keeps a manually entered name when adding source folders', async () => {
    pickerMocks.open.mockResolvedValue(['/repo/api'])
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<LocalProjectCreateDialog {...baseProps} onCreate={onCreate} />)

    await userEvent.clear(screen.getByTestId('local-project-create-name-input'))
    await userEvent.type(screen.getByTestId('local-project-create-name-input'), 'Product')
    await userEvent.click(screen.getByTestId('add-local-project-create-folders'))
    expect(await screen.findByText('api')).toBeInTheDocument()
    expect(screen.getByTestId('local-project-create-name-input')).toHaveValue('Product')
    await userEvent.click(screen.getByTestId('confirm-local-project-create-button'))

    expect(onCreate).toHaveBeenCalledWith({
      deviceId: 'local-device',
      name: 'Product',
      roots: ['/repo/web', '/repo/api'],
    })
  })

  test('requires a name and at least one source folder', async () => {
    render(<LocalProjectCreateDialog {...baseProps} onCreate={vi.fn()} />)

    await userEvent.clear(screen.getByTestId('local-project-create-name-input'))
    expect(screen.getByTestId('confirm-local-project-create-button')).toBeDisabled()
    await userEvent.type(screen.getByTestId('local-project-create-name-input'), 'Product')
    await userEvent.click(screen.getByTestId('remove-local-project-create-root-0'))
    expect(screen.getByTestId('confirm-local-project-create-button')).toBeDisabled()
  })
})
