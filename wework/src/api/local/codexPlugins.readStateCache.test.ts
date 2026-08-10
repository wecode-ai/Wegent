import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
  peekLocalCodexPluginsReadState,
  warmLocalCodexPluginsReadState,
} from './codexPlugins'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  requestLocalExecutor: vi.fn(),
  ensureLocalExecutorStarted: vi.fn(),
  ensureBundledPluginMarketplaceRegistered: vi.fn(),
  getInitializedBundledPluginMarketplace: vi.fn(() => null),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: () => true,
}))

vi.mock('@/tauri/localExecutor', () => ({
  ensureLocalExecutorStarted: () => mocks.ensureLocalExecutorStarted(),
  ensureBundledPluginMarketplaceRegistered: () => mocks.ensureBundledPluginMarketplaceRegistered(),
  getInitializedBundledPluginMarketplace: () => mocks.getInitializedBundledPluginMarketplace(),
  requestLocalExecutor: (...args: unknown[]) => mocks.requestLocalExecutor(...args),
}))

const personalMarketplace = {
  name: 'wework-personal',
  path: '/tmp/wework-personal',
  interface: { displayName: 'Personal' },
  plugins: [] as unknown[],
}

const createdPlugin: InstalledPlugin = {
  apiVersion: 'agent.wecode.io/v1',
  kind: 'InstalledPlugin',
  metadata: {
    name: 'dev-tools',
    namespace: 'wework-personal',
    labels: { id: 'dev-tools@wework-personal' },
  },
  spec: {
    source: {
      type: 'local',
      providerKey: 'wework-personal',
      pluginKey: 'dev-tools',
      catalogItemId: 'dev-tools@wework-personal',
      marketplace: 'wework-personal',
    },
    origin: 'created',
    installState: 'installed',
    enabled: true,
    displayName: 'Dev Tools',
    description: 'Developer tools',
    componentStates: {},
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
    interface: null,
    packageRef: null,
    sourcePayload: {
      marketplaceName: 'wework-personal',
      marketplacePath: '/tmp/wework-personal',
      pluginName: 'dev-tools',
    },
  },
  status: { state: 'enabled' },
}

