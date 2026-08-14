// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { Server } from 'lucide-react'

import type { DeviceInfo } from '@/apis/devices'
import { DeviceSection } from '@/features/devices/components/DeviceSection'

function device(deviceId: string, deviceType: DeviceInfo['device_type']): DeviceInfo {
  return {
    id: deviceId === 'remote-1' ? 1 : 2,
    device_id: deviceId,
    name: deviceId,
    status: 'online',
    is_default: false,
    device_type: deviceType,
    connection_mode: 'websocket',
    slot_used: 0,
    slot_max: 1,
    running_tasks: [],
    executor_version: '1.8.5',
    latest_version: '1.8.5',
    update_available: false,
  }
}

describe('DeviceSection remote devices', () => {
  it('renders only remote devices and reports their count', () => {
    render(
      <DeviceSection
        title="Remote devices"
        icon={Server}
        devices={[device('remote-1', 'remote'), device('local-1', 'local')]}
        type="remote"
        emptyMessage="No remote devices"
      >
        {item => <div data-testid={`device-${item.device_id}`}>{item.name}</div>}
      </DeviceSection>
    )

    expect(screen.getByText('Remote devices').parentElement).toHaveTextContent('(1)')
    expect(screen.getByTestId('device-remote-1')).toBeInTheDocument()
    expect(screen.queryByTestId('device-local-1')).not.toBeInTheDocument()
  })
})
