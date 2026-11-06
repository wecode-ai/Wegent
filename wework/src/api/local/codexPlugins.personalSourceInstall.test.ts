import type { PluginMarketplaceItem } from '@/types/api'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { clearLocalCodexPluginsReadStateCache, createLocalCodexPluginApi } from './codexPlugins'

const mocks = vi.hoisted(() => ({ request: vi.fn(), resume: vi.fn() }))
vi.mock('@/api/local/runtimeAuthStatus', () => ({
  getLocalCodexAuthStatus: vi.fn().mockResolvedValue({ sha256: 'test-account' }),
}))

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
  resumeBundledPluginUpdates: (...args: unknown[]) => mocks.resume(...args),
  getInitializedBundledPluginMarketplace: () => ({
    id: 'wework-personal',
    path: '/executor/personal',
  }),
  getKnownLocalExecutorDeviceId: () => 'device',
  requestLocalExecutor: (...args: unknown[]) => mocks.request(...args),
}))

const path = '/executor/personal'
const name = 'tianhe-direct'
const sourcePath = `${path}/plugins/${name}`
const source = {
  name,
  version: '1.1.1',
  pluginPath: sourcePath,
  marketplacePath: path,
}
const membership = {
  id: `${name}@wework-personal`,
  name,
  installed: true,
  enabled: true,
  localVersion: '1.1.1',
  source: { source: 'local', path: sourcePath },
}
const item = {
  id: 42,
  name,
  accessRole: 'owner',
  version: '1.0.0',
  visibility: 'personal',
  manifest: {},
  localPersonalSource: { marketplacePath: path, pluginName: name },
} as PluginMarketplaceItem
const nativeInstall = 'runtime.codex.plugin.install_local_first'

function fixture(
  options: {
    linkedId?: number
    missingLink?: boolean
    managedPath?: string
    failRead?: string
    pauseAt?: string
    pause?: Promise<void>
    installedMarketplacePath?: string
  } = {}
) {
  let committed = false
  mocks.request.mockImplementation(async (method: string, payload?: { method?: string }) => {
    if (method === options.pauseAt) await options.pause
    if (method === options.failRead) throw new Error(`Unavailable ${method}`)
    if (method === 'executor.codex_home.config.read')
      return { enabledPluginKeys: committed ? [membership.id] : [] }
    if (method === 'executor.plugins.personal.list')
      return { marketplaceId: 'wework-personal', marketplacePath: path, plugins: [source] }
    if (method === 'executor.plugins.links.list')
      return options.missingLink
        ? []
        : [{ localPluginName: name, cloudPluginId: options.linkedId ?? 42, cloudReleaseId: 8 }]
    if (method === 'executor.plugins.store.list')
      return {
        storePath: '/executor/store',
        plugins: options.managedPath
          ? [
              {
                packageId: 'managed-package',
                name,
                marketplace: 'wework-personal',
                version: '1.1.1',
                enabled: true,
                pluginPath: options.managedPath,
                cloudPluginId: 42,
                installedPluginId: 75,
              },
            ]
          : [],
      }
    if (method === nativeInstall) {
      committed = true
      return { pluginKey: membership.id, localCommitted: true }
    }
    if (method === 'executor.plugins.manifest.read') return {}
    if (method === 'codex.app_server_request' && payload?.method === 'plugin/installed')
      return {
        marketplaces: [
          {
            name: 'wework-personal',
            path: options.installedMarketplacePath ?? path,
            plugins: committed ? [membership] : [],
          },
        ],
      }
    if (method === 'codex.app_server_request' && payload?.method === 'plugin/read')
      return { plugin: { summary: membership, description: 'Author source', skills: [] } }
    throw new Error(`Unexpected request ${method}: ${payload?.method}`)
  })
}

beforeEach(() => {
  window.localStorage.clear()
  clearLocalCodexPluginsReadStateCache()
  mocks.request.mockReset()
  mocks.resume.mockReset()
  fixture()
})

