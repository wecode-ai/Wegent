// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'

import type { DeviceInfo } from '@/apis/devices'
import { DeviceCard } from '@/features/devices/components/DeviceCard'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('@/features/devices/components/RunningTasksList', () => ({
  RunningTasksList: () => null,
}))
jest.mock('@/features/devices/components/VersionBadge', () => ({ VersionBadge: () => null }))

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
