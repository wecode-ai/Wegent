import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import type { DeviceSurfaceLaunchAction } from '@/extensions/device-surface-contract'
import { openCloudDesktop } from './openCloudDesktop'
import { WorkspaceDesktopAction } from './WorkspaceDesktopAction'

vi.mock('./openCloudDesktop', () => ({ openCloudDesktop: vi.fn() }))

function connection(
  overrides: Partial<CloudConnectionContextValue> = {}
): CloudConnectionContextValue {
  return {
    apiBaseUrl: 'https://cloud.example.com/api',
    backendUrl: 'https://cloud.example.com',
    connectedAt: '2026-07-20T00:00:00.000Z',
    connectWithAuthorization: vi.fn(),
    disconnect: vi.fn(),
    error: null,
    isConnected: true,
    refreshUser: vi.fn(),
    serviceKey: 'connected:1',
    socketBaseUrl: 'https://cloud.example.com',
    socketPath: '/socket.io',
    status: 'connected',
    token: 'cloud-token',
    tokenExpiresAt: null,
    user: { email: 'cloud@example.com', id: 1, user_name: 'cloud-user' },
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function renderAction({
  cloudConnection = connection(),
  contextKey = 'project-a',
  onBusyChange = vi.fn(),
  onErrorChange = vi.fn(),
  onLaunchActionChange = vi.fn(),
  onOpened = vi.fn(),
}: {
  cloudConnection?: CloudConnectionContextValue
  contextKey?: string
  onBusyChange?: (busy: boolean) => void
  onErrorChange?: (message: string | null) => void
  onLaunchActionChange?: (action: DeviceSurfaceLaunchAction | null) => void
  onOpened?: () => void
} = {}) {
  return {
    onBusyChange,
    onErrorChange,
    onLaunchActionChange,
    onOpened,
    ...render(
      <CloudConnectionContext.Provider value={cloudConnection}>
        <WorkspaceDesktopAction
          contextKey={contextKey}
          deviceId="device-1"
          disabled={false}
          onBusyChange={onBusyChange}
          onErrorChange={onErrorChange}
          onLaunchActionChange={onLaunchActionChange}
          onOpened={onOpened}
        />
      </CloudConnectionContext.Provider>
    ),
  }
}

describe('WorkspaceDesktopAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(openCloudDesktop).mockResolvedValue(true)
  })

  test('opens the desktop and reports busy state to the shared host', async () => {
    const { onBusyChange, onErrorChange, onOpened } = renderAction()

    await userEvent.click(screen.getByTestId('workspace-desktop-card'))

    await waitFor(() => expect(onOpened).toHaveBeenCalledOnce())
    expect(onErrorChange).toHaveBeenCalledWith(null)
    expect(onBusyChange).toHaveBeenNthCalledWith(1, true)
    expect(onBusyChange).toHaveBeenLastCalledWith(false)
    expect(openCloudDesktop).toHaveBeenCalledWith({
      connection: expect.objectContaining({ serviceKey: 'connected:1', token: 'cloud-token' }),
      deviceId: 'device-1',
      isCurrent: expect.any(Function),
      target: 'embedded',
    })
  })

  test('stays retryable after opening fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(openCloudDesktop)
      .mockRejectedValueOnce(new Error('desktop unavailable'))
      .mockResolvedValueOnce(true)
    const { onErrorChange, onOpened } = renderAction()

    try {
      await userEvent.click(screen.getByTestId('workspace-desktop-card'))
      await waitFor(() => expect(onErrorChange).toHaveBeenCalledWith('启动失败'))
      expect(screen.getByTestId('workspace-desktop-card')).not.toBeDisabled()

      await userEvent.click(screen.getByTestId('workspace-desktop-card'))

      await waitFor(() => expect(onOpened).toHaveBeenCalledOnce())
      expect(openCloudDesktop).toHaveBeenCalledTimes(2)
    } finally {
      consoleError.mockRestore()
    }
  })

  test('exposes a launch action that can keep the shared host open', async () => {
    const onLaunchActionChange = vi.fn<(action: DeviceSurfaceLaunchAction | null) => void>()
    const onOpened = vi.fn()
    renderAction({ onLaunchActionChange, onOpened })

    await waitFor(() => expect(onLaunchActionChange).toHaveBeenCalledWith(expect.any(Function)))
    const launchAction = onLaunchActionChange.mock.calls.find(([action]) => action)?.[0]

    await act(async () => launchAction?.({ notifyOpened: false }))

    expect(openCloudDesktop).toHaveBeenCalledOnce()
    expect(onOpened).not.toHaveBeenCalled()
  })

  test('ignores pending completion after the project context changes', async () => {
    const pending = deferred<boolean>()
    vi.mocked(openCloudDesktop).mockReturnValueOnce(pending.promise)
    const onBusyChange = vi.fn()
    const onErrorChange = vi.fn()
    const onOpened = vi.fn()
    const cloudConnection = connection()
    const view = renderAction({ cloudConnection, onBusyChange, onErrorChange, onOpened })

    await userEvent.click(screen.getByTestId('workspace-desktop-card'))
    view.rerender(
      <CloudConnectionContext.Provider value={cloudConnection}>
        <WorkspaceDesktopAction
          contextKey="project-b"
          deviceId="device-1"
          disabled={false}
          onBusyChange={onBusyChange}
          onErrorChange={onErrorChange}
          onOpened={onOpened}
        />
      </CloudConnectionContext.Provider>
    )
    await act(async () => pending.resolve(true))

    expect(onOpened).not.toHaveBeenCalled()
    expect(onBusyChange).not.toHaveBeenLastCalledWith(false)
  })
})
