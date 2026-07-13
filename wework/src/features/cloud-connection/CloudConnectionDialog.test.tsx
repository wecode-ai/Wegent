import { render, screen } from '@testing-library/react'
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
})
