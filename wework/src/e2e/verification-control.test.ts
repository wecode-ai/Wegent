import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { executeVerificationControlCommand } from './verification-control'
import { loadDesktopE2ERuntimeConfig, setDesktopE2ECloudSessionToken } from './runtime-config'

const { request, applyConnection, prepareCatalog } = vi.hoisted(() => ({
  request: vi.fn(),
  prepareCatalog: vi.fn(),
  applyConnection: vi.fn(),
}))

vi.mock('./local-model-catalog-readiness', () => ({ ensureLocalModelCatalogReady: prepareCatalog }))

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

test('error collection verification requires an explicit native checkpoint acknowledgment', async () => {
  const target = window as Window & { weworkElectronVerification?: unknown }
  const original = target.weworkElectronVerification
  const checkpoint = {
    enabled: true,
    instanceId: 'host',
    sequence: 4,
    failedWrites: 0,
    byteLength: 500,
  }
  const errorCollectionCheckpoint = vi.fn().mockResolvedValue(checkpoint)
  const command = {
    id: 'collector-checkpoint',
    action: 'getErrorCollectionCheckpoint',
    selector: 'body',
  }
  try {
    target.weworkElectronVerification = { errorCollectionCheckpoint }
    await expect(
      executeVerificationControlCommand(command, { elementEnabled: () => true })
    ).resolves.toEqual({ handled: true, value: JSON.stringify(checkpoint) })
    expect(errorCollectionCheckpoint).toHaveBeenCalledOnce()
    delete target.weworkElectronVerification
    await expect(
      executeVerificationControlCommand(command, { elementEnabled: () => true })
    ).rejects.toThrow('verification bridge is unavailable')
  } finally {
    if (original === undefined) delete target.weworkElectronVerification
    else target.weworkElectronVerification = original
  }
})

test('UI refresh commands measure transient DOM updates through the verification channel', async () => {
  const invoke = async (action: string, value?: unknown) => {
    const result = await executeVerificationControlCommand(
      {
        id: action,
        action,
        selector: 'body',
        value: JSON.stringify(value),
      },
      { elementEnabled: () => true }
    )
    if (!result.handled) throw new Error('Verification command was not handled')
    return result.value
  }
  const token = JSON.parse(
    await invoke('startUiRefreshCapture', {
      regions: [{ name: 'probe', selector: '[data-testid="e2e-ui-refresh-probe"]' }],
      renderIds: [],
    })
  )
  await invoke('probeUiRefreshCapture')
  const result = JSON.parse(await invoke('stopUiRefreshCapture', token))
  expect(result.regions.probe).toMatchObject({ observed: true, rootRemovals: 1, finalMatches: 0 })
  expect(result.regions.probe.mutationBatches).toBeGreaterThanOrEqual(1)
})

beforeEach(async () => {
  request.mockReset()
  prepareCatalog.mockReset().mockResolvedValue(undefined)
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

test('background catalog preparation leaves control available during an injected restart hold', async () => {
  let reject!: (error: Error) => void
  prepareCatalog.mockImplementation(
    () =>
      new Promise((_, rejectPromise) => {
        reject = rejectPromise
      })
  )
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    await expect(
      executeVerificationControlCommand(
        { id: 'prepare', action: 'startLocalModelCatalogPreparation', selector: 'body' },
        { elementEnabled: () => true }
      )
    ).resolves.toEqual({ handled: true, value: '' })
    expect(prepareCatalog).toHaveBeenCalledOnce()
    const interrupted = new Error('injected restart interruption')
    reject(interrupted)
    await vi.waitFor(() =>
      expect(warning).toHaveBeenCalledWith(
        '[desktop-e2e] Background catalog preparation failed',
        interrupted
      )
    )
  } finally {
    warning.mockRestore()
  }
})
