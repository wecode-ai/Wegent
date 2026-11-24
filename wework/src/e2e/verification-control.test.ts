import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { executeVerificationControlCommand } from './verification-control'
import { loadDesktopE2ERuntimeConfig, setDesktopE2ECloudSessionToken } from './runtime-config'
import * as desktopHost from '@/api/dsh/desktopHost'
import * as embeddedBrowser from '@/lib/embedded-browser'
import { createBrowserAgentCursorPort } from '@/components/layout/workspace-panels/browserAgentCursorPort'

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

test('cursor commands retain the production port DOM after a late finish request', async () => {
  vi.useFakeTimers()
  let receive!: (event: desktopHost.DesktopHostEvent) => void
  const stopEvents = vi.fn()
  const subscribe = vi
    .spyOn(desktopHost, 'subscribeDesktopHostEvents')
    .mockImplementation(listener => {
      receive = listener
      return stopEvents
    })
  const acknowledge = vi
    .spyOn(embeddedBrowser, 'notifyEmbeddedBrowserAgentCursorArrived')
    .mockResolvedValue(undefined)
  const label = 'cursor-protocol-browser'
  const host = document.createElement('div')
  host.dataset.weworkBrowserWebview = label
  const cursor = document.createElement('div')
  cursor.dataset.testid = 'workspace-browser-agent-cursor'
  cursor.append(document.createElement('div'))
  host.append(cursor)
  const tab = document.createElement('button')
  tab.dataset.testid = 'right-workspace-browser-tab-protocol'
  tab.setAttribute('aria-selected', 'true')
  const icon = document.createElement('span')
  icon.dataset.testid = 'protocol-agent-icon'
  document.body.append(host, tab)
  const port = createBrowserAgentCursorPort()
  const ownership = Symbol('real-cursor-port')
  const execute = (action: string, value: string, id = 'cursor-protocol') =>
    executeVerificationControlCommand(
      { id, action, value, selector: 'body', timeoutMs: 10_000 },
      { elementEnabled: () => true }
    )
  const emit = (type: string, payload: Record<string, unknown>) =>
    receive({
      sequence: 1,
      type: 'browser.event',
      payload: { type, payload: { label, createdAtUnixMs: Date.now(), ...payload } },
    })
  let unbind = () => {}
  try {
    await expect(execute('startBrowserCursorObservation', label)).resolves.toEqual({
      handled: true,
      value: 'cursor-protocol',
    })
    emit('agent-state', { status: 'running', action: 'click' })
    const movement = {
      label,
      visible: true,
      x: 120,
      y: 80,
      animateMovement: true,
      moveSequence: 3,
      createdAtUnixMs: Date.now(),
    }
    emit('agent-cursor', movement)
    unbind = port.bind(cursor, movement, label, 1, () => ownership)!
    tab.append(icon)
    await vi.advanceTimersByTimeAsync(180)
    emit('agent-state', { status: 'idle', action: 'click' })
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(3_000)
    const hidden = {
      ...movement,
      visible: false,
      animateMovement: false,
      createdAtUnixMs: Date.now(),
    }
    emit('agent-cursor', hidden)
    unbind()
    unbind = port.bind(cursor, hidden, label, 1, () => ownership)!
    icon.remove()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(500)
    const result = await execute('finishBrowserCursorObservation', 'cursor-protocol')
    expect(result.handled).toBe(true)
    if (!result.handled) throw new Error('Cursor observation command was not handled')
    const evidence = JSON.parse(result.value)
    expect(cursor).toHaveAttribute('data-visible', 'false')
    expect(evidence.afterClick).toMatchObject({
      cursorPresent: true,
      visible: 'true',
      elapsedMs: 1_000,
      tabIconCount: 1,
    })
    expect(evidence.firstVisible.style).toContain('translate3d(117px, 77px, 0)')
    expect(evidence.hidden).toMatchObject({
      cursorPresent: true,
      visible: 'false',
      tabIconCount: 0,
    })
    expect(evidence.cursorHiddenAtUnixMs - evidence.clickFinishedAtUnixMs).toBe(4_000)
    expect(stopEvents).toHaveBeenCalledOnce()
  } finally {
    await execute('cancelBrowserCursorObservation', 'cursor-protocol').catch(() => {})
    unbind()
    host.remove()
    tab.remove()
    subscribe.mockRestore()
    acknowledge.mockRestore()
    vi.useRealTimers()
  }
})
