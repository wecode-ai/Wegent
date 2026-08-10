import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import { clearLocalCodexPluginsReadStateCache, createLocalCodexPluginApi } from './codexPlugins'

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
})
