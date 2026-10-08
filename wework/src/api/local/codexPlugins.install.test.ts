import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PluginMarketplaceItem } from '@/types/api'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
  peekLocalCodexPluginsReadState,
} from './codexPlugins'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))
vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: async () => ({ deviceId: 'catalog-install-device' }),
  getKnownLocalExecutorDeviceId: () => 'catalog-install-device',
  ensureBundledPluginMarketplaceRegistered: async () => {},
  getInitializedBundledPluginMarketplace: () => null,
  requestLocalExecutor: (...args: unknown[]) => mocks.request(...args),
}))

const remoteId = 'plugin_connector_1p_github_regression'
const local = { name: 'wework', path: '/tmp/wework', plugins: [] }

function installRuntime({
  withRemoteId = true,
  rejectCatalog = false,
  staleInstalled = false,
  rejectPostInstallReads = false,
} = {}) {
  let installed = false
  const summary = () => ({
    id: 'github@openai-curated-remote',
    name: 'github',
    remotePluginId: withRemoteId ? remoteId : undefined,
    installed,
    enabled: installed,
    source: { type: 'remote' },
    interface: { displayName: 'GitHub' },
  })
  const remote = () => ({ name: 'openai-curated-remote', path: null, plugins: [summary()] })
  mocks.request.mockImplementation(
    async (
      method: string,
      args: {
        method?: string
        params?: Record<string, unknown>
      }
    ) => {
      if (method === 'executor.plugins.store.list') return { storePath: '/tmp/store', plugins: [] }
      if (method !== 'codex.app_server_request')
        throw new Error(`Unexpected executor call ${method}`)
      switch (args.method) {
        case 'plugin/list':
          if (rejectCatalog)
            throw new Error('Catalog must not be loaded to install a selected item')
          return { marketplaces: args.params?.marketplaceKinds ? [local] : [local, remote()] }
        case 'plugin/installed':
          return { marketplaces: installed && !staleInstalled ? [remote()] : [] }
        case 'plugin/install':
          expect(args.params).toEqual({
            marketplacePath: null,
            remoteMarketplaceName: 'openai-curated-remote',
            pluginName: remoteId,
          })
          installed = true
          return { authPolicy: 'ON_USE', appsNeedingAuth: [] }
        case 'plugin/read':
          if (installed && rejectPostInstallReads)
            throw new Error('Post-install detail is unavailable')
          return {
            plugin: {
              marketplaceName: 'openai-curated-remote',
              marketplacePath: null,
              summary: { ...summary(), remotePluginId: remoteId },
              description: '',
              skills: [],
              hooks: [],
              apps: [],
              agents: [],
              mcps: [],
              connectors: [],
            },
          }
        default:
          throw new Error(`Unexpected app-server call ${args.method}`)
      }
    }
  )
}

