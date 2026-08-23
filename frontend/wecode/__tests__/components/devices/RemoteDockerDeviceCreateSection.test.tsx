// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { deviceApis } from '@/apis/devices'
import { createDockerRemoteDeviceCommand } from '@wecode/api/remote-devices'
import { RemoteDockerDeviceCreateSection } from '@wecode/components/devices/RemoteDockerDeviceCreateSection'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/apis/devices', () => ({
  deviceApis: {
    getAllDevices: jest.fn(),
  },
}))

jest.mock('@wecode/api/remote-devices', () => ({
  createDockerRemoteDeviceCommand: jest.fn(),
}))

const mockedDeviceApis = jest.mocked(deviceApis)
const mockedCreateDockerRemoteDeviceCommand = jest.mocked(createDockerRemoteDeviceCommand)

describe('RemoteDockerDeviceCreateSection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
    })
  })

  it('generates and copies a host-network command without an IDE URL input', async () => {
    mockedCreateDockerRemoteDeviceCommand.mockResolvedValue({
      device_id: 'remote-device-1',
      name: 'remote-device',
      image: 'registry.api.weibo.com/ci/wegent-device:1.8.6',
      env: {
        WEGENT_BACKEND_URL: 'https://wegent.intra.weibo.com',
        WEGENT_SOCKET_URL: 'wss://wss-wegent.intra.weibo.com',
      },
      command: 'docker run -d --network host registry.api.weibo.com/ci/wegent-device:1.8.6',
      commands: [],
    })

    render(<RemoteDockerDeviceCreateSection onDeviceCreated={jest.fn()} />)

    expect(screen.queryByTestId('remote-device-public-base-url')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('remote-device-generate-command'))

    await waitFor(() => {
      expect(mockedCreateDockerRemoteDeviceCommand).toHaveBeenCalledWith()
    })

    expect(screen.getByTestId('remote-device-command')).toHaveTextContent('--network host')
    expect(screen.getByTestId('remote-device-command')).not.toHaveTextContent('-p 17888:17888')
    expect(screen.getByTestId('remote-device-backend-url')).toHaveTextContent(
      'https://wegent.intra.weibo.com'
    )
    expect(screen.getByTestId('remote-device-socket-url')).toHaveTextContent(
      'wss://wss-wegent.intra.weibo.com'
    )
    await waitFor(() => {
      expect(screen.getByTestId('remote-device-connection-status')).toHaveTextContent(
        'remote_status_waiting'
      )
    })

    fireEvent.click(screen.getByTestId('remote-device-copy-command'))
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'docker run -d --network host registry.api.weibo.com/ci/wegent-device:1.8.6'
      )
    })
  })

  it('keeps the setup open while reporting a registered device version mismatch', async () => {
    jest.useFakeTimers()
    const onDeviceCreated = jest.fn()
    const onDeviceDetected = jest.fn()
    mockedCreateDockerRemoteDeviceCommand.mockResolvedValue({
      device_id: 'remote-device-1',
      name: 'remote-device',
      image: 'registry.api.weibo.com/ci/wegent-device:1.8.6',
      env: {},
      command: 'docker run --network host',
      commands: [],
    })
    mockedDeviceApis.getAllDevices.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 1,
          device_id: 'remote-device-1',
          name: 'remote-device',
          status: 'online',
          is_default: false,
          device_type: 'remote',
          connection_mode: 'websocket',
          slot_used: 0,
          slot_max: 1,
          running_tasks: [],
          executor_version: 'dev',
          latest_version: '1.8.6',
          update_available: true,
        },
      ],
    })

    try {
      render(
        <RemoteDockerDeviceCreateSection
          onDeviceCreated={onDeviceCreated}
          onDeviceDetected={onDeviceDetected}
        />
      )
      await act(async () => {
        fireEvent.click(screen.getByTestId('remote-device-generate-command'))
      })
      expect(mockedCreateDockerRemoteDeviceCommand).toHaveBeenCalledTimes(1)
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2000)
      })

      expect(onDeviceDetected).toHaveBeenCalledTimes(1)
      expect(onDeviceCreated).not.toHaveBeenCalled()
      expect(screen.getByTestId('remote-device-connection-status')).toHaveTextContent(
        'remote_status_version_mismatch'
      )
    } finally {
      jest.useRealTimers()
    }
  })
})
