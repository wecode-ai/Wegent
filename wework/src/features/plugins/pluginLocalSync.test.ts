import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPluginApi } from '@/api/plugins'
import { createHttpClient } from '@/api/http'
import { requestLocalExecutor } from '@/desktop/localExecutor'
import { createLocalDevicePluginApi } from './pluginDeviceApi'
import { pluginDeviceReceiptPending } from './waitForPluginDeviceReceipt'
import type { InstalledPlugin } from '@/types/api'

vi.mock('@/desktop/localExecutor', () => ({
  requestLocalExecutor: vi.fn(),
  getKnownLocalExecutorDeviceId: () => 'desktop-local',
}))
const request = vi.mocked(requestLocalExecutor)
const profile = { apiBaseUrl: '/api', token: 'account-token' }
const plugin = {
  apiVersion: 'v1',
  kind: 'InstalledPlugin',
  metadata: { labels: { id: '12' } },
  spec: { releaseId: 3, version: '1.0.0', packageRef: { checksum: 'sha256:abc' } },
  status: { state: 'Available', devices: [] },
} as unknown as InstalledPlugin
function setup() {
  const raw = createPluginApi(createHttpClient({ baseUrl: '/api', getToken: () => profile.token }))
  const route = vi.fn().mockRejectedValue(new Error('Device registration failed'))
  return { api: createLocalDevicePluginApi(raw, route, profile), route }
}
function success() {
  return {
    enabled: true,
    protocolVersion: 1,
    localCompleted: true,
    operation: { plugin },
    result: { plugins: [{ id: 12, status: 'synced', version: '1.0.0', checksum: 'sha256:abc' }] },
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', vi.fn())
})
describe('HTTP local plugin execution', () => {
  test('installs without a cloud Device and finishes without Device receipts', async () => {
    request
      .mockResolvedValueOnce({ enabled: true, protocolVersion: 1 })
      .mockResolvedValueOnce(success())
    const { api, route } = setup()
    const result = await api.installMarketplacePlugin(5)
    expect(route).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(request).toHaveBeenLastCalledWith(
      'executor.plugins.local_sync',
      expect.objectContaining({ action: 'install', targetId: 5 })
    )
    expect(result.plugin.status.devices).toEqual([])
    expect(result.plugin.status.localExecution).toEqual({ state: 'installed', releaseId: 3 })
    expect(pluginDeviceReceiptPending(result.plugin, '')).toBe(false)
  })
  test.each(['uninstall', 'update'] as const)(
    'performs %s through the same coordinator',
    async action => {
      request
        .mockResolvedValueOnce({ enabled: true, protocolVersion: 1 })
        .mockResolvedValueOnce(success())
      const { api, route } = setup()
      if (action === 'uninstall') await api.uninstallInstalledPlugin(12)
      else await api.updateMarketplacePlugin(12, 3)
      expect(route).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      expect(request).toHaveBeenLastCalledWith(
        'executor.plugins.local_sync',
        expect.objectContaining({ action, targetId: 12 })
      )
    }
  )
  test('never falls back or repeats a mutation after uncertain submission', async () => {
    request
      .mockResolvedValueOnce({ enabled: true, protocolVersion: 1 })
      .mockRejectedValueOnce(
        Object.assign(new Error('lost response'), { code: 'plugin_local_http_unavailable' })
      )
    const { api, route } = setup()
    await expect(api.installMarketplacePlugin(5)).rejects.toMatchObject({
      code: 'plugin_local_http_unavailable',
    })
    expect(route).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(2)
  })
  test.each([false, 'old-runtime'])(
    'retains legacy behavior before mutation when unsupported: %s',
    async mode => {
      if (mode === false) request.mockResolvedValue({ enabled: false, protocolVersion: 1 })
      else
        request.mockRejectedValue(
          Object.assign(new Error('unsupported'), { code: 'unsupported_method' })
        )
      const { api, route } = setup()
      await expect(api.installMarketplacePlugin(5, 'stable')).rejects.toThrow(
        'Device registration failed'
      )
      expect(route).toHaveBeenCalledWith('stable')
      expect(request).toHaveBeenCalledTimes(1)
      expect(fetch).not.toHaveBeenCalled()
    }
  )
  test('a legacy builtin without a declared version uses the verified installer default', async () => {
    const unversioned = { ...plugin, spec: { ...plugin.spec, version: null, releaseId: null } }
    request.mockResolvedValueOnce({ enabled: true, protocolVersion: 1 }).mockResolvedValueOnce({
      ...success(),
      operation: { plugin: unversioned },
      result: {
        plugins: [{ id: 12, status: 'synced', version: 'latest', checksum: 'sha256:abc' }],
      },
    })
    const response = await setup().api.ensureBuiltinPluginInstalled('legacy')
    expect(response.plugin.status.localExecution).toEqual({ state: 'installed', releaseId: null })
    expect(pluginDeviceReceiptPending(response.plugin, '')).toBe(false)
  })
  test('does not accept an account save as local completion', async () => {
    request
      .mockResolvedValueOnce({ enabled: true, protocolVersion: 1 })
      .mockResolvedValueOnce({ enabled: true, protocolVersion: 1, operation: { plugin } })
    await expect(setup().api.installMarketplacePlugin(5)).rejects.toThrow(
      'PLUGIN_LOCAL_EXECUTION_UNCONFIRMED'
    )
  })
  test.each([undefined, 'runtime-origin'])(
    'automatic updates send no device identity even if a probe returns one: %s',
    async sourceDeviceId => {
      request.mockResolvedValue({ enabled: true, protocolVersion: 1, sourceDeviceId })
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ updated: [], updatedCount: 0, remainingCount: 0 }))
      )
      const { api, route } = setup()
      await api.autoUpdateInstalledPlugins()
      expect(fetch).toHaveBeenCalledWith(
        '/api/plugins/installed/auto-update-batch?delivery_mode=local_pull_v1',
        expect.anything()
      )
      expect(route).not.toHaveBeenCalled()
    }
  )
  test('a per-plugin update returns the actual installer acknowledgement', async () => {
    request
      .mockResolvedValueOnce({ enabled: true, protocolVersion: 1 })
      .mockResolvedValueOnce(success())
    const response = await setup().api.syncInstalledPluginToDevice(12, '')
    expect(request).toHaveBeenLastCalledWith(
      'executor.plugins.local_sync',
      expect.objectContaining({ installedPluginId: 12 })
    )
    expect(response.sync.plugins).toEqual(success().result.plugins)
  })
  test.each([false, true])(
    'full reconciliation bypasses rejected or uncertain pending work: reconcile=%s',
    async reconcile => {
      request.mockImplementation(async (_method, params) => {
        const input = params as { probeOnly?: boolean; full?: boolean }
        if (input.probeOnly) return { enabled: true, protocolVersion: 1, recoveryPending: true }
        if (!input.full)
          throw Object.assign(new Error('Pending request failed'), {
            code: 'plugin_local_http_unavailable',
          })
        return { ...success(), result: { ...success().result, scope: 'plugins' } }
      })
      expect((await setup().api.syncInstalledPluginsToDevice('', reconcile)).reconciled).toBe(true)
      expect(request).toHaveBeenLastCalledWith(
        'executor.plugins.local_sync',
        expect.objectContaining({ full: true })
      )
      expect(request).toHaveBeenCalledTimes(2)
    }
  )
  test('local reconciliation never submits a cloud Device receipt', async () => {
    request
      .mockResolvedValueOnce({ enabled: true, protocolVersion: 1 })
      .mockResolvedValueOnce(success())
    const result = await setup().api.syncInstalledPluginsToDevice('', true)
    expect(result.reconciled).toBe(true)
    expect(result.sync.success).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })
})