describe('installation from a shared catalog item', () => {
  beforeEach(() => {
    clearLocalCodexPluginsReadStateCache()
    mocks.request.mockReset()
  })

  test('accepts a remote install without waiting for stale membership or post-install detail', async () => {
    installRuntime({ staleInstalled: true, rejectPostInstallReads: true })
    const api = createLocalCodexPluginApi()
    const { items } = await api.readRemoteCatalog()
    mocks.request.mockClear()
    const plugin = await api.installAvailablePlugin(items[0])
    expect(plugin.spec.installState).toBe('installed')
    expect(plugin.metadata.labels).toEqual({ id: 'github@openai-curated-remote' })
    expect(plugin.spec.sourcePayload).toMatchObject({
      codexInstallationReceipt: {
        awaitingMembership: true,
        authPolicy: 'ON_USE',
        appsNeedingAuth: [],
      },
    })
    expect(
      mocks.request.mock.calls
        .filter(([method]) => method === 'codex.app_server_request')
        .map(([, args]) => args.method)
    ).toEqual(['plugin/install'])
  })

  test('retains authorization requirements without marking the account connected', async () => {
    installRuntime()
    const api = createLocalCodexPluginApi()
    const { items } = await api.readRemoteCatalog()
    mocks.request.mockResolvedValueOnce({
      authPolicy: 'ON_INSTALL',
      appsNeedingAuth: [
        { id: 'github-app', name: 'GitHub', installUrl: 'https://auth.example/secret' },
      ],
    })
    const plugin = await api.installAvailablePlugin(items[0])
    expect(plugin.spec.sourcePayload?.codexInstallationReceipt).toEqual({
      awaitingMembership: true,
      authPolicy: 'ON_INSTALL',
      appsNeedingAuth: [{ id: 'github-app', name: 'GitHub' }],
    })
    expect(plugin.spec.components).toEqual(items[0].components)
    expect(plugin.spec.manifest?.authPolicy).toBe('ON_INSTALL')
    expect(JSON.stringify(plugin)).not.toContain('https://auth.example/secret')
  })

  test.each([{}, { authPolicy: 'ON_USE', appsNeedingAuth: [null] }])(
    'rejects a malformed installation response instead of inventing success: %j',
    async response => {
      installRuntime()
      const api = createLocalCodexPluginApi()
      const { items } = await api.readRemoteCatalog()
      mocks.request.mockResolvedValueOnce(response)
      await expect(api.installAvailablePlugin(items[0])).rejects.toThrow(
        'Invalid Codex plugin/install response'
      )
    }
  )

  test.each([true, false])(
    'installs remote discovery without a full readState (remote id present=%s)',
    async withRemoteId => {
      installRuntime({ withRemoteId })
      const api = createLocalCodexPluginApi()
      const catalog = await api.readRemoteCatalog()
      await api.readState({ mergeAllMarketplaces: true, marketplaceKinds: ['local'] })
      mocks.request.mockClear()
      const result = await api.installAvailablePlugin(catalog.items[0])
      expect(result.spec.source.pluginKey).toBe('github')
      expect(result.spec.sourcePayload?.remotePluginId).toBe(remoteId)
      expect(
        mocks.request.mock.calls.filter(([, args]) => args?.method === 'plugin/install')
      ).toHaveLength(1)
      expect(mocks.request.mock.calls.some(([, args]) => args?.method === 'plugin/list')).toBe(
        false
      )
    }
  )

  test('installs a restored shared-catalog item even when remote discovery is unavailable', async () => {
    installRuntime({ rejectCatalog: true })
    const item: PluginMarketplaceItem = {
      id: 'github@openai-curated-remote',
      name: 'github',
      remotePluginId: remoteId,
      displayName: 'GitHub',
      description: '',
      version: null,
      author: null,
      visibility: 'public',
      featured: false,
      installed: false,
      installedPluginId: null,
      enabled: false,
      sourceType: 'marketplace',
      interface: null,
      components: {
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcps: [],
        lsps: [],
        monitors: [],
        bins: [],
      },
      manifest: { marketplaceId: 'openai-curated-remote', marketplacePath: null },
      ownerUserId: 0,
      sourceProvider: 'openai',
      sourceLabel: 'OpenAI',
    }
    await expect(createLocalCodexPluginApi().installAvailablePlugin(item)).resolves.toMatchObject({
      spec: { source: { pluginKey: 'github' }, enabled: true },
    })
    expect(mocks.request.mock.calls.some(([, args]) => args?.method === 'plugin/list')).toBe(false)
  })

  test.each([false, true])(
    'distinguishes full and local-only catalog reads (local first=%s)',
    async localFirst => {
      installRuntime()
      const api = createLocalCodexPluginApi()
      const full = { mergeAllMarketplaces: true }
      const scoped = { ...full, marketplaceKinds: ['local'] as Array<'local'> }
      await api.readState(localFirst ? scoped : full)
      const second = await api.readState(localFirst ? full : scoped)
      expect(second.marketplaceItems.some(item => item.name === 'github')).toBe(localFirst)
      expect(
        mocks.request.mock.calls.filter(([, args]) => args?.method === 'plugin/list')
      ).toHaveLength(2)
    }
  )

  test.each([false, true])(
    'never reuses a persisted local-only catalog as full (legacy key=%s)',
    async legacyKey => {
      installRuntime()
      const api = createLocalCodexPluginApi()
      await api.readState({ mergeAllMarketplaces: true, marketplaceKinds: ['local'] })
      const raw = window.localStorage.getItem('wework.plugins.codexCatalog.v1')!
      expect(raw).toBeTruthy()
      const store = JSON.parse(raw)
      if (legacyKey) {
        const entry = store.entries['|all|local']
        store.entries = { '|all': { ...entry, paramsKey: '|all' } }
      }
      clearLocalCodexPluginsReadStateCache()
      window.localStorage.setItem('wework.plugins.codexCatalog.v1', JSON.stringify(store))
      expect(peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })).toBeNull()
      const full = await api.readState({ mergeAllMarketplaces: true })
      expect(full.marketplaceItems.some(item => item.name === 'github')).toBe(true)
      expect(
        mocks.request.mock.calls.filter(([, args]) => args?.method === 'plugin/list')
      ).toHaveLength(2)
    }
  )

  test('propagates actual install rejection without marking the plugin installed', async () => {
    installRuntime()
    const api = createLocalCodexPluginApi()
    const { items } = await api.readRemoteCatalog()
    const original = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation((method, args) => {
      if (args?.method === 'plugin/install') throw new Error('Authentication required')
      return original(method, args)
    })
    await expect(api.installAvailablePlugin(items[0])).rejects.toThrow('Authentication required')
    expect(
      mocks.request.mock.calls.filter(([, args]) => args?.method === 'plugin/install')
    ).toHaveLength(1)
  })
})
