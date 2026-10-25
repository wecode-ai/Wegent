import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createHttpClient } from '@/api/http'
import { DshExecutorTransportError } from '@/api/dsh/executorTransport'
import { createPluginApi } from '@/api/plugins'
import { ensureLocalExecutorAvailable, requestLocalExecutor } from '@/desktop/localExecutor'
import i18n from '@/i18n'
import { createLocalDevicePluginApi, resolveLocalPluginDeviceRouteId } from './pluginDeviceApi'

vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorAvailable: vi.fn(),
  requestLocalExecutor: vi.fn(),
}))

const deviceId = 'electron-plugins'
const requestId = 'app-record-70'
const wireDevices = [
  { deviceId: requestId, state: 'installed', actualReleaseId: 1002 },
  { deviceId: 'other-device', state: 'failed', actualReleaseId: 1001 },
]
const installed = { metadata: { name: 'documents' }, status: { devices: wireDevices } }
const sync = {
  device_id: requestId,
  success: false,
  mode: 'replace',
  skills: [],
  mcps: [],
  plugins: [{ id: 101, status: 'failed', stage: 'checksum', error_code: 'CHECKSUM_MISMATCH' }],
  errors: [{ error: 'Checksum mismatch' }],
  synced: 0,
  failed: 1,
  skipped: 0,
  results: [
    { device_id: requestId, success: false, error: 'Checksum mismatch' },
    { device_id: 'other-device', success: true },
  ],
}

afterEach(() => vi.unstubAllGlobals())
beforeEach(() => {
  vi.mocked(ensureLocalExecutorAvailable).mockReset()
  vi.mocked(requestLocalExecutor).mockReset()
})

function cloudApi() {
  return createPluginApi(createHttpClient({ baseUrl: '/api', getToken: () => null }))
}

function apiWithResponse(response: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))))
  return createLocalDevicePluginApi(cloudApi(), async () => requestId)
}

