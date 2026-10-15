// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import type { DeviceInfo } from '@/apis/devices'
import { DeviceCard } from '@/features/devices/components/DeviceCard'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('@/features/devices/components/RunningTasksList', () => ({
  RunningTasksList: () => null,
}))

const baseDevice: DeviceInfo = {
  id: 1,
  device_id: 'test-device',
  name: 'Test device',
  status: 'online',
  device_type: 'local',
  is_default: false,
  connection_mode: 'websocket',
  slot_used: 0,
  slot_max: 1,
  running_tasks: [],
  executor_version: null,
  latest_version: null,
  update_available: false,
}

const callbacks = {
  onStartTask: jest.fn(),
  onSetDefault: jest.fn(),
  onDelete: jest.fn(),
  onCancelTask: jest.fn(),
}

describe('DeviceCard Wework badge', () => {
  it.each<DeviceInfo['status']>(['offline', 'online', 'busy'])(
    'shows remote image guidance only while connected: %s',
    status => {
      render(
        <DeviceCard
          device={{ ...baseDevice, device_type: 'remote', status, update_available: true }}
          {...callbacks}
          onUpgrade={jest.fn()}
        />
      )
      const hint = screen.queryByTestId('device-manual-upgrade-hint')
      if (status === 'offline') {
        expect(hint).not.toBeInTheDocument()
      } else {
        expect(hint).toHaveTextContent('version.repullRemoteImage')
      }
      expect(screen.queryByTestId('device-upgrade-badge')).not.toBeInTheDocument()
    }
  )

  it.each<DeviceInfo['device_type']>(['app', 'remote'])(
    'replaces upgrades with manual guidance on %s devices',
    deviceType => {
      render(
        <DeviceCard
          device={{
            ...baseDevice,
            device_type: deviceType,
            executor_version: '2.0.20',
            latest_version: '2.0.21',
            update_available: true,
          }}
          {...callbacks}
          onUpgrade={jest.fn()}
        />
      )
      expect(screen.queryByTestId('device-upgrade-badge')).not.toBeInTheDocument()
      expect(screen.getByTestId('device-manual-upgrade-hint')).toHaveTextContent(
        deviceType === 'app' ? 'version.upgradeInWework' : 'version.repullRemoteImage'
      )
    }
  )

  it('retains upgrades for standalone local executors', () => {
    const onUpgrade = jest.fn()
    const device = {
      ...baseDevice,
      executor_version: '2.0.20',
      latest_version: '2.0.21',
      update_available: true,
    }
    render(<DeviceCard device={device} {...callbacks} onUpgrade={onUpgrade} />)
    fireEvent.click(screen.getByTestId('device-upgrade-badge'))
    expect(onUpgrade).toHaveBeenCalledWith(device)
  })
  it('shows the Wework badge on app devices', () => {
    render(<DeviceCard device={{ ...baseDevice, device_type: 'app' }} {...callbacks} />)
    expect(screen.getByTestId('wework-device-badge')).toHaveTextContent('wework_device_badge')
  })

  it.each<DeviceInfo['device_type']>(['local', 'remote', 'cloud'])(
    'hides the Wework badge on %s devices',
    deviceType => {
      render(<DeviceCard device={{ ...baseDevice, device_type: deviceType }} {...callbacks} />)
      expect(screen.queryByTestId('wework-device-badge')).not.toBeInTheDocument()
    }
  )
})
