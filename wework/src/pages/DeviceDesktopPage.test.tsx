import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { DeviceInfo } from '@/types/devices'
import DeviceDesktopPage from './DeviceDesktopPage'
import { deviceDesktopRoute, isDeviceDesktopInternalPageUrl } from './deviceDesktopRoute'

const startDeviceVncMock = vi.hoisted(() => vi.fn())
const revokeDeviceVncMock = vi.hoisted(() => vi.fn())
const executeCommandMock = vi.hoisted(() => vi.fn())
const workbenchState = vi.hoisted(() => ({
  devices: [] as DeviceInfo[],
}))
const runtimeState = vi.hoisted(() => ({ electron: false }))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    services: {
      deviceApi: {
        executeCommand: executeCommandMock,
      },
      workspaceSessionApi: {
        startDeviceVnc: startDeviceVncMock,
        revokeDeviceVnc: revokeDeviceVncMock,
      },
    },
    state: workbenchState,
  }),
}))

vi.mock('@/components/vnc/VncViewer', () => ({
  VncViewer: ({
    clipboardBridge,
    websocketUrl,
  }: {
    clipboardBridge?: unknown
    websocketUrl: string
  }) => (
    <div data-testid="mock-vnc-viewer" data-clipboard-bridge={clipboardBridge ? 'true' : 'false'}>
      {websocketUrl}
    </div>
  ),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => runtimeState.electron,
}))

function desktopDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'Device 1',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
    bind_shell: 'claudecode',
    runtime_features: {
      schemaVersion: 4,
      desktop: {
        version: 1,
        available: true,
        protocol: 'rfb',
        transport: 'websocket',
        clipboard: 'text',
      },
    },
    ...overrides,
  }
}

