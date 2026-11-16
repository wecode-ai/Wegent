import '@/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createSettingsDeviceApi } from '@/components/settings/settings-cloud-api'
import { WorkbenchCloudDeviceRestarts } from '@/features/cloud-devices/WorkbenchCloudDeviceRestarts'
import type { DeviceInfo } from '@/types/devices'
import { DeviceStatusPrompt } from './DeviceStatusPrompt'

vi.mock('@/components/settings/settings-cloud-api', () => ({ createSettingsDeviceApi: vi.fn() }))

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
            device_type: 'local',
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
            device_type: 'local',
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

  test('confirms a cloud restart and reports recovery even when the version is still old', async () => {
    const oldDevice: DeviceInfo = {
      id: 1,
      device_id: 'old-device',
      name: 'Old Device',
      status: 'online',
      is_default: false,
      device_type: 'cloud',
      bind_shell: 'claudecode',
      executor_version: '1.8.4',
      runtime_instance_id: 'before',
      update_available: true,
    }
    const restartCloudDevice = vi.fn().mockResolvedValue({ message: 'accepted' })
    vi.mocked(createSettingsDeviceApi).mockReturnValue({
      restartCloudDevice,
    } as ReturnType<typeof createSettingsDeviceApi>)
    const onUpgradeDevice = vi.fn().mockResolvedValue(undefined)
    const refreshDevices = vi.fn().mockResolvedValue(undefined)
    const view = (device: DeviceInfo) => (
      <WorkbenchCloudDeviceRestarts devices={[device]} refreshDevices={refreshDevices}>
        <DeviceStatusPrompt
          devices={[device]}
          activeDeviceId={device.device_id}
          upgradingDevices={{}}
          onUpgradeDevice={onUpgradeDevice}
          onOpenCloudDeviceSettings={vi.fn()}
        />
      </WorkbenchCloudDeviceRestarts>
    )
    const { rerender } = render(view(oldDevice))
    await userEvent.click(screen.getByTestId('device-status-restart-button'))
    expect(screen.getByTestId('confirm-restart-device-dialog')).toHaveTextContent('短暂离线')
    expect(restartCloudDevice).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('confirm-restart-device-button'))
    expect(restartCloudDevice).toHaveBeenCalledExactlyOnceWith('old-device')
    expect(onUpgradeDevice).not.toHaveBeenCalled()
    expect(
      await screen.findByTestId('connection-device-restart-status-old-device')
    ).toHaveTextContent('设备将短暂离线')
    rerender(view({ ...oldDevice, runtime_instance_id: 'after' }))
    expect(await screen.findByText('设备已重新在线。')).toBeVisible()
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
