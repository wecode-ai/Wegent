import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest'
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

  afterEach(() => {
    vi.restoreAllMocks()
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
                cwds: null,
              }),
            })
          )
          expect(
            (params as { params?: { marketplaceKinds?: unknown } }).params?.marketplaceKinds
          ).toBeUndefined()
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
    const raw = window.localStorage.getItem('wework.plugins.codexReadState.v2')
    expect(raw).toBeTruthy()
    clearLocalCodexPluginsReadStateCache()
    window.localStorage.setItem('wework.plugins.codexReadState.v2', raw!)

    expect(peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.deviceId).toBe(
      'local-device'
    )
  })

  test('migrates yesterday durable v1 peek into v2 without forcing a cold plugin/list', async () => {
    clearLocalCodexPluginsReadStateCache()
    const legacy = {
      version: 1,
      entries: {
        '|all': {
          paramsKey: '|all',
          cachedAt: Date.now(),
          state: {
            marketplaceItems: [
              {
                id: 'gmail',
                name: 'gmail',
                displayName: 'Gmail',
                description: 'mail',
                marketplaceId: 'openai-curated-remote',
                components: {
                  skills: [],
                  commands: [],
                  agents: [],
                  apps: [],
                  hooks: [],
                  mcps: [],
                  connectors: [],
                  lsps: [],
                  monitors: [],
                  bins: [],
                },
              },
            ],
            installedPlugins: [],
            marketplaces: [
              { id: 'openai-curated-remote', name: 'OpenAI', path: 'openai-curated-remote' },
            ],
            selectedMarketplaceId: 'openai-curated-remote',
            marketplacePath: '',
            installRegistryPath: '',
            deviceId: 'local-device',
          },
        },
      },
    }
    window.localStorage.setItem('wework.plugins.codexReadState.v1', JSON.stringify(legacy))

    const peeked = peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })
    expect(peeked?.marketplaceItems.map(item => item.name)).toEqual(['gmail'])
    expect(peeked?.deviceId).toBe('local-device')
    expect(window.localStorage.getItem('wework.plugins.codexReadState.v2')).toBeTruthy()
    expect(window.localStorage.getItem('wework.plugins.codexReadState.v1')).toBeNull()
    expect(mocks.requestLocalExecutor).not.toHaveBeenCalled()
  })

  test('plugin detail writes connector stubs into durable peek for later send preflight', async () => {
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
                name: 'wegent',
                path: '/tmp/wegent',
                interface: { displayName: 'Wegent' },
                plugins: [
                  {
                    id: 'dingtalk',
                    name: 'dingtalk',
                    installed: true,
                    enabled: true,
                    interface: { displayName: 'DingTalk' },
                  },
                ],
              },
            ],
          }
        }
        if (params.method === 'plugin/installed') {
          return {
            marketplaces: [
              {
                name: 'wegent',
                path: '/tmp/wegent',
                interface: { displayName: 'Wegent' },
                plugins: [
                  {
                    id: 'dingtalk',
                    name: 'dingtalk',
                    installed: true,
                    enabled: true,
                  },
                ],
              },
            ],
          }
        }
        if (params.method === 'plugin/read') {
          return {
            plugin: {
              name: 'dingtalk',
              version: '1.0.0',
              description: 'DingTalk',
              connectors: [
                {
                  slug: 'dingtalk',
                  authPolicy: 'on_install',
                  localAuth: {
                    kind: 'browser_oauth',
                    health: ['auth', 'health'],
                    start: ['auth', 'login'],
                  },
                },
              ],
              skills: [{ name: 'dingtalk', description: 'skill', path: 'skills/dingtalk' }],
            },
          }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })
    await api.readInstalledPluginForTrial('dingtalk')

    const durable = window.localStorage.getItem('wework.plugins.codexReadState.v2')
    expect(durable).toBeTruthy()
    // Simulate app restart: drop memory, keep durable localStorage.
    clearLocalCodexPluginsReadStateCache()
    window.localStorage.setItem('wework.plugins.codexReadState.v2', durable!)

    const peeked = peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })
    expect(peeked?.installedPlugins[0]?.spec.components.connectors?.[0]?.localAuth).toEqual(
      expect.objectContaining({
        kind: 'browser_oauth',
        health: ['auth', 'health'],
        start: ['auth', 'login'],
      })
    )
    // Heavy skill payloads stay out of durable storage.
    expect(peeked?.installedPlugins[0]?.spec.components.skills).toEqual([])
  })

  test('durable localStorage snapshot strips heavy component payloads', async () => {
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
                name: 'openai-curated-remote',
                path: null,
                interface: { displayName: 'OpenAI' },
                plugins: [
                  {
                    id: 'gmail',
                    name: 'gmail',
                    installed: false,
                    enabled: false,
                    interface: {
                      displayName: 'Gmail',
                      shortDescription: 'Read and manage Gmail',
                      category: 'Communication',
                      longDescription: 'A'.repeat(4000),
                      screenshots: ['https://example.com/a.png', 'https://example.com/b.png'],
                      logoUrl: 'https://files.openai.com/gmail.png',
                    },
                  },
                ],
              },
            ],
          }
        }
        if (params.method === 'plugin/installed') {
          return { marketplaces: [] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })
    const raw = window.localStorage.getItem('wework.plugins.codexReadState.v2')
    expect(raw).toBeTruthy()
    const persisted = JSON.parse(raw!) as {
      entries: Record<string, { state: { marketplaceItems: Array<Record<string, unknown>> } }>
    }
    const item = Object.values(persisted.entries)[0]?.state.marketplaceItems[0]
    expect(item).toMatchObject({
      name: 'gmail',
      interface: expect.objectContaining({
        displayName: 'Gmail',
        category: 'Communication',
        logo: 'https://files.openai.com/gmail.png',
      }),
    })
    expect(item?.components).toEqual(
      expect.objectContaining({
        skills: [],
        commands: [],
      })
    )
    expect((item?.interface as { longDescription?: string } | null)?.longDescription).toBeFalsy()
    expect((item?.interface as { screenshots?: string[] } | null)?.screenshots).toBeFalsy()
  })

  test('migrates a legacy sessionStorage snapshot into localStorage', async () => {
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })
    const raw = window.localStorage.getItem('wework.plugins.codexReadState.v2')
    expect(raw).toBeTruthy()

    clearLocalCodexPluginsReadStateCache()
    window.sessionStorage.setItem('wework.plugins.codexReadState.v2', raw!)

    expect(peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.deviceId).toBe(
      'local-device'
    )
    expect(window.localStorage.getItem('wework.plugins.codexReadState.v2')).toBeTruthy()
    expect(window.sessionStorage.getItem('wework.plugins.codexReadState.v2')).toBeNull()
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

    const durableKey = 'wework.plugins.codexReadState.v2'
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

  test('resolves relative package logos against the local marketplace plugin root', async () => {
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
                name: 'openai-curated',
                path: '/tmp/codex/.tmp/plugins/openai-curated',
                interface: { displayName: 'OpenAI Official' },
                plugins: [
                  {
                    id: 'gmail@openai-curated',
                    name: 'gmail',
                    installed: false,
                    enabled: false,
                    source: { source: 'local', path: './plugins/gmail' },
                    interface: {
                      displayName: 'Gmail',
                      developerName: 'OpenAI',
                      logo: './assets/logo.png',
                      logoDark: './assets/logo-dark.png',
                    },
                  },
                ],
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
    const state = await api.readState({ mergeAllMarketplaces: true })
    expect(state.marketplaceItems).toEqual([
      expect.objectContaining({
        name: 'gmail',
        interface: expect.objectContaining({
          logo: '/tmp/codex/.tmp/plugins/openai-curated/plugins/gmail/assets/logo.png',
          logoDark: '/tmp/codex/.tmp/plugins/openai-curated/plugins/gmail/assets/logo-dark.png',
        }),
      }),
    ])
  })

  test('maps DISABLED_BY_ADMIN availability and disabledReason onto marketplace items', async () => {
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
          return {
            marketplaces: [
              {
                name: 'openai-curated-remote',
                path: null,
                interface: { displayName: 'OpenAI' },
                plugins:
                  params.method === 'plugin/installed'
                    ? []
                    : [
                        {
                          id: 'gmail@openai-curated-remote',
                          remotePluginId: 'plugin_connector_1p_95d39881713c8191931482a62d6edff9',
                          name: 'gmail',
                          installed: false,
                          enabled: false,
                          availability: 'DISABLED_BY_ADMIN',
                          disabledReason: 'plan_not_eligible',
                          installPolicy: 'NOT_AVAILABLE',
                          source: { type: 'remote' },
                          interface: { displayName: 'Gmail' },
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
    const state = await api.readState({ mergeAllMarketplaces: true })
    expect(state.marketplaceItems).toEqual([
      expect.objectContaining({
        name: 'gmail',
        manifest: expect.objectContaining({
          availability: 'DISABLED_BY_ADMIN',
          disabledReason: 'plan_not_eligible',
          installPolicy: 'NOT_AVAILABLE',
        }),
      }),
    ])
  })

  test('installs OpenAI remote Gmail with connector-style remotePluginId from plugin/read', async () => {
    const installCalls: Array<Record<string, unknown>> = []
    const remotePluginId = 'plugin_connector_1p_95d39881713c8191931482a62d6edff9'
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
          params?: Record<string, unknown>
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list' || params.method === 'plugin/installed') {
          const installed = installCalls.length > 0
          const plugin = {
            id: 'gmail@openai-curated-remote',
            name: 'gmail',
            installed,
            enabled: installed,
            source: { type: 'remote' },
            interface: { displayName: 'Gmail' },
          }
          return {
            marketplaces: [
              {
                name: 'openai-curated-remote',
                path: null,
                interface: { displayName: 'OpenAI' },
                plugins:
                  params.method === 'plugin/installed' ? (installed ? [plugin] : []) : [plugin],
              },
            ],
          }
        }
        if (params.method === 'plugin/install') {
          const pluginName = String(params.params?.pluginName ?? '')
          installCalls.push(params.params ?? {})
          if (pluginName !== remotePluginId) {
            throw new Error(`unexpected plugin id ${pluginName}`)
          }
          return {}
        }
        if (params.method === 'plugin/read') {
          return {
            plugin: {
              marketplaceName: 'openai-curated-remote',
              marketplacePath: null,
              summary: {
                id: 'gmail@openai-curated-remote',
                remotePluginId,
                name: 'gmail',
                installed: installCalls.length > 0,
                enabled: installCalls.length > 0,
                source: { type: 'remote' },
                interface: { displayName: 'Gmail' },
              },
              description: '',
              skills: [],
              hooks: [],
              apps: [],
              agents: [],
              mcps: [],
              connectors: [],
            },
          }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    const state = await api.readState({ mergeAllMarketplaces: true })
    const gmail = state.marketplaceItems.find(item => item.name === 'gmail')
    expect(gmail?.remotePluginId).toBe('')
    await api.installAvailablePlugin(String(gmail?.id), 'openai-curated-remote')

    expect(installCalls).toEqual([
      {
        marketplacePath: null,
        remoteMarketplaceName: 'openai-curated-remote',
        pluginName: remotePluginId,
      },
    ])
  })

  test('installs OpenAI remote plugins using list remotePluginId without bare-name fallback first', async () => {
    const installCalls: string[] = []
    const remotePluginId = 'plugin_connector_1p_1a69035c238881919c4190932b2df699'
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
          params?: Record<string, unknown>
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list' || params.method === 'plugin/installed') {
          const installed = installCalls.length > 0
          const plugin = {
            id: 'github@openai-curated-remote',
            remotePluginId,
            name: 'github',
            installed,
            enabled: installed,
            source: { type: 'remote' },
            interface: { displayName: 'GitHub' },
          }
          return {
            marketplaces: [
              {
                name: 'openai-curated-remote',
                path: null,
                interface: { displayName: 'OpenAI' },
                plugins:
                  params.method === 'plugin/installed' ? (installed ? [plugin] : []) : [plugin],
              },
            ],
          }
        }
        if (params.method === 'plugin/install') {
          installCalls.push(String(params.params?.pluginName ?? ''))
          return {}
        }
        if (params.method === 'plugin/read') {
          return {
            plugin: {
              marketplaceName: 'openai-curated-remote',
              marketplacePath: null,
              summary: {
                id: 'github@openai-curated-remote',
                remotePluginId,
                name: 'github',
                installed: true,
                enabled: true,
                source: { type: 'remote' },
                interface: { displayName: 'GitHub' },
              },
              description: '',
              skills: [],
              hooks: [],
              apps: [],
              agents: [],
              mcps: [],
              connectors: [],
            },
          }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    const state = await api.readState({ mergeAllMarketplaces: true })
    const github = state.marketplaceItems.find(item => item.name === 'github')
    expect(github?.remotePluginId).toBe(remotePluginId)
    await api.installAvailablePlugin(String(github?.id), 'openai-curated-remote')
    expect(installCalls).toEqual([remotePluginId])
  })

  test('uninstalls remote OpenAI plugins by remotePluginId as well as catalog id', async () => {
    const uninstalledIds: string[] = []
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
          params?: Record<string, unknown>
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list' || params.method === 'plugin/installed') {
          const installed = !uninstalledIds.includes('plugin_connector_1p_github')
          const plugin = {
            id: 'github@openai-curated-remote',
            remotePluginId: 'plugin_connector_1p_github',
            name: 'github',
            installed,
            enabled: installed,
            source: { type: 'remote' },
            interface: { displayName: 'GitHub' },
          }
          return {
            marketplaces: [
              {
                name: 'openai-curated-remote',
                path: 'openai-curated-remote',
                interface: { displayName: 'OpenAI Curated Remote' },
                // plugin/installed only returns membership rows.
                plugins:
                  params.method === 'plugin/installed' ? (installed ? [plugin] : []) : [plugin],
              },
            ],
          }
        }
        if (params.method === 'plugin/uninstall') {
          const pluginId = String(params.params?.pluginId ?? '')
          if (
            pluginId !== 'github@openai-curated-remote' &&
            pluginId !== 'plugin_connector_1p_github' &&
            pluginId !== 'github'
          ) {
            throw new Error(`Unexpected plugin id ${pluginId}`)
          }
          // Catalog ids alone must not clear the remote install; only the
          // connector-style remotePluginId does.
          if (pluginId === 'plugin_connector_1p_github') {
            uninstalledIds.push(pluginId)
          }
          return {}
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })
    await api.uninstallInstalledPlugin('github@openai-curated-remote')
    expect(uninstalledIds).toContain('plugin_connector_1p_github')

    const after = await api.readState({ mergeAllMarketplaces: true, refresh: true })
    expect(after.marketplaceItems).toEqual([
      expect.objectContaining({ name: 'github', installed: false }),
    ])
    expect(after.installedPlugins).toEqual([])
  })

  test('uninstalls local marketplace plugins without requiring remote catalog auth', async () => {
    const uninstallAttempts: string[] = []
    let installed = true
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
          params?: Record<string, unknown>
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list' || params.method === 'plugin/installed') {
          // Mirror CI: Codex may return a bare local plugin id. Bare alphanumeric ids
          // are treated as remote ChatGPT plugin ids by plugin/uninstall.
          const plugin = {
            id: 'desktop-e2e-plugin',
            name: 'desktop-e2e-plugin',
            installed,
            enabled: installed,
            source: { source: 'local', path: './plugins/desktop-e2e-plugin' },
            interface: { displayName: 'Desktop E2E Plugin', category: 'Developer Tools' },
          }
          return {
            marketplaces: [
              {
                name: 'desktop-e2e-marketplace',
                path: '/tmp/desktop-e2e-marketplace',
                interface: { displayName: 'Desktop E2E Marketplace' },
                plugins:
                  params.method === 'plugin/installed' ? (installed ? [plugin] : []) : [plugin],
              },
            ],
          }
        }
        if (params.method === 'plugin/uninstall') {
          const pluginId = String(params.params?.pluginId ?? '')
          uninstallAttempts.push(pluginId)
          if (/^[A-Za-z0-9_~-]+$/.test(pluginId)) {
            throw new Error(
              'resolve remote plugin before uninstall: chatgpt authentication required for remote plugin catalog'
            )
          }
          if (pluginId.includes(':')) {
            throw new Error('invalid remote plugin id')
          }
          if (pluginId === 'desktop-e2e-plugin@desktop-e2e-marketplace') {
            installed = false
            return {}
          }
          throw new Error(`not found: ${pluginId}`)
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    const before = await api.readState({ mergeAllMarketplaces: true })
    expect(before.marketplaceItems[0]).toEqual(
      expect.objectContaining({
        id: 'desktop-e2e-marketplace:desktop-e2e-plugin',
        installed: true,
        installedPluginId: 'desktop-e2e-plugin',
      })
    )

    // UI uninstalls via installedPluginId (bare) or namespaced catalog id.
    await api.uninstallInstalledPlugin('desktop-e2e-plugin')
    expect(uninstallAttempts).toEqual(['desktop-e2e-plugin@desktop-e2e-marketplace'])
    expect(uninstallAttempts).not.toContain('desktop-e2e-plugin')

    const after = await api.readState({ mergeAllMarketplaces: true, refresh: true })
    expect(after.marketplaceItems).toEqual([
      expect.objectContaining({ name: 'desktop-e2e-plugin', installed: false }),
    ])
    expect(after.installedPlugins).toEqual([])
  })

  test('maps remote OpenAI catalog logoUrl fields onto renderable logo assets', async () => {
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
                name: 'openai-curated-remote',
                path: 'openai-curated-remote',
                interface: { displayName: 'OpenAI Curated Remote' },
                plugins: [
                  {
                    id: 'gmail@openai-curated-remote',
                    name: 'gmail',
                    installed: false,
                    enabled: false,
                    source: { type: 'remote' },
                    interface: {
                      displayName: 'Gmail',
                      developerName: 'OpenAI',
                      logo: null,
                      logoDark: null,
                      composerIcon: null,
                      logoUrl: 'https://files.openai.com/content?id=gmail-logo',
                      logoUrlDark: 'https://files.openai.com/content?id=gmail-logo-dark',
                      composerIconUrl: 'https://files.openai.com/content?id=gmail-icon',
                    },
                  },
                ],
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
    const state = await api.readState({ mergeAllMarketplaces: true })
    expect(state.marketplaceItems).toEqual([
      expect.objectContaining({
        name: 'gmail',
        interface: expect.objectContaining({
          logo: 'https://files.openai.com/content?id=gmail-logo',
          logoDark: 'https://files.openai.com/content?id=gmail-logo-dark',
          composerIcon: 'https://files.openai.com/content?id=gmail-icon',
        }),
      }),
    ])
  })

  test('marks featuredPluginIds from plugin/list on marketplace items', async () => {
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
            featuredPluginIds: ['gmail', 'github@openai-curated-remote'],
            marketplaces: [
              {
                name: 'openai-curated-remote',
                path: null,
                interface: { displayName: 'OpenAI' },
                plugins: [
                  {
                    id: 'gmail',
                    name: 'gmail',
                    installed: false,
                    enabled: false,
                    interface: {
                      displayName: 'Gmail',
                      category: 'Communication',
                    },
                  },
                  {
                    id: 'github',
                    name: 'github',
                    installed: false,
                    enabled: false,
                    interface: {
                      displayName: 'GitHub',
                      category: 'Developer Tools',
                    },
                  },
                  {
                    id: 'notion',
                    name: 'notion',
                    installed: false,
                    enabled: false,
                    interface: {
                      displayName: 'Notion',
                      category: 'Productivity',
                    },
                  },
                ],
              },
            ],
          }
        }
        if (params.method === 'plugin/installed') {
          return { marketplaces: [] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    const state = await api.readState({ mergeAllMarketplaces: true })
    expect(
      state.marketplaceItems.map(item => ({ name: item.name, featured: item.featured }))
    ).toEqual([
      { name: 'gmail', featured: true },
      { name: 'github', featured: true },
      { name: 'notion', featured: false },
    ])
  })
})
