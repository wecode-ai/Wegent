import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import '@/i18n'
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
  test('selects an existing directory', async () => {
    const onConfirm = vi.fn()
    const onListDeviceDirectories = vi.fn((_: string, path: string) =>
      Promise.resolve(path === '/home/user' ? ['repo'] : [])
    )

    render(
      <DeviceFolderPicker
        device={device}
        mode="select"
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={vi.fn()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    const pathInput = await screen.findByTestId('device-folder-path-input')
    await waitFor(() => expect(pathInput).toHaveValue('/home/user'))
    await userEvent.click(await screen.findByText('repo'))
    await userEvent.click(screen.getByTestId('confirm-device-folder-picker-button'))

    expect(onConfirm).toHaveBeenCalledWith({
      deviceId: 'local-device',
      path: '/home/user/repo',
      action: 'select',
    })
  })

  test('creates a directory and returns the created path', async () => {
    const onConfirm = vi.fn()
    const onCreateDeviceDirectory = vi.fn().mockResolvedValue(undefined)

    render(
      <DeviceFolderPicker
        device={device}
        mode="create"
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onListDeviceDirectories={vi.fn().mockResolvedValue([])}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    await screen.findByTestId('device-folder-name-input')
    await userEvent.type(screen.getByTestId('device-folder-name-input'), 'new-app')
    await userEvent.click(screen.getByTestId('confirm-device-folder-picker-button'))

    await waitFor(() =>
      expect(onCreateDeviceDirectory).toHaveBeenCalledWith('local-device', '/home/user/new-app')
    )
    expect(onConfirm).toHaveBeenCalledWith({
      deviceId: 'local-device',
      path: '/home/user/new-app',
      action: 'create',
    })
  })

  test('opens the only fuzzy path match when Enter is pressed', async () => {
    const onListDeviceDirectories = vi.fn((_: string, path: string) =>
      Promise.resolve(path === '/home/user/repo' ? ['src'] : ['repo'])
    )

    render(
      <DeviceFolderPicker
        device={device}
        mode="select"
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/user')}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    const pathInput = await screen.findByTestId('device-folder-path-input')
    await userEvent.clear(pathInput)
    await userEvent.type(pathInput, '/home/user/re')
    fireEvent.keyDown(pathInput, { key: 'Enter' })

    await waitFor(() => expect(pathInput).toHaveValue('/home/user/repo'))
    expect(await screen.findByText('src')).toBeInTheDocument()
  })

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
})
