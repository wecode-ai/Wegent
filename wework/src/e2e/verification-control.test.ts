import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { executeVerificationControlCommand } from './verification-control'
import { loadDesktopE2ERuntimeConfig, setDesktopE2ECloudSessionToken } from './runtime-config'

const { request, applyConnection } = vi.hoisted(() => ({
  request: vi.fn(),
  applyConnection: vi.fn(),
}))

vi.mock('@/desktop/localExecutor', () => ({ requestLocalExecutor: request }))
vi.mock('@/features/cloud-connection/localExecutorCloudConnection', () => ({
  applyLocalExecutorCloudConnection: applyConnection,
}))
vi.mock('@/lib/local-terminal', () => ({ getLocalTerminalSnapshot: vi.fn() }))
vi.mock('@/api/local/localConnectorAuth', () => ({
  localConnectorAuthHealth: vi.fn(),
  localConnectorAuthLogout: vi.fn(),
  localConnectorAuthStart: vi.fn(),
  localConnectorAuthPoll: vi.fn(),
}))

const disconnect = () =>
  executeVerificationControlCommand(
    { id: 'disconnect-native-cloud', action: 'disconnectLocalExecutorCloud', selector: 'body' },
    { elementEnabled: () => true }
  )

beforeEach(async () => {
  request.mockReset()
  applyConnection.mockReset().mockResolvedValue({ connected: true })
  window.sessionStorage.clear()
  window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
    controlUrl: 'http://127.0.0.1:43111',
    cloudBackendUrl: 'https://cloud.example',
    cloudToken: 'owner-token',
  }
  window.localStorage.setItem(
    'wework.cloudConnection',
    JSON.stringify({
      backendUrl: 'https://cloud.example',
      apiBaseUrl: 'https://cloud.example/api',
      socketBaseUrl: 'https://socket.example',
      socketPath: '/socket.io',
      token: 'stale-stored-token',
      user: { id: 1, user_name: 'owner' },
      connectedAt: new Date().toISOString(),
    })
  )
  await loadDesktopE2ERuntimeConfig()
})

afterEach(async () => {
  window.sessionStorage.clear()
  window.localStorage.removeItem('wework.cloudConnection')
  delete window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
  await loadDesktopE2ERuntimeConfig()
})

const reconnect = () =>
  executeVerificationControlCommand(
    { id: 'reconnect-native-cloud', action: 'reconnectLocalExecutorCloud', selector: 'body' },
    { elementEnabled: () => true }
  )

describe('real Native cloud reconnect verification command', () => {
  test('reuses the production connection flow with the selected session and returns only actual status', async () => {
    setDesktopE2ECloudSessionToken('recipient-token')
    request.mockResolvedValue({
      configured: true,
      connected: false,
      auth_token: 'must-not-be-returned',
    })

    expect(await reconnect()).toEqual({
      handled: true,
      value: '{"configured":true,"connected":false}',
    })
    expect(applyConnection).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        apiBaseUrl: 'https://cloud.example/api',
        backendUrl: 'https://cloud.example',
        socketBaseUrl: 'https://socket.example',
        isConnected: true,
        token: 'recipient-token',
      })
    )
    expect(request.mock.calls).toEqual([['executor.backend.status']])
  })

  test('propagates connection failures without reporting an invented connected state', async () => {
    applyConnection.mockRejectedValue(new Error('Runtime token issuing failed'))
    await expect(reconnect()).rejects.toThrow('Runtime token issuing failed')
    expect(request).not.toHaveBeenCalled()
  })

  test.each([{ controlUrl: undefined }, { disabled: true }, { cloudToken: undefined }])(
    'rejects an unavailable E2E account before reconnecting: %o',
    async patch => {
      Object.assign(window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__!, patch)
      await expect(reconnect()).rejects.toThrow('requires an active desktop E2E account')
      expect(applyConnection).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    }
  )

  test('rejects a changed backend profile instead of mixing its credentials and destination', async () => {
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__!.cloudBackendUrl = 'https://other.example'
    await expect(reconnect()).rejects.toThrow('Cloud reconnection profile changed')
    expect(applyConnection).not.toHaveBeenCalled()
  })
})

describe('real Native cloud disconnect verification command', () => {
  test('removes the Native profile and reads the resulting connection state without credentials', async () => {
    request.mockResolvedValueOnce({ changed: true }).mockResolvedValueOnce({
      configured: false,
      connected: false,
      auth_token: 'must-not-be-returned',
      backend_url: 'https://private.example',
    })

    const result = await disconnect()

    expect(request.mock.calls).toEqual([
      ['executor.backend.configure', {}],
      ['executor.backend.status'],
    ])
    expect(result).toEqual({
      handled: true,
      value: '{"configured":false,"connected":false}',
    })
  })

  test('propagates a failed Native disconnect instead of returning an invented offline status', async () => {
    request.mockRejectedValueOnce(new Error('Native connection command failed'))

    await expect(disconnect()).rejects.toThrow('Native connection command failed')

    expect(request).toHaveBeenCalledTimes(1)
  })

  test('returns the actual Native status so a failed disconnect remains visible to E2E', async () => {
    request.mockResolvedValueOnce({ changed: false }).mockResolvedValueOnce({
      configured: true,
      connected: true,
    })

    expect(await disconnect()).toEqual({
      handled: true,
      value: '{"configured":true,"connected":true}',
    })
  })
})
