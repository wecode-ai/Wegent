import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { DeviceStatusPrompt } from './DeviceStatusPrompt'

describe('DeviceStatusPrompt', () => {
  test('prompts to create a device when no ClaudeCode devices exist', async () => {
    const onOpenCloudDeviceSettings = vi.fn()

    render(
      <DeviceStatusPrompt
        devices={[]}
        upgradingDevices={{}}
        onUpgradeDevice={vi.fn()}
        onOpenCloudDeviceSettings={onOpenCloudDeviceSettings}
      />,
    )

    expect(screen.getByTestId('device-status-prompt')).toHaveTextContent(
      '需要连接设备后才能使用 Wework',
    )

    await userEvent.click(screen.getByTestId('device-status-create-device-button'))

    expect(onOpenCloudDeviceSettings).toHaveBeenCalledTimes(1)
  })

  test('offers upgrade for an online idle device below the WeWork executor version', async () => {
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
        ]}
        upgradingDevices={{}}
        onUpgradeDevice={onUpgradeDevice}
        onOpenCloudDeviceSettings={vi.fn()}
      />,
    )

    expect(screen.getByTestId('device-status-prompt')).toHaveTextContent(
      'Old Device 版本低于 1.8.5，升级后可继续使用',
    )
    expect(screen.getByTestId('device-status-upgrade-button')).toHaveTextContent(
      '升级该设备',
    )

    await userEvent.click(screen.getByTestId('device-status-upgrade-button'))

    expect(onUpgradeDevice).toHaveBeenCalledWith('old-device')
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
      />,
    )

    expect(screen.getByTestId('device-status-prompt')).toHaveTextContent(
      'Old Device 版本低于 1.8.5，升级后可继续对话',
    )

    await userEvent.click(screen.getByTestId('device-status-upgrade-button'))

    expect(onUpgradeDevice).toHaveBeenCalledWith('old-device')
  })
})
