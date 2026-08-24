import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
  installedPluginMatchesImportedPersonalPlugin,
  peekLocalCodexPluginsReadState,
  warmLocalCodexPluginsReadState,
} from './codexPlugins'

const mocks = vi.hoisted(() => ({
  requestLocalExecutor: vi.fn(),
  ensureLocalExecutorStarted: vi.fn(),
  ensureBundledPluginMarketplaceRegistered: vi.fn(),
  getInitializedBundledPluginMarketplace: vi.fn(() => null),
  runtime: {
    desktop: true,
    electron: true,
  },
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => mocks.runtime.desktop,
  isElectronRuntime: () => mocks.runtime.electron,
}))

vi.mock('@/desktop/localExecutor', () => ({
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
    mocks.runtime.desktop = true
    mocks.runtime.electron = true
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
        if (method === 'executor.plugins.links.list') return []
        if (method === 'executor.plugins.personal.ensure') {
          return {
            pluginName: 'dev-tools',
            marketplacePath: '/tmp/wework-personal',
            pluginPath: '/tmp/wework-personal/plugins/dev-tools',
            migrated: false,
          }
        }
        if (method === 'executor.plugins.links.link') return null
        if (method === 'executor.plugins.links.unlink') return null
        if (method === 'executor.plugins.store.list') {
          return { storePath: '/tmp/store/plugins', plugins: [] }
        }
        if (method === 'executor.plugins.personal.delete') return null
        if (method !== 'codex.app_server_request')
          throw new Error(`Unexpected executor method ${method}`)
        if (params.method === 'plugin/list' || params.method === 'plugin/installed') {
          return { marketplaces: [personalMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('loads Codex marketplaces through Executor in Electron desktop runtime', async () => {
    const state = await createLocalCodexPluginApi().readState({
      mergeAllMarketplaces: true,
      refresh: true,
    })

    expect(state.marketplaces).toEqual([
      expect.objectContaining({
        id: 'wework-personal',
      }),
    ])
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith('codex.app_server_request', {
      method: 'plugin/installed',
      params: {
        cwds: null,
        installSuggestionPluginNames: null,
      },
    })
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith('codex.app_server_request', {
      method: 'plugin/list',
      params: {
        cwds: null,
      },
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
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith('executor.plugins.links.link', {
      marketplacePath: '/tmp/wework-personal',
      localPluginName: 'dev-tools',
      cloudPluginId: 71,
      cloudReleaseId: 82,
    })
  })

  test('deletes a personal plugin through the managed marketplace command', async () => {
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })

    await api.deletePersonalPlugin('dev-tools')

    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith('executor.plugins.personal.delete', {
      marketplacePath: '/tmp/wework-personal',
      pluginName: 'dev-tools',
    })
  })

  test('deletes a legacy personal plugin from its source marketplace', async () => {
    const api = createLocalCodexPluginApi()

    await api.deletePersonalPlugin('quality-gate', '/Users/test/.agents/plugins/marketplace.json')

    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith('executor.plugins.personal.delete', {
      marketplacePath: '/Users/test/.agents/plugins/marketplace.json',
      pluginName: 'quality-gate',
    })
  })

  test('previews plugin ZIPs against the managed personal marketplace', async () => {
    mocks.getInitializedBundledPluginMarketplace.mockReturnValue({
      id: 'wework-personal',
      path: '/tmp/wework-personal',
      pluginCount: 0,
    })
    const preview = {
      valid: false,
      archivePath: '/tmp/wrapped.zip',
      sha256: 'a'.repeat(64),
      name: '',
      displayName: '',
      version: '',
      description: '',
      skillCount: 0,
      mcpServerCount: 0,
      executableCapabilities: [],
      existing: false,
      existingVersion: null,
      issues: [{ code: 'manifest_not_at_root', path: null, message: 'nested manifest' }],
    }
    mocks.requestLocalExecutor.mockImplementation(async (method: string) => {
      if (method === 'executor.plugins.import_package.preview') return preview
      throw new Error(`Unexpected executor method ${method}`)
    })
    const api = createLocalCodexPluginApi()

    await expect(api.previewPluginImport('/tmp/wrapped.zip')).resolves.toEqual(preview)
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith(
      'executor.plugins.import_package.preview',
      {
        archivePath: '/tmp/wrapped.zip',
        marketplacePath: '/tmp/wework-personal',
      }
    )
  })

  test('rolls back imported files when App Server installation fails', async () => {
    const preview = {
      valid: true,
      archivePath: '/tmp/example-plugin.zip',
      sha256: 'b'.repeat(64),
      name: 'example-plugin',
      displayName: 'Example Plugin',
      version: '1.0.0',
      description: 'Example plugin',
      skillCount: 1,
      mcpServerCount: 0,
      executableCapabilities: [],
      existing: false,
      existingVersion: null,
      issues: [],
    }
    mocks.requestLocalExecutor.mockImplementation(
      async (method: string, params: { method?: string }) => {
        if (method === 'executor.plugins.import_package') {
          return {
            pluginName: 'example-plugin',
            displayName: 'Example Plugin',
            version: '1.0.0',
            marketplacePath: '/tmp/wework-personal',
            pluginPath: '/tmp/wework-personal/plugins/example-plugin',
            rollbackId: 'rollback-1',
          }
        }
        if (method === 'executor.plugins.import_package.rollback') return null
        if (method === 'runtime.codex.plugin.install_local_first') {
          throw new Error('install rejected')
        }
        if (method === 'codex.app_server_request' && params.method === 'plugin/list') {
          return { marketplaces: [personalMarketplace] }
        }
        if (method === 'codex.app_server_request' && params.method === 'plugin/installed') {
          return { marketplaces: [personalMarketplace] }
        }
        throw new Error(`Unexpected executor method ${method}`)
      }
    )
    const api = createLocalCodexPluginApi()

    await expect(api.importPluginPackage(preview, false)).rejects.toThrow(
      'Plugin package installation failed: install rejected'
    )
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith(
      'executor.plugins.import_package.rollback',
      {
        marketplacePath: '/tmp/wework-personal',
        rollbackId: 'rollback-1',
      }
    )
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith(
      'runtime.codex.plugin.install_local_first',
      {
        marketplacePath: '/tmp/wework-personal/.agents/plugins/marketplace.json',
        pluginName: 'example-plugin',
      }
    )
  })

  test('does not roll back when local commit may still complete after a timeout', async () => {
    const preview = {
      valid: true,
      archivePath: '/tmp/example-plugin.zip',
      sha256: 'd'.repeat(64),
      name: 'example-plugin',
      displayName: 'Example Plugin',
      version: '1.0.0',
      description: 'Example plugin',
      skillCount: 1,
      mcpServerCount: 0,
      executableCapabilities: [],
      existing: false,
      existingVersion: null,
      issues: [],
    }
    mocks.requestLocalExecutor.mockImplementation(
      async (method: string, params: { method?: string }) => {
        if (method === 'executor.plugins.import_package') {
          return {
            pluginName: 'example-plugin',
            displayName: 'Example Plugin',
            version: '1.0.0',
            marketplacePath: '/tmp/wework-personal',
            pluginPath: '/tmp/wework-personal/plugins/example-plugin',
            rollbackId: 'rollback-timeout',
          }
        }
        if (method === 'runtime.codex.plugin.install_local_first') {
          throw new Error('local_plugin_commit_timeout: still committing')
        }
        if (method === 'codex.app_server_request' && params.method === 'plugin/list') {
          return { marketplaces: [personalMarketplace] }
        }
        if (method === 'codex.app_server_request' && params.method === 'plugin/installed') {
          return { marketplaces: [personalMarketplace] }
        }
        throw new Error(`Unexpected executor method ${method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    await expect(api.importPluginPackage(preview, false)).rejects.toThrow(
      'local_plugin_commit_timeout'
    )
    expect(mocks.requestLocalExecutor).not.toHaveBeenCalledWith(
      'executor.plugins.import_package.rollback',
      expect.anything()
    )
  })

  test('finalizes the import as soon as its local installation is committed', async () => {
    const preview = {
      valid: true,
      archivePath: '/tmp/example-plugin.zip',
      sha256: 'c'.repeat(64),
      name: 'example-plugin',
      displayName: 'Example Plugin',
      version: '1.0.0',
      description: 'Example plugin',
      skillCount: 1,
      mcpServerCount: 0,
      executableCapabilities: [],
      existing: false,
      existingVersion: null,
      issues: [],
    }
    mocks.requestLocalExecutor.mockImplementation(
      async (method: string, params: { method?: string }) => {
        if (method === 'executor.plugins.import_package') {
          return {
            pluginName: 'example-plugin',
            displayName: 'Example Plugin',
            version: '1.0.0',
            marketplacePath: '/tmp/wework-personal',
            pluginPath: '/tmp/wework-personal/plugins/example-plugin',
            rollbackId: 'rollback-verify',
          }
        }
        if (method === 'executor.plugins.import_package.rollback') return null
        if (method === 'executor.plugins.import_package.finalize') return null
        if (method === 'runtime.codex.plugin.install_local_first') {
          return {
            pluginKey: 'example-plugin@wework-personal',
            localCommitted: true,
            authenticationPending: true,
          }
        }
        if (method === 'codex.app_server_request' && params.method === 'plugin/list') {
          return { marketplaces: [personalMarketplace] }
        }
        if (method === 'codex.app_server_request' && params.method === 'plugin/installed') {
          return { marketplaces: [personalMarketplace] }
        }
        throw new Error(`Unexpected executor method ${method}`)
      }
    )
    const api = createLocalCodexPluginApi()

    await expect(api.importPluginPackage(preview, false)).resolves.toEqual({
      pluginName: 'example-plugin',
      displayName: 'Example Plugin',
      version: '1.0.0',
    })
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith(
      'executor.plugins.import_package.finalize',
      {
        marketplacePath: '/tmp/wework-personal',
        rollbackId: 'rollback-verify',
      }
    )
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith(
      'runtime.codex.plugin.install_local_first',
      {
        marketplacePath: '/tmp/wework-personal/.agents/plugins/marketplace.json',
        pluginName: 'example-plugin',
      }
    )
  })

  test('matches an imported plugin only in the Wework personal marketplace', () => {
    expect(installedPluginMatchesImportedPersonalPlugin(createdPlugin, 'dev-tools')).toBe(true)
    const otherMarketplacePlugin: InstalledPlugin = {
      ...createdPlugin,
      metadata: { ...createdPlugin.metadata, namespace: 'other-marketplace' },
      spec: {
        ...createdPlugin.spec,
        source: {
          ...createdPlugin.spec.source,
          providerKey: 'other-marketplace',
          marketplace: 'other-marketplace',
        },
        sourcePayload: {
          ...createdPlugin.spec.sourcePayload,
          marketplaceName: 'other-marketplace',
        },
      },
    }

    expect(installedPluginMatchesImportedPersonalPlugin(otherMarketplacePlugin, 'dev-tools')).toBe(
      false
    )
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

  test('an older refresh resolves with the newer canonical marketplace snapshot', async () => {
    const currentMarketplace = {
      name: 'desktop-e2e-openai-official',
      path: '/tmp/desktop-e2e-openai-official',
      interface: { displayName: 'Desktop E2E OpenAI Official' },
      plugins: [
        {
          id: 'openai-developers',
          name: 'openai-developers',
          interface: { displayName: 'OpenAI Developers' },
        },
      ],
    }
    let pluginListRequestCount = 0
    let resolveOlderList: ((value: unknown) => void) | null = null
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
        if (params.method === 'plugin/installed') {
          return { marketplaces: [personalMarketplace] }
        }
        if (params.method === 'plugin/list') {
          pluginListRequestCount += 1
          if (pluginListRequestCount === 1) {
            return await new Promise(resolve => {
              resolveOlderList = resolve
            })
          }
          return { marketplaces: [personalMarketplace, currentMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    const older = api.readState({ mergeAllMarketplaces: true, refresh: true })
    await vi.waitFor(() => expect(pluginListRequestCount).toBe(1))

    const current = await api.readState({ mergeAllMarketplaces: true, refresh: true })
    expect(current.marketplaces.map(marketplace => marketplace.id)).toContain(
      'desktop-e2e-openai-official'
    )

    resolveOlderList?.({ marketplaces: [personalMarketplace] })
    const resolvedOlder = await older
    expect(resolvedOlder.marketplaces.map(marketplace => marketplace.id)).toContain(
      'desktop-e2e-openai-official'
    )
  })

  test('retains the cached OpenAI catalog when a refresh omits that marketplace', async () => {
    const openAiMarketplace = {
      name: 'openai-curated-remote',
      path: 'openai-curated-remote',
      interface: { displayName: 'OpenAI' },
      plugins: [
        {
          id: 'gmail',
          name: 'gmail',
          version: '1.0.0',
          description: 'Gmail',
          interface: { displayName: 'Gmail' },
        },
      ],
    }
    let listMarketplaces = [openAiMarketplace]
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
        if (params.method === 'plugin/list') return { marketplaces: listMarketplaces }
        if (params.method === 'plugin/installed') return { marketplaces: [] }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })

    // A just-resumed app-server can return a successful but partial list before
    // its remote OpenAI marketplace has been restored.
    listMarketplaces = []
    const refreshed = await api.readState({ mergeAllMarketplaces: true, refresh: true })

    expect(refreshed.marketplaceItems.map(item => item.name)).toEqual(['gmail'])
    expect(refreshed.marketplaces.map(marketplace => marketplace.id)).toContain(
      'openai-curated-remote'
    )
    expect(
      peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.marketplaceItems.map(
        item => item.name
      )
    ).toEqual(['gmail'])
  })

  test('retains the cached OpenAI catalog when the refreshed marketplace is temporarily empty', async () => {
    const openAiMarketplace = {
      name: 'openai-curated-remote',
      path: 'openai-curated-remote',
      interface: { displayName: 'OpenAI' },
      plugins: [
        {
          id: 'gmail',
          name: 'gmail',
          version: '1.0.0',
          description: 'Gmail',
          interface: { displayName: 'Gmail' },
        },
      ],
    }
    let listMarketplaces = [openAiMarketplace]
    mocks.requestLocalExecutor.mockImplementation(
      async (method: string, params: { method?: string }) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list') return { marketplaces: listMarketplaces }
        if (params.method === 'plugin/installed') return { marketplaces: [] }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })

    listMarketplaces = [{ ...openAiMarketplace, plugins: [] }]
    const refreshed = await api.readState({ mergeAllMarketplaces: true, refresh: true })

    expect(refreshed.marketplaceItems.map(item => item.name)).toEqual(['gmail'])
    expect(
      peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.marketplaceItems.map(
        item => item.name
      )
    ).toEqual(['gmail'])
  })

  test('keeps the durable OpenAI catalog after an idempotent personal plugin reconcile', async () => {
    const openAiMarketplace = {
      name: 'openai-curated-remote',
      path: 'openai-curated-remote',
      interface: { displayName: 'OpenAI' },
      plugins: [
        {
          id: 'gmail',
          name: 'gmail',
          installed: false,
          enabled: false,
          interface: { displayName: 'Gmail' },
        },
      ],
    }
    const codexPersonalMarketplace = {
      name: 'personal',
      path: '/tmp/personal',
      interface: { displayName: 'Personal' },
      plugins: [
        {
          id: 'dev-tools',
          name: 'dev-tools',
          installed: true,
          enabled: true,
          interface: { displayName: 'Dev Tools' },
        },
      ],
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
            marketplaces: [openAiMarketplace, codexPersonalMarketplace, personalMarketplace],
          }
        }
        if (params.method === 'plugin/installed') {
          return { marketplaces: [codexPersonalMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const state = await createLocalCodexPluginApi().readState({ mergeAllMarketplaces: true })

    expect(state.marketplaceItems.map(item => item.name)).toContain('gmail')
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith(
      'executor.plugins.personal.ensure',
      expect.any(Object)
    )
    const durable = window.localStorage.getItem('wework.plugins.codexReadState.v2')
    expect(durable).toBeTruthy()
    expect(durable).toContain('gmail')
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
    expect(peeked?.installedPlugins[0]?.spec.components.skills).toEqual([
      { name: 'dingtalk', description: 'skill', path: 'dingtalk' },
    ])
  })

  test('readInstalledPluginForTrial resolves cloud numeric ids to local plugin@marketplace', async () => {
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
                name: 'wegent',
                path: '/tmp/wegent',
                interface: { displayName: 'wegent' },
                plugins: [
                  {
                    id: 'documents@wegent',
                    name: 'documents',
                    installed: true,
                    enabled: true,
                    interface: { displayName: 'Documents' },
                  },
                ],
              },
            ],
          }
        }
        if (params.method === 'plugin/read') {
          return {
            plugin: {
              summary: {
                id: 'documents@wegent',
                name: 'documents',
                installed: true,
                enabled: true,
                interface: { displayName: 'Documents' },
              },
              description: 'Documents',
              skills: [{ name: 'documents', description: 'skill', path: 'skills/documents' }],
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
    await api.readState({ mergeAllMarketplaces: true })
    const detailed = await api.readInstalledPluginForTrial('documents@wegent')
    expect(detailed.spec.source.pluginKey).toBe('documents')
    expect(detailed.spec.components.skills.length).toBeGreaterThan(0)
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

  test('readMarketplacePluginDetail uses plugin/read without waiting on plugin/list', async () => {
    window.localStorage.setItem(
      'wework.plugins.codexReadState.v2',
      JSON.stringify({
        version: 2,
        entries: {
          '|all': {
            paramsKey: '|all',
            cachedAt: Date.now(),
            state: {
              marketplaceItems: [],
              installedPlugins: [],
              marketplaces: [{ id: 'openai-curated-remote', name: 'OpenAI', path: null }],
              selectedMarketplaceId: 'openai-curated-remote',
              marketplacePath: '',
              installRegistryPath: '',
              deviceId: 'local-device',
            },
          },
        },
      })
    )
    let pluginListCalls = 0
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
          params?: { pluginName?: string; remoteMarketplaceName?: string | null }
        }
      ) => {
        if (method !== 'codex.app_server_request') {
          throw new Error(`Unexpected executor method ${method}`)
        }
        if (params.method === 'plugin/list') {
          pluginListCalls += 1
          throw new Error('plugin/list must not run for marketplace detail')
        }
        if (params.method === 'plugin/installed') {
          throw new Error('plugin/installed must not run for marketplace detail')
        }
        if (params.method === 'plugin/read') {
          expect(params.params?.pluginName).toBe('github')
          expect(params.params?.remoteMarketplaceName).toBe('openai-curated-remote')
          return {
            plugin: {
              marketplaceName: 'openai-curated-remote',
              summary: {
                id: 'github@openai-curated-remote',
                name: 'github',
                installed: true,
                enabled: true,
                interface: {
                  displayName: 'GitHub',
                  homepageUrl: 'https://github.com/',
                },
              },
              description: 'Triage PRs and CI',
              skills: [
                {
                  name: 'Review Follow-up',
                  description: 'Address actionable PR feedback.',
                  enabled: true,
                },
              ],
              apps: [
                {
                  id: 'github',
                  name: 'GitHub',
                  description: 'Access repositories, issues, and pull requests.',
                },
              ],
              hooks: [],
              connectors: [],
            },
          }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    const detailed = await api.readMarketplacePluginDetail('openai-curated-remote', 'github')
    expect(pluginListCalls).toBe(0)
    expect(detailed.spec.components.skills.map(skill => skill.name)).toEqual(['Review Follow-up'])
    expect(detailed.spec.components.apps?.map(app => app.name)).toEqual(['GitHub'])
    expect(detailed.spec.interface?.websiteUrl).toBe('https://github.com/')
  })

  test('durable localStorage snapshot drops oversized inlined plugin artwork', async () => {
    const oversizedLogo = `data:image/png;base64,${'a'.repeat(4097)}`
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
                    interface: {
                      displayName: 'Gmail',
                      logo: oversizedLogo,
                      logoDark: oversizedLogo,
                      composerIcon: oversizedLogo,
                    },
                  },
                ],
              },
            ],
          }
        }
        if (params.method === 'plugin/installed') return { marketplaces: [] }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    await createLocalCodexPluginApi().readState({ mergeAllMarketplaces: true })

    const raw = window.localStorage.getItem('wework.plugins.codexReadState.v2')
    const persisted = JSON.parse(raw!) as {
      entries: Record<
        string,
        { state: { marketplaceItems: Array<{ interface: Record<string, unknown> | null }> } }
      >
    }
    const interfaceData = Object.values(persisted.entries)[0]?.state.marketplaceItems[0]?.interface
    expect(interfaceData).toMatchObject({ displayName: 'Gmail' })
    expect(interfaceData?.logo).toBeNull()
    expect(interfaceData?.logoDark).toBeNull()
    expect(interfaceData?.composerIcon).toBeFalsy()
  })

  test('compacts an existing heavy v2 catalog before hydrating first paint', async () => {
    mocks.requestLocalExecutor.mockImplementation(
      async (method: string, params: { method?: string }) => {
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
                    interface: { displayName: 'Gmail' },
                  },
                ],
              },
            ],
          }
        }
        if (params.method === 'plugin/installed') return { marketplaces: [] }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })
    const storageKey = 'wework.plugins.codexReadState.v2'
    const raw = window.localStorage.getItem(storageKey)
    expect(raw).toBeTruthy()
    const heavy = JSON.parse(raw!) as {
      entries: Record<
        string,
        {
          state: {
            marketplaceItems: Array<{
              interface: Record<string, unknown> | null
            }>
          }
        }
      >
    }
    const item = heavy.entries['|all']?.state.marketplaceItems[0]
    expect(item).toBeTruthy()
    item!.interface = {
      displayName: 'Heavy plugin',
      shortDescription: 'Still needed for the card',
      longDescription: 'L'.repeat(100_000),
      logo: `data:image/png;base64,${'A'.repeat(100_000)}`,
    }
    const heavyRaw = JSON.stringify(heavy)

    clearLocalCodexPluginsReadStateCache()
    window.localStorage.setItem(storageKey, heavyRaw)
    const peeked = peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })
    const compactedRaw = window.localStorage.getItem(storageKey) ?? ''

    expect(peeked?.marketplaceItems[0]?.interface).toMatchObject({
      displayName: 'Heavy plugin',
      shortDescription: 'Still needed for the card',
      logo: null,
    })
    expect(peeked?.marketplaceItems[0]?.interface?.longDescription).toBeUndefined()
    expect(compactedRaw.length).toBeLessThan(heavyRaw.length / 10)
  })

  test('quota fallback preserves the merged catalog used by first paint', async () => {
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })
    const storageKey = 'wework.plugins.codexReadState.v2'
    const nativeSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key === storageKey) {
        const parsed = JSON.parse(value) as { entries?: Record<string, unknown> }
        if (Object.keys(parsed.entries ?? {}).length > 1) {
          throw new DOMException('Quota exceeded', 'QuotaExceededError')
        }
      }
      nativeSetItem.call(this, key, value)
    })

    await api.readState({ refresh: true })

    const persisted = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}') as {
      entries?: Record<string, unknown>
    }
    expect(persisted.entries?.['|all']).toBeTruthy()
    expect(persisted.entries?.['|selected']).toBeUndefined()
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

  test('readState finishes plugin/installed before starting plugin/list', async () => {
    const order: string[] = []
    let resolveInstalled: ((value: unknown) => void) | null = null
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
        if (params.method === 'plugin/installed') {
          order.push('installed-start')
          return await new Promise(resolve => {
            resolveInstalled = value => {
              order.push('installed-end')
              resolve(value)
            }
          })
        }
        if (params.method === 'plugin/list') {
          order.push('list-start')
          return { marketplaces: [personalMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const pending = createLocalCodexPluginApi().readState({ mergeAllMarketplaces: true })
    await vi.waitFor(() => expect(order).toEqual(['installed-start']))
    expect(order).not.toContain('list-start')

    resolveInstalled?.({ marketplaces: [personalMarketplace] })
    await pending
    expect(order).toEqual(['installed-start', 'installed-end', 'list-start'])
  })

  test('listInstalledPlugins shares in-flight plugin/installed and keeps plugin/list behind it', async () => {
    const order: string[] = []
    let resolveInstalled: ((value: unknown) => void) | null = null
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
        if (params.method === 'plugin/installed') {
          order.push('installed-start')
          return await new Promise(resolve => {
            resolveInstalled = value => {
              order.push('installed-end')
              resolve(value)
            }
          })
        }
        if (params.method === 'plugin/list') {
          order.push('list-start')
          return { marketplaces: [personalMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const api = createLocalCodexPluginApi()
    const listed = api.listInstalledPlugins({ refresh: true })
    const state = api.readState({ mergeAllMarketplaces: true, refresh: true })
    await vi.waitFor(() => expect(order).toEqual(['installed-start']))
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          (params as { method?: string }).method === 'plugin/installed'
      )
    ).toHaveLength(1)
    expect(order).not.toContain('list-start')

    resolveInstalled?.({
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
    })
    await expect(listed).resolves.toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({ metadata: expect.objectContaining({ name: 'dev-tools' }) }),
        ],
      })
    )
    await state
    expect(order).toEqual(['installed-start', 'installed-end', 'list-start'])
  })

  test('listInstalledPlugins can supersede an in-flight membership read', async () => {
    let installedRequestCount = 0
    let resolveFirstInstalled: ((value: unknown) => void) | null = null
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
        if (params.method !== 'plugin/installed') {
          throw new Error(`Unexpected app-server method ${params.method}`)
        }
        installedRequestCount += 1
        if (installedRequestCount === 1) {
          return await new Promise(resolve => {
            resolveFirstInstalled = resolve
          })
        }
        return {
          marketplaces: [
            {
              ...personalMarketplace,
              plugins: [
                {
                  name: 'current-plugin',
                  id: 'current-plugin',
                  installed: true,
                  enabled: true,
                  interface: { displayName: 'Current Plugin' },
                },
              ],
            },
          ],
        }
      }
    )

    const api = createLocalCodexPluginApi()
    const superseded = api.listInstalledPlugins({ refresh: true })
    await vi.waitFor(() => expect(installedRequestCount).toBe(1))

    const current = api.listInstalledPlugins({ refresh: true, shareInflight: false })
    await expect(current).resolves.toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            metadata: expect.objectContaining({ name: 'current-plugin' }),
          }),
        ],
      })
    )
    expect(installedRequestCount).toBe(2)

    resolveFirstInstalled?.({ marketplaces: [personalMarketplace] })
    await superseded
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

  test('listInstalledPlugins refresh bypasses a fresh peek and still skips plugin/list', async () => {
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })
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
          throw new Error('plugin/list must not run for listInstalledPlugins refresh')
        }
        if (params.method === 'plugin/installed') {
          return {
            marketplaces: [
              {
                ...personalMarketplace,
                plugins: [
                  {
                    name: 'live-membership',
                    id: 'live-membership',
                    installed: true,
                    enabled: true,
                    interface: { displayName: 'Live Membership' },
                  },
                ],
              },
            ],
          }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const listed = await api.listInstalledPlugins({ refresh: true })
    expect(listed.items.map(item => item.metadata.name)).toEqual(['live-membership'])
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

  test('listInstalledPlugins refresh treats an empty live membership as authoritative', async () => {
    const githubMarketplace = {
      name: 'openai-curated-remote',
      path: 'openai-curated-remote',
      interface: { displayName: 'OpenAI' },
      plugins: [
        {
          id: 'github@openai-curated-remote',
          remotePluginId: 'plugin_connector_1p_github',
          name: 'github',
          installed: true,
          enabled: true,
          interface: { displayName: 'GitHub' },
        },
      ],
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
        if (params.method === 'plugin/list' || params.method === 'plugin/installed') {
          return { marketplaces: [githubMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })
    expect(
      peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.installedPlugins.map(
        item => item.spec.source.pluginKey
      )
    ).toEqual(['github'])

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
          return { marketplaces: [] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const listed = await api.listInstalledPlugins({ refresh: true })
    expect(listed.items.map(item => item.spec.source.pluginKey)).toEqual([])
  })

  test('listInstalledPlugins refresh removes cached remote installs omitted by live membership', async () => {
    const githubMarketplace = {
      name: 'openai-curated-remote',
      path: 'openai-curated-remote',
      interface: { displayName: 'OpenAI' },
      plugins: [
        {
          id: 'github@openai-curated-remote',
          remotePluginId: 'plugin_connector_1p_github',
          name: 'github',
          installed: true,
          enabled: true,
          interface: { displayName: 'GitHub' },
        },
      ],
    }
    const bundledMarketplace = {
      name: 'openai-bundled',
      path: 'openai-bundled',
      interface: { displayName: 'Bundled' },
      plugins: [
        {
          id: 'documents@openai-bundled',
          remotePluginId: 'openai-documents',
          name: 'documents',
          installed: true,
          enabled: true,
          interface: { displayName: 'Documents' },
        },
      ],
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
        if (params.method === 'plugin/list' || params.method === 'plugin/installed') {
          return { marketplaces: [githubMarketplace, bundledMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })
    expect(
      peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.installedPlugins.map(
        item => item.spec.source.pluginKey
      )
    ).toEqual(['github', 'documents'])

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
            marketplaces: [bundledMarketplace, { ...githubMarketplace, plugins: [] }],
          }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const listed = await api.listInstalledPlugins({ refresh: true })
    expect(listed.items.map(item => item.spec.source.pluginKey)).toEqual(['documents'])
  })

  test('listInstalledPlugins refresh removes cached Wegent installs omitted by live membership', async () => {
    const githubMarketplace = {
      name: 'openai-curated-remote',
      path: 'openai-curated-remote',
      interface: { displayName: 'OpenAI' },
      plugins: [
        {
          id: 'github@openai-curated-remote',
          remotePluginId: 'plugin_connector_1p_github',
          name: 'github',
          installed: true,
          enabled: true,
          interface: { displayName: 'GitHub' },
        },
      ],
    }
    const wegentMarketplace = {
      name: 'wegent',
      path: '/tmp/wegent',
      interface: { displayName: 'wegent' },
      plugins: [
        {
          id: 'sina-email@wegent',
          name: 'sina-email',
          installed: true,
          enabled: true,
          interface: { displayName: '公司邮箱' },
        },
      ],
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
        if (params.method === 'plugin/list' || params.method === 'plugin/installed') {
          return { marketplaces: [githubMarketplace, wegentMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })
    expect(
      peekLocalCodexPluginsReadState({ mergeAllMarketplaces: true })?.installedPlugins.map(
        item => item.spec.source.pluginKey
      )
    ).toEqual(['github', 'sina-email'])

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
          return { marketplaces: [githubMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const listed = await api.listInstalledPlugins({ refresh: true })
    expect(listed.items.map(item => item.spec.source.pluginKey)).toEqual(['github'])
  })

  test('readState does not overlay cached installs onto an authoritative live catalog', async () => {
    const githubMarketplace = {
      name: 'openai-curated-remote',
      path: 'openai-curated-remote',
      interface: { displayName: 'OpenAI' },
      plugins: [
        {
          id: 'github@openai-curated-remote',
          remotePluginId: 'plugin_connector_1p_github',
          name: 'github',
          installed: true,
          enabled: true,
          interface: { displayName: 'GitHub' },
        },
      ],
    }
    const bundledMarketplace = {
      name: 'openai-bundled',
      path: 'openai-bundled',
      interface: { displayName: 'Bundled' },
      plugins: [
        {
          id: 'documents@openai-bundled',
          remotePluginId: 'openai-documents',
          name: 'documents',
          installed: true,
          enabled: true,
          interface: { displayName: 'Documents' },
        },
      ],
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
        if (params.method === 'plugin/list' || params.method === 'plugin/installed') {
          return { marketplaces: [githubMarketplace, bundledMarketplace] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })

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
                ...githubMarketplace,
                plugins: [{ ...githubMarketplace.plugins[0], installed: false, enabled: false }],
              },
              bundledMarketplace,
            ],
          }
        }
        if (params.method === 'plugin/installed') {
          return { marketplaces: [bundledMarketplace, { ...githubMarketplace, plugins: [] }] }
        }
        throw new Error(`Unexpected app-server method ${params.method}`)
      }
    )

    const state = await api.readState({ mergeAllMarketplaces: true, refresh: true })
    const github = state.marketplaceItems.find(item => item.name === 'github')
    expect(github?.installed).toBe(false)
    expect(github?.installedPluginId).toBeNull()
    expect(state.installedPlugins.map(item => item.spec.source.pluginKey)).toEqual(['documents'])
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

  test('uninstalls Wework personal plugins through Executor in Electron without Codex marketplace refresh', async () => {
    mocks.runtime.electron = true
    let installed = true
    mocks.requestLocalExecutor.mockImplementation(
      async (
        method: string,
        params: {
          method?: string
          pluginName?: string
        }
      ) => {
        if (method === 'executor.plugins.links.list') return []
        if (method === 'executor.plugins.links.unlink') {
          expect(params).toEqual({
            marketplacePath: '/tmp/wework-personal',
            localPluginName: 'dev-tools',
          })
          return null
        }
        if (method === 'runtime.codex.plugin.uninstall_local') {
          expect(params).toEqual({
            marketplacePath: '/tmp/wework-personal/.agents/plugins/marketplace.json',
            pluginName: 'dev-tools',
          })
          installed = false
          return {
            pluginKey: 'dev-tools@wework-personal',
            localCommitted: true,
          }
        }
        if (method === 'codex.app_server_request') {
          if (params.method === 'plugin/list' || params.method === 'plugin/installed') {
            return {
              marketplaces: [
                {
                  ...personalMarketplace,
                  plugins: installed
                    ? [
                        {
                          id: 'dev-tools@wework-personal',
                          name: 'dev-tools',
                          installed: true,
                          enabled: true,
                          source: { source: 'local', path: './plugins/dev-tools' },
                        },
                      ]
                    : [],
                },
              ],
            }
          }
          throw new Error(`Unexpected app-server method ${params.method}`)
        }
        throw new Error(`Unexpected executor method ${method}`)
      }
    )
    const api = createLocalCodexPluginApi()
    await api.readState({ mergeAllMarketplaces: true })
    mocks.requestLocalExecutor.mockClear()

    await api.uninstallInstalledPlugin('dev-tools@wework-personal')

    expect(mocks.requestLocalExecutor).toHaveBeenCalledTimes(2)
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith(
      'runtime.codex.plugin.uninstall_local',
      {
        marketplacePath: '/tmp/wework-personal/.agents/plugins/marketplace.json',
        pluginName: 'dev-tools',
      }
    )
    expect(mocks.requestLocalExecutor).toHaveBeenCalledWith('executor.plugins.links.unlink', {
      marketplacePath: '/tmp/wework-personal',
      localPluginName: 'dev-tools',
    })
    expect(
      mocks.requestLocalExecutor.mock.calls.some(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          ['plugin/uninstall', 'plugin/list'].includes(
            String((params as { method?: string }).method ?? '')
          )
      )
    ).toBe(false)
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
