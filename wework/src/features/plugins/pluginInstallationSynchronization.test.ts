import { createHttpClient } from '@/api/http'
import { createPluginApi } from '@/api/plugins'
import type { PluginMarketplaceItem } from '@/types/api'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { runCurrentDevicePluginAutoUpdate } from './pluginAutoUpdate'
import {
  beginPluginDeviceSync,
  clearPluginDeviceAutoSyncAttempts,
  hasInFlightPluginDeviceSync,
} from './pluginDeviceAutoSync'
import { createLocalDevicePluginApi } from './pluginDeviceApi'

const DEVICE = 'local-runtime'
const ROUTE = 'app-record-73'
const receipt = () =>
  new Response(
    JSON.stringify({
      plugin: { metadata: { name: 'documents' }, status: { devices: [] } },
    })
  )

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function api(resolveRoute = vi.fn(async () => ROUTE)) {
  return createLocalDevicePluginApi(
    createPluginApi(createHttpClient({ baseUrl: '/api', getToken: () => null })),
    resolveRoute
  )
}

beforeEach(() => clearPluginDeviceAutoSyncAttempts())
afterEach(() => {
  clearPluginDeviceAutoSyncAttempts()
  vi.unstubAllGlobals()
})

test.each(['marketplace', 'builtin'] as const)(
  'keeps background repair out of the pending %s installation transaction',
  async source => {
    const response = deferred<Response>()
    const fetch = vi.fn(() => response.promise)
    vi.stubGlobal('fetch', fetch)
    const plugins = api()
    const install =
      source === 'marketplace'
        ? plugins.installMarketplacePlugin(101, DEVICE)
        : plugins.ensureBuiltinPluginInstalled('documents', { deviceId: DEVICE })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(hasInFlightPluginDeviceSync(DEVICE)).toBe(true)

    let installed = false
    const listLocalInstalledPlugins = vi.fn(async () => ({ deviceId: DEVICE }))
    const listMarketplacePlugins = vi.fn(async () => ({
      items: [
        {
          installed: true,
          installedPluginId: 101,
          installedLocally: installed,
          currentDeviceInstallation: { state: installed ? 'installed' : 'pending' },
        } as PluginMarketplaceItem,
      ],
    }))
    const updateBatch = vi.fn(async () => ({ updated: [], updatedCount: 0, remainingCount: 0 }))
    const syncDevice = vi.fn()
    const syncPlugin = vi.fn()
    const background = runCurrentDevicePluginAutoUpdate({
      listLocalInstalledPlugins,
      listMarketplacePlugins,
      updateBatch,
      syncDevice,
      syncPlugin,
    })
    await vi.waitFor(() => expect(listLocalInstalledPlugins).toHaveBeenCalledOnce())
    expect(listMarketplacePlugins).not.toHaveBeenCalled()
    expect(updateBatch).not.toHaveBeenCalled()

    installed = true
    response.resolve(receipt())
    await install
    await expect(background).resolves.toMatchObject({
      updatedCount: 0,
      failedCount: 0,
      deviceSyncPerformed: false,
    })
    expect(listMarketplacePlugins).toHaveBeenCalledOnce()
    expect(updateBatch).toHaveBeenCalledOnce()
    expect(syncDevice).not.toHaveBeenCalled()
    expect(syncPlugin).not.toHaveBeenCalled()
    expect(hasInFlightPluginDeviceSync(DEVICE)).toBe(false)
  }
)

test('resolves the current registered route only after a competing device lease settles', async () => {
  const release = beginPluginDeviceSync(DEVICE, 'reconcile')!
  let route = ROUTE
  const resolveRoute = vi.fn(async () => route)
  const fetch = vi.fn(async () => receipt())
  vi.stubGlobal('fetch', fetch)
  const install = api(resolveRoute).installMarketplacePlugin(101, DEVICE)
  expect(resolveRoute).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  route = 'app-record-74'
  release()
  await install
  expect(resolveRoute).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledWith(
    '/api/plugins/marketplace/101/install?device_id=app-record-74',
    expect.objectContaining({ method: 'POST' })
  )
  expect(hasInFlightPluginDeviceSync(DEVICE)).toBe(false)
})

test.each(['route', 'install'] as const)(
  'releases the installation lease on %s failure',
  async stage => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Install failed')))
    const resolveRoute = vi.fn(async () => {
      if (stage === 'route') throw new Error('Runtime profile changed')
      return ROUTE
    })
    await expect(api(resolveRoute).installMarketplacePlugin(101, DEVICE)).rejects.toThrow()
    expect(hasInFlightPluginDeviceSync(DEVICE)).toBe(false)
    if (stage === 'route') expect(fetch).not.toHaveBeenCalled()
  }
)
