import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { DeviceStatusPrompt } from './DeviceStatusPrompt'

describe('DeviceStatusPrompt', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

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

  test('renders a blue sidebar action for regular available updates', async () => {
    const onUpgradeDevice = vi.fn().mockResolvedValue(undefined)

    render(
      <DeviceStatusPrompt
        devices={[
          {
            id: 1,
            device_id: 'new-device',
            name: 'New Device',
            status: 'online',
            is_default: false,
            device_type: 'cloud',
            bind_shell: 'claudecode',
            executor_version: '1.8.5',
            update_available: true,
          },
        ]}
        upgradingDevices={{}}
        onUpgradeDevice={onUpgradeDevice}
        onOpenCloudDeviceSettings={vi.fn()}
        presentation="sidebar-action"
      />,
    )

    const action = screen.getByTestId('device-status-sidebar-action-button')
    expect(action).toHaveTextContent('更新')
    expect(action).toHaveClass('bg-blue-50', 'text-blue-600', 'hover:bg-blue-100')
    expect(action).not.toHaveClass('text-primary', 'bg-primary/10')
    expect(action).not.toHaveAttribute('title')
    const tooltip = screen.getByTestId('device-status-sidebar-tooltip')
    expect(tooltip).toHaveTextContent('1 台设备有更新')
    expect(tooltip).toHaveClass('w-max')
    expect(tooltip).toHaveClass('break-words')
    expect(tooltip).not.toHaveClass('w-72')

    await userEvent.click(action)

    expect(onUpgradeDevice).toHaveBeenCalledWith('new-device')
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
      />,
    )

    expect(
      screen.queryByTestId('device-status-sidebar-action-button'),
    ).not.toBeInTheDocument()
    expect(onUpgradeDevice).not.toHaveBeenCalled()
  })

  test('renders a red sidebar action for below-minimum device upgrades', async () => {
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
        presentation="sidebar-action"
      />,
    )

    const action = screen.getByTestId('device-status-sidebar-action-button')
    expect(action).toHaveTextContent('升级')
    expect(action).toHaveClass('text-red-600')
    expect(action).not.toHaveAttribute('title')
    expect(screen.getByTestId('device-status-sidebar-tooltip')).toHaveTextContent(
      'Old Device 版本低于 1.8.5，升级后可继续使用',
    )

    await userEvent.click(action)

    expect(onUpgradeDevice).toHaveBeenCalledWith('old-device')
  })

  test('can suppress regular update banners near the composer', () => {
    render(
      <DeviceStatusPrompt
        devices={[
          {
            id: 1,
            device_id: 'new-device',
            name: 'New Device',
            status: 'online',
            is_default: false,
            device_type: 'cloud',
            bind_shell: 'claudecode',
            executor_version: '1.8.5',
            update_available: true,
          },
        ]}
        upgradingDevices={{}}
        onUpgradeDevice={vi.fn()}
        onOpenCloudDeviceSettings={vi.fn()}
        hideAvailableUpdates
      />,
    )

    expect(screen.queryByTestId('device-status-prompt')).not.toBeInTheDocument()
  })

  test('keeps the sidebar action during a transient empty device refresh', () => {
    const updateDevice = {
      id: 1,
      device_id: 'new-device',
      name: 'New Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud',
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
      update_available: true,
    }
    const { rerender } = render(
      <DeviceStatusPrompt
        devices={[updateDevice]}
        upgradingDevices={{}}
        onUpgradeDevice={vi.fn()}
        onOpenCloudDeviceSettings={vi.fn()}
        presentation="sidebar-action"
      />,
    )

    expect(screen.getByTestId('device-status-sidebar-action-button')).toHaveTextContent(
      '更新',
    )

    rerender(
      <DeviceStatusPrompt
        devices={[]}
        upgradingDevices={{}}
        onUpgradeDevice={vi.fn()}
        onOpenCloudDeviceSettings={vi.fn()}
        presentation="sidebar-action"
      />,
    )

    expect(screen.getByTestId('device-status-sidebar-action-button')).toHaveTextContent(
      '更新',
    )
  })

  test('keeps the sidebar action after remounting with transient empty devices', () => {
    const updateDevice = {
      id: 1,
      device_id: 'new-device',
      name: 'New Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud',
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
      update_available: true,
    }
    const { unmount } = render(
      <DeviceStatusPrompt
        devices={[updateDevice]}
        upgradingDevices={{}}
        onUpgradeDevice={vi.fn()}
        onOpenCloudDeviceSettings={vi.fn()}
        presentation="sidebar-action"
      />,
    )

    expect(screen.getByTestId('device-status-sidebar-action-button')).toHaveTextContent(
      '更新',
    )

    unmount()

    render(
      <DeviceStatusPrompt
        devices={[]}
        upgradingDevices={{}}
        onUpgradeDevice={vi.fn()}
        onOpenCloudDeviceSettings={vi.fn()}
        presentation="sidebar-action"
      />,
    )

    expect(screen.getByTestId('device-status-sidebar-action-button')).toHaveTextContent(
      '更新',
    )
  })
})
