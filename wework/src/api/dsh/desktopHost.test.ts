import { afterEach, beforeEach, expect, test, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  window.sessionStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  delete window.weworkElectronHost
})

test('E2E can delay only delivery of a completed real host response', async () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const gates = await import('@/e2e/runtime-transport-gates')
  gates.armRuntimeTransportGate({
    id: 'handoff',
    kind: 'response',
    name: 'smartApps.storeAdditionalProxyTokens',
    where: [{ path: 'params.installationId', equals: 'app-1' }],
  })
  const result = { stored: true }
  const invoke = vi.fn().mockResolvedValue({ ok: true, result })
  window.weworkElectronHost = { describe: vi.fn(), invoke }
  const { invokeDesktopHost } = await import('./desktopHost')
  let delivered = false
  const pending = invokeDesktopHost('smartApps.storeAdditionalProxyTokens', {
    installationId: 'app-1',
    tokens: ['test-token'],
  }).then(value => {
    delivered = true
    return value
  })
  try {
    await vi.waitFor(() => expect(gates.readRuntimeTransportGate('handoff')).not.toBeNull())
    expect(invoke).toHaveBeenCalledExactlyOnceWith('smartApps.storeAdditionalProxyTokens', {
      installationId: 'app-1',
      tokens: ['test-token'],
    })
    expect(delivered).toBe(false)
    gates.releaseRuntimeTransportGate('handoff')
    expect(await pending).toBe(result)
  } finally {
    gates.resetRuntimeTransportGates()
    await pending
  }
})

test('production host responses cannot be held by an E2E gate', async () => {
  vi.stubEnv('VITE_WEWORK_E2E', 'true')
  const gates = await import('@/e2e/runtime-transport-gates')
  gates.armRuntimeTransportGate({ id: 'production', kind: 'response', name: 'smartApps.start' })
  vi.stubEnv('MODE', 'production')
  vi.stubEnv('VITE_WEWORK_E2E', 'false')
  window.weworkElectronHost = {
    describe: vi.fn(),
    invoke: vi.fn().mockResolvedValue({ ok: true, result: 'running' }),
  }
  const { invokeDesktopHost } = await import('./desktopHost')
  try {
    await expect(invokeDesktopHost('smartApps.start')).resolves.toBe('running')
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    expect(gates.readRuntimeTransportGate('production')).toBeNull()
  } finally {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    gates.resetRuntimeTransportGates()
  }
})

test('missing desktop IPC fails closed without falling back to HTTP', async () => {
  delete window.weworkElectronHost
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  const { invokeDesktopHost } = await import('./desktopHost')
  await expect(invokeDesktopHost('secureStorage.get', { key: 'plugin.valid-key' })).rejects.toThrow(
    /IPC/
  )
  expect(request).not.toHaveBeenCalled()
})

test('preserves structured capability errors through the preload bridge', async () => {
  window.weworkElectronHost = {
    describe: vi.fn(),
    invoke: vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'capability_denied', message: 'Denied' } }),
  }
  const { invokeDesktopHost } = await import('./desktopHost')
  await expect(
    invokeDesktopHost('secureStorage.get', { key: 'wework-cloud.identity' })
  ).rejects.toMatchObject({ code: 'capability_denied' })
})

test('shares one bounded poll loop, advances the cursor and replays the latest event', async () => {
  vi.useFakeTimers()
  let reply!: (value: unknown) => void
  const invoke = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          reply = resolve
        })
    )
    .mockImplementation(() => new Promise(() => {}))
  window.weworkElectronHost = { invoke, describe: vi.fn() }
  const { subscribeDesktopHostEvents } = await import('./desktopHost')
  const first = vi.fn()
  const second = vi.fn()
  const stopFirst = subscribeDesktopHostEvents(first)
  const stopSecond = subscribeDesktopHostEvents(second)
  reply({
    ok: true,
    result: {
      events: [{ sequence: 1, type: 'tray.action', payload: { type: 'open-settings' } }],
      latestSequence: 1,
      historyLost: false,
    },
  })
  await vi.waitFor(() => expect(first).toHaveBeenCalledOnce())
  expect(second).toHaveBeenCalledOnce()
  expect(invoke).toHaveBeenCalledExactlyOnceWith('desktop.events', { after: 0 })
  await vi.advanceTimersByTimeAsync(500)
  expect(invoke).toHaveBeenLastCalledWith('desktop.events', { after: 1 })
  expect(window.sessionStorage.getItem('wework.desktopHostEventCursor')).toBe('1')
  const replay = vi.fn()
  const stopReplay = subscribeDesktopHostEvents(replay, {
    replay: event => event.type === 'tray.action',
  })
  expect(replay).toHaveBeenCalledWith({
    sequence: 1,
    type: 'tray.action',
    payload: { type: 'open-settings' },
  })
  stopFirst()
  stopSecond()
  stopReplay()
})

test('keeps only the latest browser page state in each batch', async () => {
  vi.useFakeTimers()
  const event = (sequence: number) => ({
    sequence,
    type: 'browser.event',
    payload: {
      type: 'page-state',
      payload: { label: 'workspace-browser', url: `https://page-${sequence}.example` },
    },
  })
  window.weworkElectronHost = {
    describe: vi.fn(),
    invoke: vi.fn().mockResolvedValue({
      ok: true,
      result: {
        events: [event(1), { sequence: 2, type: 'tray.action', payload: {} }, event(3)],
        latestSequence: 3,
        historyLost: false,
      },
    }),
  }
  const { subscribeDesktopHostEvents } = await import('./desktopHost')
  const handler = vi.fn()
  const stop = subscribeDesktopHostEvents(handler)
  await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
  expect(handler.mock.calls.map(([event]) => event.sequence)).toEqual([2, 3])
  expect(window.sessionStorage.getItem('wework.desktopHostEventCursor')).toBe('3')
  stop()
})
