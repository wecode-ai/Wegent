import '@/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DeviceStatusPrompt } from './DeviceStatusPrompt'

describe('DeviceStatusPrompt', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  test('prioritizes upgrade for the active low-version device even when another device is compatible', async () => {
    const onUpgradeDevice = vi.fn().mockResolvedValue(undefined)

    render(
      <DeviceStatusPrompt
        devices={[
          {
            id: 1,
            device_id: 'old-device',
            name: 'Old Device',
            status: 'online',
            is_default: false,
            device_type: 'cloud',
            bind_shell: 'claudecode',
            executor_version: '1.8.4',
            slot_used: 0,
          },
          {
            id: 2,
            device_id: 'new-device',
            name: 'New Device',
            status: 'online',
            is_default: false,
            device_type: 'cloud',
            bind_shell: 'claudecode',
            executor_version: '1.8.5',
          },
        ]}
        activeDeviceId="old-device"
        upgradingDevices={{}}
        onUpgradeDevice={onUpgradeDevice}
        onOpenCloudDeviceSettings={vi.fn()}
      />
    )

    expect(screen.getByTestId('device-status-prompt')).toHaveTextContent(
      'Old Device 版本低于 1.8.5，升级后可继续对话'
    )

    await userEvent.click(screen.getByTestId('device-status-upgrade-button'))

    expect(onUpgradeDevice).toHaveBeenCalledWith('old-device')
  })

  test('does not count offline devices with available updates in the sidebar action', () => {
    const onUpgradeDevice = vi.fn().mockResolvedValue(undefined)

    render(
      <DeviceStatusPrompt
        devices={[
          {
            id: 732,
            device_id: 'offline-device-one',
            name: 'macOS-Device-one',
            status: 'offline',
            is_default: false,
            device_type: 'local',
            bind_shell: 'claudecode',
            executor_version: null,
            latest_version: '1.0.0',
            update_available: true,
            slot_used: 0,
            running_tasks: [],
          },
          {
            id: 743,
            device_id: 'offline-device-two',
            name: 'macOS-Device-two',
            status: 'offline',
            is_default: false,
            device_type: 'local',
            bind_shell: 'claudecode',
            executor_version: null,
            latest_version: '1.0.0',
            update_available: true,
            slot_used: 0,
            running_tasks: [],
          },
          {
            id: 763,
            device_id: 'online-compatible-device',
            name: 'macOS-Device-compatible',
            status: 'online',
            is_default: false,
            device_type: 'local',
            bind_shell: 'claudecode',
            executor_version: '1.8.5',
            latest_version: '1.0.0',
            update_available: false,
            slot_used: 0,
            running_tasks: [],
          },
        ]}
        upgradingDevices={{}}
        onUpgradeDevice={onUpgradeDevice}
        onOpenCloudDeviceSettings={vi.fn()}
        presentation="sidebar-action"
      />
    )

    expect(screen.queryByTestId('device-status-sidebar-action-button')).not.toBeInTheDocument()
    expect(onUpgradeDevice).not.toHaveBeenCalled()
  })
})
