import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import { openCloudDesktop } from './openCloudDesktop'
import { VncDesktopButton } from './VncDesktopButton'

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

function renderButton({
  cloudConnection = connection(),
  disabled = false,
  onOpened = vi.fn(),
}: {
  cloudConnection?: CloudConnectionContextValue
  disabled?: boolean
  onOpened?: () => void
} = {}) {
  return {
    onOpened,
    ...render(
      <CloudConnectionContext.Provider value={cloudConnection}>
        <VncDesktopButton deviceId="device-1" disabled={disabled} onOpened={onOpened} />
      </CloudConnectionContext.Provider>
    ),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('VncDesktopButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(openCloudDesktop).mockResolvedValue(true)
  })

  test('opens the desktop and preserves the public device action appearance', async () => {
    const { onOpened } = renderButton()

    const button = screen.getByTestId('connection-vnc-button-device-1')
    expect(button).toHaveClass('h-8')
    expect(button).toHaveTextContent('桌面')
    await userEvent.click(button)

    await waitFor(() => expect(onOpened).toHaveBeenCalledOnce())
    expect(openCloudDesktop).toHaveBeenCalledWith({
      connection: expect.objectContaining({ serviceKey: 'connected:1', token: 'cloud-token' }),
      deviceId: 'device-1',
      isCurrent: expect.any(Function),
      target: 'system',
    })
  })

  test.each(['VNC status failed', 'System browser is unavailable'])(
    'shows a recoverable error when opening fails: %s',
    async message => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      vi.mocked(openCloudDesktop).mockRejectedValueOnce(new Error(message))
      const { onOpened } = renderButton()

      try {
        await userEvent.click(screen.getByTestId('connection-vnc-button-device-1'))

        expect(await screen.findByTestId('connection-vnc-error-device-1')).toHaveTextContent(
          '无法使用系统默认浏览器打开云桌面，请重试'
        )
        expect(onOpened).not.toHaveBeenCalled()
      } finally {
        consoleError.mockRestore()
      }
    }
  )

  test('disables the action while loading and prevents duplicate requests', async () => {
    const pending = deferred<boolean>()
    vi.mocked(openCloudDesktop).mockReturnValueOnce(pending.promise)
    const { onOpened } = renderButton()
    const button = screen.getByTestId('connection-vnc-button-device-1')

    await userEvent.click(button)
    expect(button).toBeDisabled()
    await userEvent.click(button)
    expect(openCloudDesktop).toHaveBeenCalledOnce()

    await act(async () => pending.resolve(true))
    await waitFor(() => expect(onOpened).toHaveBeenCalledOnce())
  })

  test('discards a pending result after the cloud connection changes', async () => {
    const firstRequest = deferred<void>()
    vi.mocked(openCloudDesktop)
      .mockImplementationOnce(async options => {
        await firstRequest.promise
        return options.isCurrent()
      })
      .mockResolvedValueOnce(true)
    const onOpened = vi.fn()
    const firstConnection = connection()
    const nextConnection = connection({
      connectedAt: '2026-07-20T00:01:00.000Z',
      serviceKey: 'connected:2',
      token: 'next-token',
    })
    const view = renderButton({ cloudConnection: firstConnection, onOpened })

    await userEvent.click(screen.getByTestId('connection-vnc-button-device-1'))
    view.rerender(
      <CloudConnectionContext.Provider value={nextConnection}>
        <VncDesktopButton deviceId="device-1" disabled={false} onOpened={onOpened} />
      </CloudConnectionContext.Provider>
    )
    await waitFor(() =>
      expect(screen.getByTestId('connection-vnc-button-device-1')).not.toBeDisabled()
    )
    await userEvent.click(screen.getByTestId('connection-vnc-button-device-1'))
    await waitFor(() => expect(onOpened).toHaveBeenCalledOnce())

    await act(async () => firstRequest.resolve())
    await firstRequest.promise
    expect(onOpened).toHaveBeenCalledOnce()
    expect(openCloudDesktop).toHaveBeenCalledTimes(2)
  })

  test('keeps the action disabled for an offline device', async () => {
    renderButton({ disabled: true })

    const button = screen.getByTestId('connection-vnc-button-device-1')
    expect(button).toBeDisabled()
    await userEvent.click(button)
    expect(openCloudDesktop).not.toHaveBeenCalled()
  })

  test('shows an error without launching when the VNC socket URL is missing', async () => {
    renderButton({ cloudConnection: connection({ socketBaseUrl: undefined }) })

    await userEvent.click(screen.getByTestId('connection-vnc-button-device-1'))

    expect(await screen.findByTestId('connection-vnc-error-device-1')).toHaveTextContent(
      '无法使用系统默认浏览器打开云桌面，请重试'
    )
    expect(openCloudDesktop).not.toHaveBeenCalled()
  })

  test('clears an opening error after a successful retry', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(openCloudDesktop)
      .mockRejectedValueOnce(new Error('browser unavailable'))
      .mockResolvedValueOnce(true)
    const { onOpened } = renderButton()
    const button = screen.getByTestId('connection-vnc-button-device-1')

    try {
      await userEvent.click(button)
      expect(await screen.findByTestId('connection-vnc-error-device-1')).toBeInTheDocument()

      await userEvent.click(button)

      await waitFor(() => expect(onOpened).toHaveBeenCalledOnce())
      expect(screen.queryByTestId('connection-vnc-error-device-1')).not.toBeInTheDocument()
      expect(openCloudDesktop).toHaveBeenCalledTimes(2)
    } finally {
      consoleError.mockRestore()
    }
  })
})
