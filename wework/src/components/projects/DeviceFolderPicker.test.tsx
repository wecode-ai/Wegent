import '@/i18n'
import type { DeviceInfo } from '@/types/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { DeviceFolderPicker } from './DeviceFolderPicker'

const device: DeviceInfo = {
  id: 1,
  device_id: 'local-device',
  name: 'Local Device',
  status: 'online',
  is_default: true,
  device_type: 'local',
  bind_shell: 'claudecode',
  executor_version: '1.8.5',
}

describe('DeviceFolderPicker', () => {
  test('shows directory creation errors without closing', async () => {
    render(
      <DeviceFolderPicker
        device={device}
        mode="create"
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={vi.fn().mockRejectedValue(new Error('mkdir failed'))}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    await userEvent.type(await screen.findByTestId('device-folder-name-input'), 'new-app')
    await userEvent.click(screen.getByTestId('confirm-device-folder-picker-button'))

    expect(await screen.findByTestId('device-folder-picker-error')).toHaveTextContent(
      'mkdir failed'
    )
  })

  test('shows a home lookup error instead of silently opening the root directory', async () => {
    const onListDeviceDirectories = vi.fn()

    render(
      <DeviceFolderPicker
        device={{ ...device, device_type: 'remote' }}
        mode="select"
        variant="remote"
        onGetDeviceHomeDirectory={vi.fn().mockRejectedValue(new Error('home unavailable'))}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(await screen.findByTestId('device-folder-picker-error')).toHaveTextContent(
      'home unavailable'
    )
    expect(screen.getByTestId('device-folder-path-input')).toHaveValue('')
    expect(onListDeviceDirectories).not.toHaveBeenCalled()
  })
})