describe('DeviceDesktopPage', () => {
  beforeEach(() => {
    startDeviceVncMock.mockReset()
    revokeDeviceVncMock.mockReset()
    executeCommandMock.mockReset()
    revokeDeviceVncMock.mockResolvedValue(undefined)
    workbenchState.devices = [desktopDevice()]
    runtimeState.electron = false
  })

  test('stores only the device id in the route', () => {
    expect(deviceDesktopRoute('device-1')).toBe('/device-desktop?deviceId=device-1')
    expect(isDeviceDesktopInternalPageUrl('/device-desktop?deviceId=device-1')).toBe(true)
  })

  test('isolates production Electron rendering in a dedicated Chromium webview', () => {
    runtimeState.electron = true

    render(<DeviceDesktopPage search="?deviceId=device-1" />)

    const host = screen.getByTestId('device-desktop-isolated-surface')
    const webview = host.querySelector('webview')
    expect(webview).toHaveAttribute('data-wework-vnc-surface', 'true')
    expect(webview?.getAttribute('partition')).toMatch(/^wework-vnc-surface-route:/)
    expect(webview).toHaveAttribute(
      'src',
      'http://localhost:3000/device-desktop?deviceId=device-1&vncSurface=isolated'
    )
    expect(startDeviceVncMock).not.toHaveBeenCalled()
  })

  test('starts the session inside the isolated Electron child route', async () => {
    runtimeState.electron = true
    startDeviceVncMock.mockResolvedValue({
      session_id: 'vnc-session-child',
      device_id: 'device-1',
      type: 'vnc',
      path: '/',
      url: 'wss://cloud.example.com/vnc-proxy/sessions/vnc-session-child?ticket=single-use',
      transport: 'websocket',
    })

    render(<DeviceDesktopPage search="?deviceId=device-1&vncSurface=isolated" />)

    await waitFor(() => expect(startDeviceVncMock).toHaveBeenCalledWith('device-1'))
    expect(await screen.findByTestId('mock-vnc-viewer')).toHaveTextContent('vnc-session-child')
  })

  test('starts the isolated session before the child workbench device list is synchronized', async () => {
    runtimeState.electron = true
    workbenchState.devices = []
    startDeviceVncMock.mockResolvedValue({
      session_id: 'vnc-session-without-device-state',
      device_id: 'device-1',
      type: 'vnc',
      path: '/',
      url: 'wss://cloud.example.com/vnc-proxy/sessions/vnc-session-without-device-state?ticket=single-use',
      transport: 'websocket',
    })

    render(<DeviceDesktopPage search="?deviceId=device-1&vncSurface=isolated" />)

    await waitFor(() => expect(startDeviceVncMock).toHaveBeenCalledWith('device-1'))
    expect(await screen.findByTestId('mock-vnc-viewer')).toHaveTextContent(
      'vnc-session-without-device-state'
    )
  })

  test('rejects a cloud device without an advertised desktop feature', async () => {
    workbenchState.devices = [
      desktopDevice({ device_type: 'cloud', runtime_features: { schemaVersion: 4 } }),
    ]

    render(<DeviceDesktopPage search="?deviceId=device-1" />)

    expect(await screen.findByTestId('device-desktop-status')).toHaveTextContent(
      'workbench.device_desktop_unavailable'
    )
    expect(startDeviceVncMock).not.toHaveBeenCalled()
  })

  test('starts a cloud VNC websocket session and renders the generic viewer', async () => {
    startDeviceVncMock.mockResolvedValue({
      session_id: 'vnc-session-1',
      device_id: 'device-1',
      type: 'vnc',
      path: '/',
      url: 'wss://cloud.example.com/vnc-proxy/sessions/vnc-session-1?ticket=single-use',
      transport: 'websocket',
    })

    render(<DeviceDesktopPage search="?deviceId=device-1" />)

    await waitFor(() => expect(startDeviceVncMock).toHaveBeenCalledWith('device-1'))
    expect(await screen.findByTestId('mock-vnc-viewer')).toHaveTextContent(
      'wss://cloud.example.com/vnc-proxy/sessions/vnc-session-1?ticket=single-use'
    )
    expect(screen.getByTestId('mock-vnc-viewer')).toHaveAttribute('data-clipboard-bridge', 'true')
  })

  test('uses the cloud route clipboard bridge from a merged local device record', async () => {
    workbenchState.devices = [
      desktopDevice({
        device_id: 'local-device',
        device_type: 'local',
        runtime_routes: [
          {
            kind: 'local-ipc',
            device_id: 'local-device',
            runtime_device_id: 'local-device',
            device_type: 'local',
            status: 'online',
          },
          {
            kind: 'cloud-relay',
            device_id: 'cloud-device',
            runtime_device_id: 'cloud-device',
            device_type: 'cloud',
            status: 'online',
          },
        ],
      }),
    ]
    startDeviceVncMock.mockResolvedValue({
      session_id: 'vnc-merged-cloud',
      device_id: 'cloud-device',
      type: 'vnc',
      path: '',
      url: 'wss://cloud.example.com/vnc-proxy/sessions/vnc-merged-cloud?ticket=single-use',
      transport: 'websocket',
    })

    render(<DeviceDesktopPage search="?deviceId=cloud-device" />)

    await waitFor(() => expect(startDeviceVncMock).toHaveBeenCalledWith('cloud-device'))
    expect(await screen.findByTestId('mock-vnc-viewer')).toHaveAttribute(
      'data-clipboard-bridge',
      'true'
    )
  })

  test('rejects legacy VNC URLs that expose a bearer token', async () => {
    startDeviceVncMock.mockResolvedValue({
      session_id: 'vnc-session-legacy',
      device_id: 'device-1',
      type: 'vnc',
      path: '',
      url: 'wss://cloud.example.com/vnc-proxy/device-1?token=long-lived-token',
      transport: 'websocket',
    })

    render(<DeviceDesktopPage search="?deviceId=device-1" />)

    expect(await screen.findByTestId('device-desktop-status')).toHaveTextContent(
      'workbench.device_desktop_session_failed'
    )
    expect(screen.queryByTestId('mock-vnc-viewer')).not.toBeInTheDocument()
    expect(revokeDeviceVncMock).toHaveBeenCalledWith('vnc-session-legacy')
  })

  test('revokes a session that resolves after the page unmounts', async () => {
    let resolveSession!: (value: {
      session_id: string
      device_id: string
      type: 'vnc'
      path: string
      url: string
      transport: 'websocket'
    }) => void
    startDeviceVncMock.mockReturnValue(
      new Promise(resolve => {
        resolveSession = resolve
      })
    )
    const { unmount } = render(<DeviceDesktopPage search="?deviceId=device-1" />)
    await waitFor(() => expect(startDeviceVncMock).toHaveBeenCalledWith('device-1'))

    unmount()
    resolveSession({
      session_id: 'vnc-session-late',
      device_id: 'device-1',
      type: 'vnc',
      path: '',
      url: 'wss://cloud.example.com/vnc-proxy/sessions/vnc-session-late?ticket=single-use',
      transport: 'websocket',
    })

    await waitFor(() => expect(revokeDeviceVncMock).toHaveBeenCalledWith('vnc-session-late'))
  })

  test.each(['remote', 'local'] as const)(
    'rejects a %s device even when it advertises desktop support',
    async deviceType => {
      workbenchState.devices = [desktopDevice({ device_type: deviceType })]

      render(<DeviceDesktopPage search="?deviceId=device-1" />)

      expect(await screen.findByTestId('device-desktop-status')).toHaveTextContent(
        'workbench.device_desktop_unavailable'
      )
      expect(startDeviceVncMock).not.toHaveBeenCalled()
      expect(screen.queryByTestId('device-desktop-isolated-surface')).not.toBeInTheDocument()
    }
  )
})
