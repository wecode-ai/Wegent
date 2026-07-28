import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
  type CloudConnectionContextValue,
} from './CloudConnectionContext'
import { CloudConnectionDialog } from './CloudConnectionDialog'

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

function renderDialog(connection: CloudConnectionContextValue) {
  render(
    <CloudConnectionContext.Provider value={connection}>
      <CloudConnectionDialog
        open
        onlineCloudDeviceCount={0}
        onClose={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    </CloudConnectionContext.Provider>
  )
}

describe('CloudConnectionDialog', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prefills the Backend URL from build-time config', () => {
    vi.stubEnv('VITE_WEGENT_BACKEND_URL', 'https://cloud.example.com')

    renderDialog(cloudConnection())

    expect(screen.getByTestId('cloud-backend-url-input')).toHaveValue('https://cloud.example.com')
  })

  it('prefers the current Backend URL over build-time config', () => {
    vi.stubEnv('VITE_WEGENT_BACKEND_URL', 'https://build.example.com')

    renderDialog(cloudConnection('https://saved.example.com'))

    expect(screen.getByTestId('cloud-backend-url-input')).toHaveValue('https://saved.example.com')
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
})