describe('local plugin device API boundary', () => {
  test('maps route-addressed inventory status while preserving other devices', async () => {
    const api = apiWithResponse({ items: [installed] })

    const response = await api.listInstalledPlugins(deviceId)

    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed?device_id=app-record-70',
      expect.objectContaining({ method: 'GET' })
    )
    expect(response.items[0].status.devices).toEqual([
      { ...wireDevices[0], deviceId },
      wireDevices[1],
    ])
    expect(wireDevices[0].deviceId).toBe(requestId)
  })

  test('keeps unscoped account inventory unscoped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [installed] })))
    )
    const resolveRoute = vi.fn()
    const api = createLocalDevicePluginApi(cloudApi(), resolveRoute)

    const response = await api.listInstalledPlugins()

    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed',
      expect.objectContaining({ method: 'GET' })
    )
    expect(response.items[0].status.devices).toEqual(wireDevices)
    expect(resolveRoute).not.toHaveBeenCalled()
    expect(ensureLocalExecutorAvailable).not.toHaveBeenCalled()
  })

  test('maps the marketplace device state without changing catalog fields', async () => {
    const item = { id: 101, name: 'documents', currentDeviceInstallation: wireDevices[0] }
    const api = apiWithResponse({ items: [item] })

    const response = await api.listMarketplacePlugins({ q: 'documents', deviceId })

    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/marketplace?q=documents&device_id=app-record-70',
      expect.objectContaining({ method: 'GET' })
    )
    expect(response.items).toEqual([
      { ...item, currentDeviceInstallation: { ...wireDevices[0], deviceId } },
    ])
  })

  test.each(['marketplace', 'builtin'] as const)(
    'maps the %s install acknowledgement and preserves sync failure details',
    async source => {
      const api = apiWithResponse({ plugin: installed, sync })

      const response =
        source === 'marketplace'
          ? await api.installMarketplacePlugin(101, deviceId)
          : await api.ensureBuiltinPluginInstalled('documents', { deviceId })

      const expectedUrl =
        source === 'marketplace'
          ? '/api/plugins/marketplace/101/install?device_id=app-record-70'
          : '/api/plugins/builtin/documents/ensure-installed'
      expect(fetch).toHaveBeenCalledWith(
        expectedUrl,
        expect.objectContaining({
          method: 'POST',
          ...(source === 'builtin' ? { body: JSON.stringify({ device_id: requestId }) } : {}),
        })
      )
      expect(response.plugin.status.devices?.[0].deviceId).toBe(deviceId)
      expect(response.sync).toEqual({
        ...sync,
        device_id: deviceId,
        results: [{ ...sync.results[0], device_id: deviceId }, sync.results[1]],
      })
    }
  )

  test.each(['single', 'reconcile'] as const)(
    'maps only the current Runtime in a %s sync response',
    async operation => {
      const api = apiWithResponse({ deviceId: requestId, pendingCount: 1, sync })

      const response =
        operation === 'single'
          ? await api.syncInstalledPluginToDevice(101, deviceId)
          : await api.syncInstalledPluginsToDevice(deviceId, true)

      expect(fetch).toHaveBeenCalledWith(
        operation === 'single'
          ? '/api/plugins/installed/101/sync-device?device_id=app-record-70'
          : '/api/plugins/installed/sync-device?device_id=app-record-70&reconcile=true',
        expect.objectContaining({ method: 'POST' })
      )
      expect(response.deviceId).toBe(deviceId)
      expect(response.sync).toEqual({
        ...sync,
        device_id: deviceId,
        results: [{ ...sync.results[0], device_id: deviceId }, sync.results[1]],
      })
    }
  )

  test('maps a device status acknowledgement without changing the acknowledged plugin IDs', async () => {
    const api = apiWithResponse({
      deviceId: requestId,
      acknowledgedCount: 1,
      acknowledgedInstalledPluginIds: [101],
    })
    const reports = [{ installedPluginId: 101, releaseId: 1002, version: '1.1.0' }]

    const response = await api.reportInstalledPluginsOnDevice(deviceId, reports)

    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/report-device?device_id=app-record-70',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ plugins: reports }) })
    )
    expect(response).toEqual({
      deviceId,
      acknowledgedCount: 1,
      acknowledgedInstalledPluginIds: [101],
    })
  })

  test('resolves the fresh description route without changing stable identity', async () => {
    vi.mocked(requestLocalExecutor).mockResolvedValue({
      device_id: deviceId,
      device_route_id: ' app-record-71 ',
    })

    expect(
      await resolveLocalPluginDeviceRouteId(deviceId, {
        apiBaseUrl: 'https://backend.example/api',
        token: 'account-token',
      })
    ).toBe('app-record-71')
    expect(requestLocalExecutor).toHaveBeenCalledExactlyOnceWith('executor.plugins.device_route', {
      backend_url: 'https://backend.example',
      auth_token: 'account-token',
      device_id: deviceId,
    })
    expect(ensureLocalExecutorAvailable).not.toHaveBeenCalled()
  })

  test.each([
    { device_id: deviceId, device_route_id: undefined },
    { device_id: 'another-device', device_route_id: 'app-record-71' },
  ])('rejects an unregistered or replaced Runtime: %o', async status => {
    vi.mocked(requestLocalExecutor).mockResolvedValue(status)
    await expect(
      resolveLocalPluginDeviceRouteId(deviceId, {
        apiBaseUrl: 'https://backend.example/api',
        token: 'account-token',
      })
    ).rejects.toThrow()
  })

  test.each([
    { enabled: false },
    { componentStates: { review: false } },
    { updatePolicy: 'manual' as const },
  ])('saves account preferences without unavailable Runtime context: %o', async request => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(installed))))
    const resolveRoute = vi.fn().mockRejectedValue(new Error('Local IPC offline'))
    const api = createLocalDevicePluginApi(cloudApi(), resolveRoute)

    expect(await api.updateInstalledPlugin(101, request, deviceId)).toEqual(installed)

    expect(resolveRoute).toHaveBeenCalledExactlyOnceWith(deviceId)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/plugins/installed/101',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(request) })
    )
  })

  test.each([
    { enabled: false },
    { componentStates: { review: false } },
    { updatePolicy: 'manual' as const },
  ])('propagates HTTP account-save failures without Runtime context: %o', async request => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ detail: 'Write failed' }), { status: 503 })
        )
    )
    const api = createLocalDevicePluginApi(
      cloudApi(),
      vi.fn().mockRejectedValue(new Error('IPC offline'))
    )

    await expect(api.updateInstalledPlugin(101, request, deviceId)).rejects.toMatchObject({
      status: 503,
    })
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/101',
      expect.objectContaining({ method: 'PUT' })
    )
  })

  test('reads account inventory and removes account membership without requiring IPC', async () => {
    const resolveRoute = vi.fn().mockRejectedValue(new Error('IPC offline'))
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async (_url, options) =>
          options.method === 'DELETE'
            ? new Response(null, { status: 204 })
            : new Response(JSON.stringify({ items: [installed] }))
        )
    )
    const api = createLocalDevicePluginApi(cloudApi(), resolveRoute)

    await api.listInstalledPlugins(deviceId)
    await api.listMarketplacePlugins({ deviceId })
    resolveRoute.mockClear()
    await api.uninstallInstalledPlugin(101, deviceId)

    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed',
      expect.objectContaining({ method: 'GET' })
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/marketplace',
      expect.objectContaining({ method: 'GET' })
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/plugins/installed/101',
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(resolveRoute).not.toHaveBeenCalled()
  })

  test.each(['install', 'builtin', 'upgrade', 'release', 'single-sync', 'reconcile', 'report'])(
    'does not send a %s request when fresh route resolution fails',
    async operation => {
      vi.stubGlobal('fetch', vi.fn())
      const failure = new Error('Current registration unavailable')
      const api = createLocalDevicePluginApi(cloudApi(), vi.fn().mockRejectedValue(failure))
      const requests = {
        install: () => api.installMarketplacePlugin(101, deviceId),
        builtin: () => api.ensureBuiltinPluginInstalled('documents', { deviceId }),
        upgrade: () => api.updateMarketplacePlugin(101, 1002, deviceId),
        release: () => api.updateInstalledPlugin(101, { releaseId: 1002 }, deviceId),
        'single-sync': () => api.syncInstalledPluginToDevice(101, deviceId),
        reconcile: () => api.syncInstalledPluginsToDevice(deviceId, true),
        report: () => api.reportInstalledPluginsOnDevice(deviceId, []),
      }

      await expect(requests[operation as keyof typeof requests]()).rejects.toBe(failure)
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  test('rejects missing Runtime identity and empty routes without sending a synchronization request', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const resolver = vi.fn().mockResolvedValue(' ')
    const api = createLocalDevicePluginApi(cloudApi(), resolver)

    await expect(api.syncInstalledPluginsToDevice('')).rejects.toThrow(
      i18n.t('workbench.plugins_device_identity_required')
    )
    expect(resolver).not.toHaveBeenCalled()
    await expect(api.syncInstalledPluginsToDevice(deviceId)).rejects.toThrow(
      i18n.t('workbench.plugins_runtime_not_registered')
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  test('captures each asynchronous route and response scope across concurrent registration changes', async () => {
    const pendingRoutes: Array<(route: string) => void> = []
    const pendingResponses: Array<(response: Response) => void> = []
    const resolver = vi.fn(() => new Promise<string>(resolve => pendingRoutes.push(resolve)))
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(resolve => pendingResponses.push(resolve)))
    )
    const api = createLocalDevicePluginApi(cloudApi(), resolver)
    const first = api.listInstalledPlugins(deviceId)
    const second = api.listInstalledPlugins(deviceId)
    expect(fetch).not.toHaveBeenCalled()

    pendingRoutes[0]('app-record-70')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    pendingRoutes[1]('app-record-71')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    const response = (route: string) =>
      new Response(
        JSON.stringify({
          items: [
            {
              ...installed,
              status: { devices: [{ deviceId: route }, { deviceId: 'unrelated-device' }] },
            },
          ],
        })
      )
    pendingResponses[1](response('app-record-71'))
    pendingResponses[0](response('app-record-70'))

    for (const result of await Promise.all([first, second])) {
      expect(result.items[0].status.devices).toEqual([
        { deviceId },
        { deviceId: 'unrelated-device' },
      ])
    }
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      '/api/plugins/installed?device_id=app-record-70',
      '/api/plugins/installed?device_id=app-record-71',
    ])
  })
})

