import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  toInstalledPlugin,
  toWegentStoreInstalledPlugin,
} from '@wegent/chat-core/codex-installed-plugins'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
  peekLocalCodexPluginsReadState,
} from './codexPlugins'

const mocks = vi.hoisted(() => ({ request: vi.fn(), personalPath: '' }))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))

vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: async () => ({ deviceId: 'device' }),
  ensureBundledPluginMarketplaceRegistered: async () => undefined,
  initializeBundledPluginMarketplace: async () => null,
  ensureBundledPluginInstalled: async () => undefined,
  withBundledPluginUpdatesPaused: (_name: string, mutation: () => Promise<unknown>) => mutation(),
  resumeBundledPluginUpdates: vi.fn(),
  getInitializedBundledPluginMarketplace: () =>
    mocks.personalPath ? { id: 'wework-personal', path: mocks.personalPath } : null,
  getKnownLocalExecutorDeviceId: () => 'device',
  requestLocalExecutor: (...args: unknown[]) => mocks.request(...args),
}))

const membership = {
  id: 'tianhe-direct@wework-personal',
  name: 'tianhe-direct',
  installed: true,
  enabled: true,
  source: { source: 'local', path: './plugins/tianhe-direct' },
}
const personal = {
  name: 'wework-personal',
  path: '/executor/personal',
  plugins: [membership],
}

function managedPersonalPackage() {
  return toWegentStoreInstalledPlugin(
    {
      packageId: '75-wework-personal-tianhe-direct-1.0.0',
      name: 'tianhe-direct',
      marketplace: 'wework-personal',
      version: '1.0.0',
      enabled: true,
      pluginPath: '/executor/store/75-wework-personal-tianhe-direct-1.0.0',
      cloudPluginId: 42,
      installedPluginId: 75,
    },
    '/executor/store',
    key => key
  )
}

beforeEach(() => {
  clearLocalCodexPluginsReadStateCache()
  mocks.request.mockReset()
  mocks.personalPath = ''
  mocks.request.mockImplementation(async (method: string, params?: { method?: string }) => {
    if (method === 'executor.plugins.store.list')
      return { storePath: '/executor/store', plugins: [] }
    if (method === 'executor.plugins.links.list') return []
    if (method === 'executor.plugins.manifest.read') return {}
    if (method !== 'codex.app_server_request') throw new Error(`Unexpected method: ${method}`)
    if (params?.method === 'plugin/list' || params?.method === 'plugin/installed') {
      return {
        marketplaces: [
          personal,
          {
            name: 'other-marketplace',
            path: '/executor/other',
            plugins: [{ ...membership, id: 'tianhe-direct@other-marketplace' }],
          },
        ],
      }
    }
    if (params?.method === 'plugin/read') {
      return { plugin: { summary: membership, description: 'Updated detail', skills: [] } }
    }
    throw new Error(`Unexpected app-server method: ${params?.method}`)
  })
})

describe('installed plugin detail identity', () => {
  test('keeps managed personal packages market-owned when expanding detail', async () => {
    const plugin = managedPersonalPackage()
    const detailed = await createLocalCodexPluginApi().readInstalledPluginDetail(plugin)

    expect(detailed.spec.description).toBe('Updated detail')
    expect(detailed.spec.source).toEqual(plugin.spec.source)
    expect(detailed.spec.origin).toBe('market')
    expect(detailed.spec.sourcePayload).toMatchObject(plugin.spec.sourcePayload!)
  })

  test('keeps independent author source identity and cloud links when expanding detail', async () => {
    const plugin = toInstalledPlugin(personal, membership, null, key => key)
    plugin.spec.sourcePayload = {
      ...plugin.spec.sourcePayload,
      cloudPluginId: 42,
      cloudReleaseId: 8,
    }
    const detailed = await createLocalCodexPluginApi().readInstalledPluginDetail(plugin)

    expect(detailed.spec.source).toEqual(plugin.spec.source)
    expect(detailed.spec.origin).toBe('created')
    expect(detailed.spec.sourcePayload).toMatchObject({ cloudPluginId: 42, cloudReleaseId: 8 })
    expect(detailed.spec.sourcePayload?.managedByWegent).not.toBe(true)
  })

  test('repairs stale created identity on managed packages even when author links are present', async () => {
    const plugin = managedPersonalPackage()
    plugin.spec.source.type = 'local'
    plugin.spec.origin = 'created'
    plugin.spec.sourcePayload = { ...plugin.spec.sourcePayload, cloudReleaseId: 8 }

    const detailed = await createLocalCodexPluginApi().readInstalledPluginDetail(plugin)

    expect(detailed.spec.source.type).toBe('marketplace')
    expect(detailed.spec.origin).toBe('market')
    expect(detailed.spec.sourcePayload).toMatchObject({
      managedByWegent: true,
      cloudPluginId: 42,
      cloudReleaseId: 8,
    })
  })

  test('does not replace another marketplace installation with the same plugin name', async () => {
    const api = createLocalCodexPluginApi()
    const state = await api.readState({ mergeAllMarketplaces: true })
    const other = state.installedPlugins.find(
      plugin => plugin.spec.source.marketplace === 'other-marketplace'
    )!
    const personalPlugin = state.installedPlugins.find(
      plugin => plugin.spec.source.marketplace === 'wework-personal'
    )!

    await api.readInstalledPluginDetail(personalPlugin)

    const cached = peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })
    expect(cached?.installedPlugins).toContainEqual(other)
    expect(
      cached?.installedPlugins.filter(
        plugin => plugin.spec.source.marketplace === 'other-marketplace'
      )
    ).toHaveLength(1)
  })

  test('does not overwrite a same-name cached source when its explicit cloud identity is unknown', async () => {
    const api = createLocalCodexPluginApi()
    const state = await api.readState({ mergeAllMarketplaces: true })
    const original = state.installedPlugins.find(
      plugin => plugin.spec.source.marketplace === 'wework-personal'
    )!

    await api.readInstalledPluginDetail(managedPersonalPackage())

    const cached = peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })
    expect(cached?.installedPlugins).toContainEqual(original)
  })

  test.each(['executor.plugins.store.list', 'executor.plugins.links.list'])(
    'strict source provenance rejects %s failures despite a warm catalog',
    async failingMethod => {
      const api = createLocalCodexPluginApi()
      await api.readState({ mergeAllMarketplaces: true })
      mocks.personalPath = '/executor/personal'
      const original = mocks.request.getMockImplementation()!
      mocks.request.mockImplementation(async (method, params) => {
        if (method === failingMethod) throw new Error(`Provenance unavailable: ${failingMethod}`)
        return original(method, params)
      })

      await expect(
        api.listInstalledPlugins({ refresh: true, requireComplete: true })
      ).rejects.toThrow(`Provenance unavailable: ${failingMethod}`)
    }
  )
})
