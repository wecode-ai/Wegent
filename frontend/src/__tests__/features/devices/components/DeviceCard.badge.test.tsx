// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

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

  it.each<DeviceInfo['status']>(['offline', 'online', 'busy'])(
    'hides upgrade prompts on Wework devices: %s',
    status => {
      render(
        <DeviceCard
          device={{
            ...baseDevice,
            device_type: 'app',
            status,
            executor_version: '2.0.20',
            latest_version: '2.0.21',
            update_available: true,
          }}
          {...callbacks}
          onUpgrade={jest.fn()}
        />
      )
      expect(screen.getByTestId('wework-device-badge')).toHaveTextContent('wework_device_badge')
      if (status !== 'offline') {
        expect(screen.getByText('v2.0.20')).toBeInTheDocument()
      }
      expect(screen.queryByTestId('device-upgrade-badge')).not.toBeInTheDocument()
      expect(screen.queryByTestId('device-manual-upgrade-hint')).not.toBeInTheDocument()
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
  it('confirms a cloud restart from the version badge and allows retry when unavailable', async () => {
    const onUpgrade = jest.fn()
    const onRestart = jest
      .fn()
      .mockRejectedValueOnce(new Error('Restart unavailable'))
      .mockResolvedValueOnce(undefined)
    const device: DeviceInfo = {
      ...baseDevice,
      device_type: 'cloud',
      executor_version: '1.6.4',
      latest_version: '2.0.21',
      update_available: true,
      slot_used: 1,
    }
    render(
      <DeviceCard device={device} {...callbacks} onRestart={onRestart} onUpgrade={onUpgrade} />
    )
    fireEvent.click(screen.getByTestId('cloud-device-restart-version-badge'))
    expect(screen.getByTestId('cloud-device-restart-dialog')).toHaveTextContent('restart.busy')
    expect(onRestart).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('confirm-cloud-device-restart'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Restart unavailable')
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onRestart).toHaveBeenCalledWith(device)

    fireEvent.click(screen.getByTestId('confirm-cloud-device-restart'))
    await waitFor(() =>
      expect(screen.queryByTestId('cloud-device-restart-dialog')).not.toBeInTheDocument()
    )
    expect(onRestart).toHaveBeenCalledTimes(2)
    expect(onUpgrade).not.toHaveBeenCalled()
  })

  it.each<DeviceInfo['device_type']>(['local', 'remote', 'cloud'])(
    'hides the Wework badge on %s devices',
    deviceType => {
      render(<DeviceCard device={{ ...baseDevice, device_type: deviceType }} {...callbacks} />)
      expect(screen.queryByTestId('wework-device-badge')).not.toBeInTheDocument()
    }
  )
})
