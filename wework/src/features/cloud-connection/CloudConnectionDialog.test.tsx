import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
  type CloudConnectionContextValue,
} from './CloudConnectionContext'
import { CloudConnectionDialog } from './CloudConnectionDialog'
import i18n from '@/i18n'
import { useState } from 'react'

function cloudConnection(backendUrl?: string): CloudConnectionContextValue {
  return {
    ...DISCONNECTED_STATE,
    backendUrl,
    isConnected: false,
    serviceKey: 'disconnected',
    connectWithAuthorization: vi.fn(),
    refreshUser: vi.fn(),
    disconnect: vi.fn(),
  }
}

function renderDialog(connection: CloudConnectionContextValue, onClose = vi.fn()) {
  render(
    <CloudConnectionContext.Provider value={connection}>
      <CloudConnectionDialog
        open
        onlineCloudDeviceCount={0}
        onClose={onClose}
        onOpenSettings={vi.fn()}
      />
    </CloudConnectionContext.Provider>
  )
}

describe('CloudConnectionDialog', () => {
  it('keeps explicit disconnect available to repair failed native sign-in', async () => {
    const connection = {
      ...cloudConnection('https://saved.example.com'),
      status: 'error' as const,
      error: 'Cloud credentials are unreadable',
    }
    renderDialog(connection)
    expect(screen.getByTestId('cloud-connection-error')).toBeInTheDocument()
    expect(connection.disconnect).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('cloud-disconnect-button'))
    expect(connection.disconnect).toHaveBeenCalledOnce()
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await i18n.changeLanguage('zh-CN')
  })

  it('names the dialog, contains keyboard focus and restores its trigger and background', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <CloudConnectionContext.Provider value={cloudConnection('https://saved.example.com')}>
          <button data-testid="open-issue-login" onClick={() => setOpen(true)}>
            New issue
          </button>
          <CloudConnectionDialog
            open={open}
            onlineCloudDeviceCount={0}
            intent="independent-issue"
            onClose={() => setOpen(false)}
            onOpenSettings={vi.fn()}
          />
        </CloudConnectionContext.Provider>
      )
    }
    const { container } = render(<Harness />)
    const trigger = screen.getByTestId('open-issue-login')
    await userEvent.click(trigger)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAccessibleName()
    expect(screen.getByTestId('cloud-backend-url-input')).toHaveFocus()
    expect(container).toHaveAttribute('inert')
    screen.getByTestId('cloud-authorization-submit-button').focus()
    await userEvent.tab()
    expect(screen.getByTestId('cloud-connection-close-button')).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(screen.getByTestId('cloud-authorization-submit-button')).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(container).not.toHaveAttribute('inert')
    expect(trigger).toHaveFocus()
  })

  it('prefills the Backend URL from build-time config', () => {
    vi.stubEnv('VITE_WEGENT_BACKEND_URL', 'https://cloud.example.com')

    renderDialog(cloudConnection())

    expect(screen.getByTestId('cloud-backend-url-input')).toHaveValue('https://cloud.example.com')
  })

  it('explains the Issue intent and resumes it only after authorization completes', async () => {
    await i18n.changeLanguage('zh-CN')
    let finish!: () => void
    const connection = cloudConnection('https://saved.example.com')
    connection.connectWithAuthorization = vi.fn().mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    const onConnected = vi.fn()
    const onClose = vi.fn()
    render(
      <CloudConnectionContext.Provider value={connection}>
        <CloudConnectionDialog
          open
          onlineCloudDeviceCount={0}
          intent="independent-issue"
          onConnected={onConnected}
          onClose={onClose}
          onOpenSettings={vi.fn()}
        />
      </CloudConnectionContext.Provider>
    )
    expect(screen.getByTestId('cloud-connection-dialog')).toHaveTextContent(
      '独立事项保存在你的云端账号中'
    )
    await userEvent.click(screen.getByTestId('cloud-backend-url-input'))
    await userEvent.keyboard('{Enter}')
    expect(onConnected).not.toHaveBeenCalled()
    await act(async () => finish())
    expect(onConnected).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('prefers the current Backend URL over build-time config', () => {
    vi.stubEnv('VITE_WEGENT_BACKEND_URL', 'https://build.example.com')

    renderDialog(cloudConnection('https://saved.example.com'))

    expect(screen.getByTestId('cloud-backend-url-input')).toHaveValue('https://saved.example.com')
  })

  it('explains recovery, preserves the address and keeps raw errors in expandable details', async () => {
    await i18n.changeLanguage('en')
    renderDialog({
      ...cloudConnection('https://saved.example.com'),
      connectWithAuthorization: vi.fn().mockRejectedValue(new Error('Failed to fetch')),
    })
    await userEvent.click(screen.getByTestId('cloud-authorization-submit-button'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Check the service address and your network'
    )
    expect(screen.getByTestId('cloud-backend-url-input')).toHaveValue('https://saved.example.com')
    const details = screen.getByTestId('cloud-connection-error-details')
    expect(details).not.toHaveAttribute('open')
    await userEvent.click(screen.getByTestId('cloud-connection-error-details-toggle'))
    expect(details).toHaveAttribute('open')
    expect(details).toHaveTextContent('Failed to fetch')
  })

  it('starts cloud authorization when pressing Enter in the Backend URL input', async () => {
    const connectWithAuthorization = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()

    renderDialog(
      {
        ...cloudConnection('https://saved.example.com'),
        connectWithAuthorization,
      },
      onClose
    )

    await userEvent.click(screen.getByTestId('cloud-backend-url-input'))
    await userEvent.keyboard('{Enter}')

    expect(connectWithAuthorization).toHaveBeenCalledWith(
      'https://saved.example.com',
      expect.any(Function),
      ''
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the optional Socket URL in collapsed advanced settings', async () => {
    const connection = {
      ...cloudConnection('https://saved.example.com'),
      socketBaseUrlOverride: 'wss://socket.example.com',
    }
    renderDialog(connection)

    const toggle = screen.getByTestId('cloud-connection-advanced-toggle')
    expect(toggle.closest('details')).not.toHaveAttribute('open')

    await userEvent.click(toggle)

    expect(toggle.closest('details')).toHaveAttribute('open')
    expect(screen.getByTestId('cloud-socket-url-input')).toHaveValue('wss://socket.example.com')
  })

  it('localizes an expired cloud session error', () => {
    renderDialog({
      ...cloudConnection('https://saved.example.com'),
      status: 'expired',
      error: 'Cloud login has expired',
    })

    expect(screen.getByTestId('cloud-connection-error')).toHaveTextContent(
      '云端登录已过期，请重新登录。'
    )
    expect(screen.getByTestId('cloud-connection-error')).not.toHaveTextContent(
      'Cloud login has expired'
    )
  })

  it.each(['error', 'expired'] as const)(
    'allows disconnecting when the cloud connection status is %s',
    async status => {
      const disconnect = vi.fn()
      const onClose = vi.fn()

      renderDialog(
        {
          ...cloudConnection('https://saved.example.com'),
          status,
          error: 'Cloud connection failed',
          disconnect,
        },
        onClose
      )

      await userEvent.click(screen.getByTestId('cloud-disconnect-button'))

      expect(disconnect).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    }
  )

  it('does not show disconnect for a fresh disconnected state', () => {
    renderDialog(cloudConnection('https://saved.example.com'))

    expect(screen.queryByTestId('cloud-disconnect-button')).not.toBeInTheDocument()
  })
})
