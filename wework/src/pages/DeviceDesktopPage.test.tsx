import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { DeviceInfo } from '@/types/devices'
import DeviceDesktopPage from './DeviceDesktopPage'
import { deviceDesktopRoute, isDeviceDesktopInternalPageUrl } from './deviceDesktopRoute'

const startDeviceVncMock = vi.hoisted(() => vi.fn())
const workbenchState = vi.hoisted(() => ({
  devices: [] as DeviceInfo[],
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    services: {
      workspaceSessionApi: {
        startDeviceVnc: startDeviceVncMock,
      },
    },
    state: workbenchState,
  }),
}))

vi.mock('@/components/vnc/VncViewer', () => ({
  VncViewer: ({ websocketUrl }: { websocketUrl: string }) => (
    <div data-testid="mock-vnc-viewer">{websocketUrl}</div>
  ),
}))

function desktopDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'Device 1',
    status: 'online',
    is_default: false,
    device_type: 'remote',
    bind_shell: 'claudecode',
    runtime_features: {
      schemaVersion: 4,
      desktop: {
        version: 1,
        available: true,
        protocol: 'rfb',
        transport: 'websocket',
        clipboard: 'extended-text',
      },
    },
    ...overrides,
  }
}

describe('DeviceDesktopPage', () => {
  beforeEach(() => {
    startDeviceVncMock.mockReset()
    workbenchState.devices = [desktopDevice()]
  })

  test('stores only the device id in the route', () => {
    expect(deviceDesktopRoute('device-1')).toBe('/device-desktop?deviceId=device-1')
    expect(isDeviceDesktopInternalPageUrl('/device-desktop?deviceId=device-1')).toBe(true)
  })

  test('starts a VNC websocket session and renders the generic viewer', async () => {
    startDeviceVncMock.mockResolvedValue({
      session_id: 'vnc-session-1',
      device_id: 'device-1',
      type: 'vnc',
      path: '/',
      url: 'ws://127.0.0.1/s/vnc-session-1/websockify?token=secret',
      transport: 'websocket',
    })

    render(<DeviceDesktopPage search="?deviceId=device-1" />)

    await waitFor(() => expect(startDeviceVncMock).toHaveBeenCalledWith('device-1'))
    expect(await screen.findByTestId('mock-vnc-viewer')).toHaveTextContent(
      'ws://127.0.0.1/s/vnc-session-1/websockify?token=secret'
    )
  })

  test('fails closed when the live desktop capability is missing', async () => {
    workbenchState.devices = [desktopDevice({ runtime_features: { schemaVersion: 4 } })]

    render(<DeviceDesktopPage search="?deviceId=device-1" />)

    expect(await screen.findByTestId('device-desktop-status')).toHaveTextContent(
      'workbench.device_desktop_unavailable'
    )
    expect(startDeviceVncMock).not.toHaveBeenCalled()
  })
})
