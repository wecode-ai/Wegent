// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DeviceInfo } from '@/apis/devices'
import { deviceApis } from '@/apis/devices'
import { DeviceProvider, useDevices } from '@/contexts/DeviceContext'
import { ServerEvents } from '@/types/socket'

type Listener = (payload: unknown) => void

class FakeSocket {
  private listeners = new Map<string, Set<Listener>>()

  on(event: string, listener: Listener) {
    const listeners = this.listeners.get(event) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener)
  }

  emitServer(event: string, payload: unknown) {
    this.listeners.get(event)?.forEach(listener => listener(payload))
  }
}

const fakeSocket = new FakeSocket()

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    socket: fakeSocket,
    isConnected: true,
  }),
}))

jest.mock('@/apis/devices', () => ({
  deviceApis: {
    getAllDevices: jest.fn(),
    setDefaultDevice: jest.fn(),
    deleteDevice: jest.fn(),
  },
}))

function createDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'Cloud Device',
    status: 'online',
    is_default: false,
    last_heartbeat: '2026-06-25T08:00:00.000Z',
    device_type: 'cloud',
    connection_mode: 'websocket',
    capabilities: [],
    slot_used: 1,
    slot_max: 1,
    running_tasks: [
      {
        task_id: 477325485448656,
        subtask_id: 1,
        title: 'Running task',
        status: 'RUNNING',
      },
    ],
    executor_version: '2.0.1',
    latest_version: '2.0.1',
    update_available: false,
    cloud_config: {
      sandboxId: 'device-1',
      imageId: 'image-1',
      createdAt: '2026-06-25T07:59:00.000Z',
    },
    bind_shell: 'claudecode',
    ...overrides,
  }
}

function Probe() {
  const { devices, selectedDeviceId, setSelectedDeviceId } = useDevices()
  const selectedDevice = devices.find(device => device.device_id === selectedDeviceId)

  return (
    <div>
      <div data-testid="device-count">{devices.length}</div>
      <div data-testid="selected-device-id">{selectedDeviceId ?? 'none'}</div>
      <div data-testid="selected-device-status">{selectedDevice?.status ?? 'none'}</div>
      <button type="button" onClick={() => setSelectedDeviceId('device-1')}>
        Select device
      </button>
    </div>
  )
}

describe('DeviceContext offline events', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('keeps the selected device bound when a stale offline event is contradicted by refresh', async () => {
    jest
      .mocked(deviceApis.getAllDevices)
      .mockResolvedValueOnce({
        items: [createDevice()],
        total: 1,
      })
      .mockResolvedValueOnce({
        items: [createDevice({ status: 'online' })],
        total: 1,
      })

    render(
      <DeviceProvider>
        <Probe />
      </DeviceProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('device-count')).toHaveTextContent('1')
      expect(screen.getByTestId('selected-device-status')).toHaveTextContent('none')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Select device' }))
    expect(screen.getByTestId('selected-device-id')).toHaveTextContent('device-1')

    await act(async () => {
      fakeSocket.emitServer(ServerEvents.DEVICE_OFFLINE, { device_id: 'device-1' })
    })

    await waitFor(() => {
      expect(deviceApis.getAllDevices).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId('selected-device-status')).toHaveTextContent('online')
    })
    expect(screen.getByTestId('selected-device-id')).toHaveTextContent('device-1')
  })
})