describe('personal source reinstall', () => {
  test.each([path, '/alias/personal'])(
    'confirms installed source at the Executor-validated canonical root or selected alias: %s',
    async installedMarketplacePath => {
      fixture({ installedMarketplacePath })
      const selected = {
        ...item,
        localPersonalSource: { marketplacePath: '/alias/personal', pluginName: name },
      }

      const installed = await createLocalCodexPluginApi().installPersonalPluginSource(
        selected,
        () => true
      )

      expect(mocks.request).toHaveBeenCalledWith('executor.plugins.personal.list', {
        marketplacePath: '/alias/personal',
      })
      expect(mocks.request).toHaveBeenCalledWith(nativeInstall, {
        marketplacePath: `${path}/.agents/plugins/marketplace.json`,
        pluginName: name,
      })
      expect(installed.spec.sourcePayload?.cloudPluginId).toBe(42)
      expect(installed.spec.source.type).toBe('local')
    }
  )

  test('rejects an installed marketplace path that the Executor did not validate for this selection', async () => {
    fixture({ installedMarketplacePath: '/unrelated/personal' })

    await expect(
      createLocalCodexPluginApi().installPersonalPluginSource(
        {
          ...item,
          localPersonalSource: { marketplacePath: '/alias/personal', pluginName: name },
        },
        () => true
      )
    ).rejects.toThrow('Installed personal plugin source identity could not be confirmed')
  })

  test('uses the verified source and native commit, preserving cloud identity and local version', async () => {
    const installed = await createLocalCodexPluginApi().installPersonalPluginSource(
      item,
      () => true
    )

    expect(mocks.request).toHaveBeenCalledWith(nativeInstall, {
      marketplacePath: `${path}/.agents/plugins/marketplace.json`,
      pluginName: name,
    })
    expect(installed.spec.version).toBe('1.1.1')
    expect(installed.spec.sourcePayload).toMatchObject({ cloudPluginId: 42, cloudReleaseId: 8 })
    expect(installed.spec.source.type).toBe('local')
    expect(mocks.resume).toHaveBeenCalledWith(name)
    expect(
      mocks.request.mock.calls.some(
        ([method, params]) =>
          method === 'codex.app_server_request' &&
          ['plugin/install', 'plugin/list'].includes(params?.method)
      )
    ).toBe(false)
  })

  test.each([{ linkedId: 99 }, { missingLink: true }, { managedPath: sourcePath }])(
    'filesystem aliases preserve author-link and managed-package rejection: %j',
    async options => {
      fixture(options)

      await expect(
        createLocalCodexPluginApi().installPersonalPluginSource(
          {
            ...item,
            localPersonalSource: { marketplacePath: '/alias/personal', pluginName: name },
          },
          () => true
        )
      ).rejects.toThrow()

      expect(mocks.request.mock.calls.some(([method]) => method === nativeInstall)).toBe(false)
    }
  )

  test.each([
    { linkedId: 99 },
    { missingLink: true },
    { managedPath: sourcePath },
    { failRead: 'executor.plugins.personal.list' },
    { failRead: 'executor.plugins.links.list' },
    { failRead: 'executor.plugins.store.list' },
  ])('rejects unconfirmed source provenance before native mutation: %j', async options => {
    fixture(options)

    await expect(
      createLocalCodexPluginApi().installPersonalPluginSource(item, () => true)
    ).rejects.toThrow()

    expect(mocks.request.mock.calls.some(([method]) => method === nativeInstall)).toBe(false)
  })

  test('does not grant source installation to a recipient even with a stale source hint', async () => {
    await expect(
      createLocalCodexPluginApi().installPersonalPluginSource(
        { ...item, accessRole: 'recipient' },
        () => true
      )
    ).rejects.toThrow('identity is unavailable')
    expect(mocks.request).not.toHaveBeenCalled()
  })
})