test.each([
  ['1.0.0', 'sha256:abc', true],
  ['2.0.0', 'sha256:abc', false],
  ['1.0.0', 'sha256:changed', false],
] as const)(
  'marketplace proof checks account version %s and checksum %s',
  async (version, checksum, confirmed) => {
    request
      .mockResolvedValueOnce({ enabled: true, protocolVersion: 1 })
      .mockResolvedValueOnce(success())
    const { api } = setup()
    await api.installMarketplacePlugin(5)
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: 5,
                installedPluginId: 12,
                installed: true,
                installedLocally: false,
                version: '2.0.0',
                installedVersion: version,
              },
            ],
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ ...plugin, spec: { ...plugin.spec, version, packageRef: { checksum } } }],
          })
        )
      )
    const response = await api.listMarketplacePlugins()
    expect(response.items[0].installedLocally).toBe(confirmed)
    expect(response.items[0].installedVersion).toBe('1.0.0')
  }
)

test('catalog stays readable without falsely confirming a package when account verification fails', async () => {
  request
    .mockResolvedValueOnce({ enabled: true, protocolVersion: 1 })
    .mockResolvedValueOnce(success())
  const { api } = setup()
  await api.installMarketplacePlugin(5)
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              id: 5,
              installedPluginId: 12,
              installed: true,
              installedLocally: false,
            },
          ],
        })
      )
    )
    .mockRejectedValueOnce(new Error('Inventory unavailable'))
  expect((await api.listMarketplacePlugins()).items[0].installedLocally).toBe(false)
})