describe('local codex plugin readState cache', () => {
  beforeEach(() => {
    clearLocalCodexPluginsReadStateCache()
    mocks.invoke.mockReset()
    mocks.requestLocalExecutor.mockReset()
    mocks.ensureLocalExecutorStarted.mockReset()
    mocks.ensureBundledPluginMarketplaceRegistered.mockReset()
    mocks.ensureLocalExecutorStarted.mockResolvedValue({ deviceId: 'local-device' })
    mocks.ensureBundledPluginMarketplaceRegistered.mockResolvedValue(undefined)
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list' || params.method === 'plugin/installed') {
          return { marketplaces: [personalMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'local_executor_read_plugin_cloud_links') return []
      if (command === 'local_executor_ensure_personal_plugin') {
        return {
          pluginName: 'dev-tools',
          marketplacePath: '/tmp/wework-personal',
          pluginPath: '/tmp/wework-personal/plugins/dev-tools',
          migrated: false,
        }
      }
      if (command === 'local_executor_link_plugin_release') return null
      throw new Error(`Unexpected invoke ${command}`)
    })
  })

  test('linkPersonalPluginRelease drops TTL cache so the next readState reloads', async () => {
    const api = createLocalCodexPluginApi()

    await api.readState({ mergeAllMarketplaces: true })
    const readsAfterWarm = mocks.requestLocalExecutor.mock.calls.filter(
      ([method, params]) =>
        method === 'codex.app_server_request' &&
        (params as { method?: string }).method === 'plugin/list'
    ).length
    expect(readsAfterWarm).toBe(1)

    await api.readState({ mergeAllMarketplaces: true })
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          (params as { method?: string }).method === 'plugin/list'
      ).length
    ).toBe(1)

    await api.linkPersonalPluginRelease(createdPlugin, 71, 82)

    await api.readState({ mergeAllMarketplaces: true })
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          (params as { method?: string }).method === 'plugin/list'
      ).length
    ).toBe(2)
    expect(mocks.invoke).toHaveBeenCalledWith('local_executor_link_plugin_release', {
      marketplacePath: '/tmp/wework-personal',
      localPluginName: 'dev-tools',
      cloudPluginId: 71,
      cloudReleaseId: 82,
    })
  })

  test('search query reuses the unfiltered readState TTL cache', async () => {
    const githubPlugin = {
      name: 'github',
      version: '1.0.0',
      description: 'GitHub integration',
      interface: { displayName: 'GitHub' },
    }
    const slackPlugin = {
      name: 'slack',
      version: '1.0.0',
      description: 'Slack integration',
      interface: { displayName: 'Slack' },
    }
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list') {
          return {
            marketplaces: [
              {
                ...personalMarketplace,
                plugins: [githubPlugin, slackPlugin],
              },
            ],
          }
        }
        if (params.method === 'plugin/installed') {
          return { marketplaces: [personalMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    const warm = await api.readState({ mergeAllMarketplaces: true })
    expect(warm.marketplaceItems.map(item => item.name)).toEqual(['github', 'slack'])

    const searched = await api.readState({ mergeAllMarketplaces: true, q: 'github' })
    expect(searched.marketplaceItems.map(item => item.name)).toEqual(['github'])
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          (params as { method?: string }).method === 'plugin/list'
      ).length
    ).toBe(1)

    const cleared = await api.readState({ mergeAllMarketplaces: true, q: '' })
    expect(cleared.marketplaceItems.map(item => item.name)).toEqual(['github', 'slack'])
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          (params as { method?: string }).method === 'plugin/list'
      ).length
    ).toBe(1)
  })

  test('concurrent readState calls share one plugin/list request', async () => {
    let resolveList: ((value: unknown) => void) | null = null
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list') {
          expect(params).toEqual(
            expect.objectContaining({
              method: 'plugin/list',
              params: expect.objectContaining({
                marketplaceKinds: ['local'],
              }),
            })
          )
          return await new Promise(resolve => {
            resolveList = resolve
          })
        }
        if (params.method === 'plugin/installed') {
          return { marketplaces: [personalMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    const first = api.readState({ mergeAllMarketplaces: true })
    const second = api.readState({ mergeAllMarketplaces: true })

    await vi.waitFor(() => {
      expect(
        mocks.requestLocalExecutor.mock.calls.filter(
          ([method, params]) =>
            method === 'codex.app_server_request' &&
            (params as { method?: string }).method === 'plugin/list'
        ).length
      ).toBe(1)
    })

    expect(resolveList).not.toBeNull()
    resolveList!({ marketplaces: [personalMarketplace] })
    await Promise.all([first, second])
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          (params as { method?: string }).method === 'plugin/list'
      ).length
    ).toBe(1)
  })

  test('stale readState returns cache immediately and refreshes plugin/list in background', async () => {
    const api = createLocalCodexPluginApi()
    const warm = await api.readState({ mergeAllMarketplaces: true })
    expect(warm.deviceId).toBe('local-device')

    let resolveList: ((value: unknown) => void) | null = null
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list') {
          return await new Promise(resolve => {
            resolveList = resolve
          })
        }
        if (params.method === 'plugin/installed') {
          return { marketplaces: [personalMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)

    const stalePromise = api.readState({ mergeAllMarketplaces: true })
    const stale = await stalePromise
    expect(stale.deviceId).toBe('local-device')
    await vi.waitFor(() => {
      expect(resolveList).not.toBeNull()
    })

    resolveList!({
      marketplaces: [
        {
          ...personalMarketplace,
          plugins: [
            {
              name: 'github',
              version: '1.0.0',
              description: 'GitHub',
              interface: { displayName: 'GitHub' },
            },
          ],
        },
      ],
    })
    await vi.waitFor(() => {
      expect(
        peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.marketplaceItems.map(
          item => item.name
        )
      ).toEqual(['github'])
    })
  })

  test('peekLocalCodexPluginsReadState hydrates from localStorage after memory clear', async () => {
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })
    const warmed = peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })
    expect(warmed?.deviceId).toBe('local-device')

    // Simulate an app restart that loses module memory but keeps localStorage.
    const raw = window.localStorage.getItem('wework.plugins.codexReadState.v1')
    expect(raw).toBeTruthy()
    clearLocalCodexPluginsReadStateCache()
    window.localStorage.setItem('wework.plugins.codexReadState.v1', raw!)

    expect(peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.deviceId).toBe(
      'local-device'
    )
  })

  test('migrates a legacy sessionStorage snapshot into localStorage', async () => {
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })
    const raw = window.localStorage.getItem('wework.plugins.codexReadState.v1')
    expect(raw).toBeTruthy()

    clearLocalCodexPluginsReadStateCache()
    window.sessionStorage.setItem('wework.plugins.codexReadState.v1', raw!)

    expect(peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.deviceId).toBe(
      'local-device'
    )
    expect(window.localStorage.getItem('wework.plugins.codexReadState.v1')).toBeTruthy()
    expect(window.sessionStorage.getItem('wework.plugins.codexReadState.v1')).toBeNull()
  })

  test('warmLocalCodexPluginsReadState shares the same plugin/list inflight as readState', async () => {
    let resolveList: ((value: unknown) => void) | null = null
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list') {
          return await new Promise(resolve => {
            resolveList = resolve
          })
        }
        if (params.method === 'plugin/installed') {
          return { marketplaces: [personalMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const warmPromise = warmLocalCodexPluginsReadState()
    expect(warmPromise).not.toBeNull()
    const readPromise = createLocalCodexPluginApi().readState({ mergeAllMarketplaces: true })

    await vi.waitFor(() => {
      expect(
        mocks.requestLocalExecutor.mock.calls.filter(
          ([method, params]) =>
            method === 'codex.app_server_request' &&
            (params as { method?: string }).method === 'plugin/list'
        ).length
      ).toBe(1)
    })

    resolveList!({ marketplaces: [personalMarketplace] })
    await Promise.all([warmPromise, readPromise])
    expect(peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.deviceId).toBe(
      'local-device'
    )
  })

  test('listInstalledPlugins uses plugin/installed and never waits on plugin/list', async () => {
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list') {
          throw new Error('plugin/list must not run for listInstalledPlugins')
        }
        if (params.method === 'plugin/installed') {
          return {
            marketplaces: [
              {
                ...personalMarketplace,
                plugins: [
                  {
                    name: 'dev-tools',
                    id: 'dev-tools',
                    installed: true,
                    enabled: true,
                    interface: { displayName: 'Dev Tools' },
                  },
                ],
              },
            ],
          }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    const listed = await api.listInstalledPlugins()
    expect(listed.items.map(item => item.metadata.name)).toEqual(['dev-tools'])
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          (params as { method?: string }).method === 'plugin/list'
      )
    ).toHaveLength(0)
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          (params as { method?: string }).method === 'plugin/installed'
      )
    ).toHaveLength(1)
  })

  test('listInstalledPlugins ignores durable peek with empty installedPlugins', async () => {
    const api = createLocalCodexPluginApi()
    // Warm durable cache with a catalog that has no installs yet.
    await api.readState({ mergeAllMarketplaces: true })
    expect(
      peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.installedPlugins
    ).toEqual([])

    mocks.requestLocalExecutor.mockClear()
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list') {
          throw new Error('plugin/list must not run for listInstalledPlugins')
        }
        if (params.method === 'plugin/installed') {
          return {
            marketplaces: [
              {
                ...personalMarketplace,
                plugins: [
                  {
                    name: 'dingtalk',
                    id: 'dingtalk',
                    installed: true,
                    enabled: true,
                    interface: { displayName: '钉钉' },
                  },
                ],
              },
            ],
          }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const listed = await api.listInstalledPlugins()
    expect(listed.items.map(item => item.metadata.name)).toEqual(['dingtalk'])
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          (params as { method?: string }).method === 'plugin/installed'
      )
    ).toHaveLength(1)
  })

  test('listInstalledPlugins refreshes via plugin/installed when peek is stale', async () => {
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })

    const installedResponse = (pluginName: string) => ({
      marketplaces: [
        {
          ...personalMarketplace,
          plugins: [
            {
              name: pluginName,
              id: pluginName,
              installed: true,
              enabled: true,
              interface: { displayName: pluginName },
            },
          ],
        },
      ],
    })

    mocks.requestLocalExecutor.mockClear()
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list') {
          throw new Error('plugin/list must not run for listInstalledPlugins')
        }
        if (params.method === 'plugin/installed') {
          return installedResponse('dingtalk')
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const first = await api.listInstalledPlugins()
    expect(first.items.map(item => item.metadata.name)).toEqual(['dingtalk'])

    mocks.requestLocalExecutor.mockClear()
    const second = await api.listInstalledPlugins()
    expect(second.items.map(item => item.metadata.name)).toEqual(['dingtalk'])
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          (params as { method?: string }).method === 'plugin/installed'
      )
    ).toHaveLength(0)

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list') {
          throw new Error('plugin/list must not run for listInstalledPlugins')
        }
        if (params.method === 'plugin/installed') {
          return installedResponse('lark')
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const third = await api.listInstalledPlugins()
    expect(third.items.map(item => item.metadata.name)).toEqual(['lark'])
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          (params as { method?: string }).method === 'plugin/installed'
      )
    ).toHaveLength(1)
  })

  test('listInstalledPlugins does not persist membership-only snapshot to durable cache', async () => {
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })

    const durableKey = 'wework.plugins.codexReadState.v1'
    const durableBefore = window.localStorage.getItem(durableKey)
    expect(durableBefore).toBeTruthy()

    const installedResponse = (pluginName: string) => ({
      marketplaces: [
        {
          ...personalMarketplace,
          plugins: [
            {
              name: pluginName,
              id: pluginName,
              installed: true,
              enabled: true,
              interface: { displayName: pluginName },
            },
          ],
        },
      ],
    })

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    mocks.requestLocalExecutor.mockClear()
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list') {
          throw new Error('plugin/list must not run for listInstalledPlugins')
        }
        if (params.method === 'plugin/installed') {
          return installedResponse('dingtalk')
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const listed = await api.listInstalledPlugins()
    expect(listed.items.map(item => item.metadata.name)).toEqual(['dingtalk'])
    // Memory is refreshed for this session…
    expect(
      peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.installedPlugins.map(
        item => item.metadata.name
      )
    ).toEqual(['dingtalk'])
    // …but durable localStorage must keep the fuller readState snapshot.
    expect(window.localStorage.getItem(durableKey)).toBe(durableBefore)
  })
})