describe('plugin route connection profile', () => {
  const backendA = { apiBaseUrl: 'https://backend-a.example/wework/api', token: 'account-a-token' }
  const backendB = { apiBaseUrl: 'https://backend-b.example/wework/api', token: 'account-b-token' }
  let registered: { backend_url: string; auth_token: string; device_route_id: string }

  beforeEach(() => {
    registered = {
      backend_url: 'https://backend-a.example/wework',
      auth_token: backendA.token,
      device_route_id: requestId,
    }
    vi.mocked(requestLocalExecutor).mockImplementation(async (_method, params) => {
      if (
        params?.backend_url !== registered.backend_url ||
        params?.auth_token !== registered.auth_token
      ) {
        throw new Error('Plugin Runtime profile does not match')
      }
      return { device_id: deviceId, device_route_id: registered.device_route_id }
    })
    vi.mocked(ensureLocalExecutorAvailable).mockResolvedValue({
      running: true,
      ready: true,
      deviceId,
      deviceRouteId: requestId,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ plugin: installed, ...installed, items: [installed] }))
      )
    )
  })

  const scopedApi = (profile: typeof backendA) =>
    createLocalDevicePluginApi(
      createPluginApi(
        createHttpClient({ baseUrl: profile.apiBaseUrl, getToken: () => profile.token })
      ),
      id => resolveLocalPluginDeviceRouteId(id, profile)
    )

  test('rejects required targeting while the new Backend token is pending and the old Runtime remains connected', async () => {
    const apiB = scopedApi(backendB)

    await expect(apiB.installMarketplacePlugin(101, deviceId)).rejects.toThrow()
    await expect(apiB.updateInstalledPlugin(101, { releaseId: 1002 }, deviceId)).rejects.toThrow()
    await expect(apiB.syncInstalledPluginsToDevice(deviceId, true)).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('omits old profile routing from account reads and preferences while new Backend configuration is pending', async () => {
    const apiB = scopedApi(backendB)

    const inventory = await apiB.listInstalledPlugins(deviceId)
    await apiB.listMarketplacePlugins({ deviceId })
    await apiB.updateInstalledPlugin(101, { enabled: false }, deviceId)

    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      backendB.apiBaseUrl + '/plugins/installed',
      backendB.apiBaseUrl + '/plugins/marketplace',
      backendB.apiBaseUrl + '/plugins/installed/101',
    ])
    expect(inventory.items[0].status.devices).toEqual(wireDevices)
  })

  test('rejects a new account on the same Backend before its Runtime registration is applied', async () => {
    const newAccount = scopedApi({ ...backendA, token: 'account-b-token' })

    await expect(newAccount.installMarketplacePlugin(101, deviceId)).rejects.toThrow()
    await newAccount.updateInstalledPlugin(101, { enabled: false }, deviceId)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      backendA.apiBaseUrl + '/plugins/installed/101',
      expect.objectContaining({ method: 'PUT' })
    )
  })

  test('uses the new profile route after registration and refuses to lend it to an old API closure', async () => {
    const apiA = scopedApi(backendA)
    const apiB = scopedApi(backendB)
    registered = {
      backend_url: 'https://backend-b.example/wework',
      auth_token: backendB.token,
      device_route_id: 'app-record-95',
    }

    await expect(apiA.installMarketplacePlugin(101, deviceId)).rejects.toThrow()
    await apiB.installMarketplacePlugin(101, deviceId)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      backendB.apiBaseUrl + '/plugins/marketplace/101/install?device_id=app-record-95',
      expect.objectContaining({ method: 'POST' })
    )
  })

  test('keeps an in-flight old API bound to its profile while its IPC request is pending', async () => {
    const resolveRegisteredRoute = vi.mocked(requestLocalExecutor).getMockImplementation()!
    let releaseQuery!: () => void
    const queryGate = new Promise<void>(resolve => {
      releaseQuery = resolve
    })
    vi.mocked(requestLocalExecutor).mockImplementation(async (method, params) => {
      await queryGate
      return resolveRegisteredRoute(method, params)
    })
    const operation = scopedApi(backendA).installMarketplacePlugin(101, deviceId)
    const result = expect(operation).rejects.toThrow()
    registered = {
      backend_url: 'https://backend-b.example/wework',
      auth_token: backendB.token,
      device_route_id: 'app-record-95',
    }

    releaseQuery()
    await result

    expect(requestLocalExecutor).toHaveBeenCalledExactlyOnceWith('executor.plugins.device_route', {
      backend_url: 'https://backend-a.example/wework',
      auth_token: backendA.token,
      device_id: deviceId,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  test.each([
    ['plugin_route_profile_mismatch', 'workbench.plugins_runtime_changed'],
    ['plugin_route_unavailable', 'workbench.plugins_runtime_not_registered'],
  ])('localizes plugin route refusal %s', async (code, message) => {
    vi.mocked(requestLocalExecutor).mockRejectedValue(
      new DshExecutorTransportError(code, 'Internal Runtime refusal')
    )

    await expect(scopedApi(backendA).installMarketplacePlugin(101, deviceId)).rejects.toThrow(
      i18n.t(message)
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  test('refuses device targeting without account credentials', async () => {
    await expect(
      resolveLocalPluginDeviceRouteId(deviceId, { ...backendA, token: null })
    ).rejects.toThrow(i18n.t('workbench.plugins_runtime_changed'))
    expect(requestLocalExecutor).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('obtains each reconnect route from the plugin profile query without changing stable identity', async () => {
    const apiA = scopedApi(backendA)
    await apiA.installMarketplacePlugin(101, deviceId)
    registered.device_route_id = 'app-record-71'
    await apiA.installMarketplacePlugin(101, deviceId)

    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      backendA.apiBaseUrl + '/plugins/marketplace/101/install?device_id=app-record-70',
      backendA.apiBaseUrl + '/plugins/marketplace/101/install?device_id=app-record-71',
    ])
    expect(requestLocalExecutor).toHaveBeenCalledWith('executor.plugins.device_route', {
      backend_url: 'https://backend-a.example/wework',
      auth_token: backendA.token,
      device_id: deviceId,
    })
  })
})
