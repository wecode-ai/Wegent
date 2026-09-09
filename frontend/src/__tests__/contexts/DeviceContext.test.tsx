// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DeviceInfo } from '@/apis/devices'
import { deviceApis } from '@/apis/devices'
import { DeviceProvider, useDevices } from '@/contexts/DeviceContext'

jest.mock('@/apis/devices', () => {
  const actual = jest.requireActual('@/apis/devices')
  return {
    ...actual,
    deviceApis: {
      ...actual.deviceApis,
      getAllDevices: jest.fn(),
      deleteDevice: jest.fn(),
    },
  }
})

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ socket: null, isConnected: false }),
}))

function createDevice(overrides: Partial<DeviceInfo>): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'Device 1',
    status: 'online',
    is_default: false,
    device_type: 'local',
    connection_mode: 'websocket',
    slot_used: 0,
    slot_max: 1,
    running_tasks: [],
    executor_version: null,
    latest_version: null,
    update_available: false,
    ...overrides,
  }
}

function DeviceProbe() {
  const { devices, selectedDeviceId, setSelectedDeviceId, deleteDevice, isLoading } = useDevices()

  return (
    <div>
      <span data-testid="device-list">{devices.map(device => device.name).join(',')}</span>
      <span data-testid="device-ids">{devices.map(device => device.device_id).join(',')}</span>
      <span data-testid="selected-device">{selectedDeviceId ?? 'cloud'}</span>
      <span data-testid="loading-state">{String(isLoading)}</span>
      <button type="button" onClick={() => setSelectedDeviceId('app-device')}>
        Select app device
      </button>
      <button type="button" onClick={() => void deleteDevice(2)}>
        Delete second record
      </button>
    </div>
  )
}

describe('DeviceContext', () => {
  it('routes duplicate logical names by record and removes only the selected record', async () => {
    ;(deviceApis.getAllDevices as jest.Mock).mockResolvedValue({
      items: [
        createDevice({
          id: 1,
          device_type: 'app',
          device_id: 'local-device',
          execution_target_id: 'app-record-1',
        }),
        createDevice({
          id: 2,
          device_type: 'app',
          device_id: 'local-device',
          execution_target_id: 'app-record-2',
        }),
      ],
    })
    ;(deviceApis.deleteDevice as jest.Mock).mockResolvedValue({})
    render(
      <DeviceProvider>
        <DeviceProbe />
      </DeviceProvider>
    )
    await waitFor(() =>
      expect(screen.getByTestId('device-ids')).toHaveTextContent('app-record-1,app-record-2')
    )
    fireEvent.click(screen.getByText('Delete second record'))
    await waitFor(() =>
      expect(screen.getByTestId('device-ids')).toHaveTextContent(/^app-record-1$/)
    )
    expect(deviceApis.deleteDevice).toHaveBeenCalledWith(2)
  })
  beforeEach(() => {
    jest.clearAllMocks()
    ;(deviceApis.getAllDevices as jest.Mock).mockResolvedValue({
      items: [
        createDevice({ id: 1, device_id: 'local-device', name: 'Local Device' }),
        createDevice({
          id: 2,
          device_id: 'app-device',
          name: 'App Device',
          device_type: 'app',
        }),
        createDevice({
          id: 3,
          device_id: 'remote-device',
          name: 'Remote Device',
          device_type: 'remote',
        }),
      ],
      total: 3,
    })
  })

  it('includes Wework app registrations in Wegent device consumers', async () => {
    render(
      <DeviceProvider>
        <DeviceProbe />
      </DeviceProvider>
    )

    await waitFor(() => expect(screen.getByTestId('loading-state')).toHaveTextContent('false'))

    expect(screen.getByTestId('device-list')).toHaveTextContent(
      'Local Device,App Device,Remote Device'
    )
  })

  it('keeps a selected Wework app device available for chat', async () => {
    render(
      <DeviceProvider>
        <DeviceProbe />
      </DeviceProvider>
    )

    await waitFor(() => expect(screen.getByTestId('loading-state')).toHaveTextContent('false'))

    fireEvent.click(screen.getByRole('button', { name: 'Select app device' }))

    expect(screen.getByTestId('selected-device')).toHaveTextContent('app-device')
  })
})
