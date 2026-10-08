import { afterEach, describe, expect, test, vi } from 'vitest'
import type { InstalledPlugin, LocalDeviceApp, PluginMarketplaceItem } from '@/types/api'
import {
  loadPluginInventory,
  selectComposerPluginApps,
  writePluginInventory,
  hydratePluginInventoryLogos,
  updatePluginInventoryInstallation,
  commitPluginInventoryInstallation,
  refreshInstalledPluginInventory,
  hasLoadedPluginInventory,
} from './pluginInventory'
import {
  clearPluginMarketplaceCache,
  getPluginMarketplaceCache,
  setPluginMarketplaceCache,
  removePluginMarketplaceInstallation,
  flushPluginMarketplaceCachePersist,
  resetPluginMarketplaceCacheMemory,
} from './pluginMarketplaceCache'

afterEach(() => clearPluginMarketplaceCache())

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

describe('installed-only management refresh', () => {
  test('projects an accepted remote installation consistently after a fresh stale inventory read', async () => {
    const github: InstalledPlugin = {
      ...dingtalk,
      metadata: {
        ...dingtalk.metadata,
        name: 'github',
        namespace: 'openai-curated-remote',
        labels: { id: 'github@openai-curated-remote' },
      },
      spec: {
        ...dingtalk.spec,
        displayName: 'GitHub',
        source: {
          type: 'marketplace',
          providerKey: 'openai-curated-remote',
          marketplace: 'openai-curated-remote',
          pluginKey: 'github',
        },
        sourcePayload: {
          codexInstallationReceipt: {
            awaitingMembership: true,
            authPolicy: 'ON_USE',
            appsNeedingAuth: [],
          },
        },
      },
    }
    commitPluginInventoryInstallation('test', 'device', github)
    await refreshInstalledPluginInventory({
      cacheKey: 'test',
      readLocal: async () => ({ items: [], deviceId: 'device' }),
      readCloud: async () => ({ items: [] }),
      isCurrent: () => true,
    })
    const managementInventory = getPluginMarketplaceCache('test')!
    const chatInventory = await loadPluginInventory({
      cacheKey: 'test',
      deviceId: 'device',
      readLocalInstalledPlugins: async () => [],
      listCloudInstalledPlugins: async () => [],
      isCurrent: () => true,
    })
    expect(managementInventory.installedPlugins).toEqual([github])
    expect(chatInventory?.installedPlugins).toEqual(managementInventory.installedPlugins)
    expect(selectComposerPluginApps(chatInventory!).some(app => app.pluginKey === 'github')).toBe(
      true
    )
  })

  test('publishes cold local rows first, then resolves cloud membership for the actual device once', async () => {
    const cloud = deferred<{ items: InstalledPlugin[] }>()
    const readCloud = vi.fn(() => cloud.promise)
    const refresh = refreshInstalledPluginInventory({
      cacheKey: 'test',
      readLocal: async () => ({ items: [dingtalk], deviceId: 'device' }),
      readCloud,
      isCurrent: () => true,
    })
    await vi.waitFor(() => expect(readCloud).toHaveBeenCalledWith('device'))
    expect(getPluginMarketplaceCache('test')?.installedPlugins).toHaveLength(1)
    expect(getPluginMarketplaceCache('test')?.installedPluginsFetchedAt).toBeUndefined()
    cloud.resolve({ items: [] })
    await refresh
    expect(readCloud).toHaveBeenCalledTimes(1)
    expect(getPluginMarketplaceCache('test')?.installedPluginsFetchedAt).toBeGreaterThan(0)
  })

  test('persists a complete empty inventory without introducing another cache', async () => {
    await refreshInstalledPluginInventory({
      cacheKey: 'test',
      readLocal: async () => ({ items: [], deviceId: 'device' }),
      readCloud: async () => ({ items: [] }),
      isCurrent: () => true,
    })
    expect(hasLoadedPluginInventory(getPluginMarketplaceCache('test'))).toBe(true)
    writePluginInventory('test', 'device', { apps: [] })
    flushPluginMarketplaceCachePersist()
    resetPluginMarketplaceCacheMemory()
    expect(hasLoadedPluginInventory(getPluginMarketplaceCache('test'))).toBe(true)
    writePluginInventory('test', 'other-device', { installedPlugins: [] })
    expect(hasLoadedPluginInventory(getPluginMarketplaceCache('test'))).toBe(false)
  })

  test('keeps warm rows when a cloud read fails instead of treating failure as absence', async () => {
    const before = writePluginInventory('test', 'device', { installedPlugins: [dingtalk] })
    await expect(
      refreshInstalledPluginInventory({
        cacheKey: 'test',
        readLocal: async () => ({ items: [], deviceId: 'device' }),
        readCloud: async () => {
          throw new Error('Cloud unavailable')
        },
        isCurrent: () => true,
      })
    ).rejects.toThrow('Cloud unavailable')
    expect(getPluginMarketplaceCache('test')).toBe(before)
  })

  test.each(['mutation', 'refresh', 'device', 'unmount'] as const)(
    'does not overwrite a newer %s while cloud membership is pending',
    async change => {
      const cloud = deferred<{ items: InstalledPlugin[] }>()
      const readCloud = vi.fn(() => cloud.promise)
      let current = true
      const refresh = refreshInstalledPluginInventory({
        cacheKey: 'test',
        readLocal: async () => ({ items: [dingtalk], deviceId: 'device' }),
        readCloud,
        isCurrent: () => current,
      })
      await vi.waitFor(() => expect(readCloud).toHaveBeenCalled())
      if (change === 'unmount') current = false
      else
        writePluginInventory(
          'test',
          change === 'device' ? 'other-device' : 'device',
          { installedPlugins: [] },
          { mutation: change === 'mutation' }
        )
      const expected = getPluginMarketplaceCache('test')
      cloud.resolve({ items: [dingtalk] })
      await refresh
      expect(getPluginMarketplaceCache('test')).toBe(expected)
    }
  )

  test('does not publish a late local response after a confirmed installation', async () => {
    const local = deferred<{ items: InstalledPlugin[]; deviceId: string }>()
    const readCloud = vi.fn().mockResolvedValue({ items: [] })
    const refresh = refreshInstalledPluginInventory({
      cacheKey: 'test',
      readLocal: () => local.promise,
      readCloud,
      isCurrent: () => true,
    })
    commitPluginInventoryInstallation('test', 'device', dingtalk)
    const expected = getPluginMarketplaceCache('test')
    local.resolve({ items: [], deviceId: 'device' })
    await refresh
    expect(getPluginMarketplaceCache('test')).toBe(expected)
    expect(readCloud).not.toHaveBeenCalled()
  })

  test('does not replace a newer complete empty inventory with an older cold local read', async () => {
    const local = deferred<{ items: InstalledPlugin[]; deviceId: string }>()
    const readCloud = vi.fn().mockResolvedValue({ items: [] })
    const refresh = refreshInstalledPluginInventory({
      cacheKey: 'test',
      readLocal: () => local.promise,
      readCloud,
      isCurrent: () => true,
    })
    const expected = writePluginInventory('test', 'device', {
      installedPlugins: [],
      installedPluginsFetchedAt: Date.now(),
    })
    local.resolve({ items: [dingtalk], deviceId: 'device' })
    await refresh
    expect(getPluginMarketplaceCache('test')).toBe(expected)
    expect(readCloud).not.toHaveBeenCalled()
  })
})

async function loadAndSelect(
  sources: {
    deviceId: string
    listCodexApps: () => Promise<LocalDeviceApp[]>
    readLocalInstalledPlugins: () => Promise<InstalledPlugin[]>
    readLocalInstalledPluginDetail?: (plugin: InstalledPlugin) => Promise<InstalledPlugin>
    listCloudInstalledPlugins: () => Promise<InstalledPlugin[]>
  },
  options: {
    enrichRelativeLogos?: boolean
    marketplaceItems?: PluginMarketplaceItem[]
    visiblePluginKeys?: ReadonlySet<string>
  } = {}
) {
  const [snapshot, apps] = await Promise.all([
    loadPluginInventory({ ...sources, cacheKey: 'test', isCurrent: () => true }),
    sources.listCodexApps(),
  ])
  if (!snapshot) throw new Error('Missing snapshot')
  setPluginMarketplaceCache({ ...snapshot, apps, marketplaceItems: options.marketplaceItems ?? [] })
  if (options.enrichRelativeLogos && sources.readLocalInstalledPluginDetail) {
    await hydratePluginInventoryLogos(
      'test',
      getPluginMarketplaceCache('test')!,
      sources.readLocalInstalledPluginDetail,
      () => true
    )
  }
  return selectComposerPluginApps(getPluginMarketplaceCache('test')!, options.visiblePluginKeys)
}
import { composerAppsFromRuntimeSnapshot } from '@wegent/chat-core/runtime-composer-plugin-source'

describe('shared domain inventory regressions', () => {
  test('binds a catalog-only snapshot to the confirmed installation device', () => {
    writePluginInventory('test', '', { installedPlugins: [] })
    commitPluginInventoryInstallation('test', 'device', dingtalk)
    const snapshot = getPluginMarketplaceCache('test')!
    expect(snapshot.deviceId).toBe('device')
    expect(snapshot.installedPlugins).toEqual([dingtalk])
    expect(snapshot.mutationRevision).toBe(1)
    expect(selectComposerPluginApps(snapshot)).toHaveLength(1)
    commitPluginInventoryInstallation('test', 'other-device', {
      ...dingtalk,
      spec: { ...dingtalk.spec, enabled: false },
    })
    expect(getPluginMarketplaceCache('test')).toBe(snapshot)
  })

  test('does not let a pre-install inventory request erase an acknowledged installation', async () => {
    writePluginInventory('test', 'device', { installedPlugins: [] })
    let resolve!: (plugins: InstalledPlugin[]) => void
    const loading = loadPluginInventory({
      cacheKey: 'test',
      deviceId: 'device',
      isCurrent: () => true,
      readLocalInstalledPlugins: () =>
        new Promise(done => {
          resolve = done
        }),
      listCloudInstalledPlugins: async () => [],
    })
    commitPluginInventoryInstallation('test', 'device', dingtalk)
    resolve([])
    await loading
    expect(getPluginMarketplaceCache('test')!.installedPlugins).toEqual([dingtalk])
  })

  test('does not replace a complete record with an outdated partial scan record', async () => {
    writePluginInventory('test', 'device', { installedPlugins: [dingtalk] })
    await loadPluginInventory({
      cacheKey: 'test',
      deviceId: 'device',
      partial: true,
      isCurrent: () => true,
      readLocalInstalledPlugins: async () => [
        {
          ...dingtalk,
          spec: { ...dingtalk.spec, enabled: false },
        },
      ],
      listCloudInstalledPlugins: async () => [],
    })
    expect(getPluginMarketplaceCache('test')!.installedPlugins).toEqual([dingtalk])
  })

  test('does not treat a partial disk scan as proof that other plugins were removed', async () => {
    writePluginInventory('test', 'device', { installedPlugins: [dingtalk] })
    const partial = await loadPluginInventory({
      cacheKey: 'test',
      deviceId: 'device',
      partial: true,
      isCurrent: () => true,
      readLocalInstalledPlugins: async () => [],
      listCloudInstalledPlugins: async () => [],
    })
    expect(partial!.installedPlugins).toEqual([dingtalk])
    const complete = await loadPluginInventory({
      cacheKey: 'test',
      deviceId: 'device',
      isCurrent: () => true,
      readLocalInstalledPlugins: async () => [],
      listCloudInstalledPlugins: async () => [],
    })
    expect(complete!.installedPlugins).toEqual([])
  })

  test('rejects an old refresh even when intervening settings changes restore the same values', async () => {
    writePluginInventory('test', 'device', { installedPlugins: [dingtalk] })
    let resolve!: (plugins: InstalledPlugin[]) => void
    const loading = loadPluginInventory({
      cacheKey: 'test',
      deviceId: 'device',
      isCurrent: () => true,
      readLocalInstalledPlugins: () =>
        new Promise(done => {
          resolve = done
        }),
      listCloudInstalledPlugins: async () => [],
    })
    updatePluginInventoryInstallation(
      'test',
      '62',
      {
        ...dingtalk,
        spec: { ...dingtalk.spec, enabled: false },
      },
      { enabled: false }
    )
    updatePluginInventoryInstallation('test', '62', dingtalk, { enabled: true })
    resolve([])
    await loading
    expect(getPluginMarketplaceCache('test')!.installedPlugins).toEqual([dingtalk])
    expect(getPluginMarketplaceCache('test')!.mutationRevision).toBe(2)
  })

  test('applies only the acknowledged setting without overwriting newer settings or removals', () => {
    writePluginInventory('test', 'device', { installedPlugins: [dingtalk] })
    updatePluginInventoryInstallation(
      'test',
      '62',
      {
        ...dingtalk,
        spec: { ...dingtalk.spec, enabled: false },
        status: { state: 'disabled' },
      },
      { enabled: false }
    )
    updatePluginInventoryInstallation(
      'test',
      '62',
      {
        ...dingtalk,
        spec: { ...dingtalk.spec, updatePolicy: 'auto' },
      },
      { updatePolicy: 'auto' }
    )
    const snapshot = getPluginMarketplaceCache('test')!
    expect(snapshot.installedPlugins[0]!.spec).toMatchObject({
      enabled: false,
      updatePolicy: 'auto',
    })
    expect(snapshot.installedPlugins[0]!.status.state).toBe('disabled')
    expect(selectComposerPluginApps(snapshot)).toEqual([])
    updatePluginInventoryInstallation('test', '62', dingtalk, { enabled: true })
    expect(selectComposerPluginApps(getPluginMarketplaceCache('test')!)).toHaveLength(1)
    expect(getPluginMarketplaceCache('test')!.installedPlugins[0]!.spec.updatePolicy).toBe('auto')

    writePluginInventory('test', 'device', { installedPlugins: [] })
    updatePluginInventoryInstallation('test', '62', dingtalk, { enabled: true })
    expect(getPluginMarketplaceCache('test')!.installedPlugins).toEqual([])
  })

  test('keeps pending local materialization when changing auto-update policy', async () => {
    const cloud: InstalledPlugin = {
      ...dingtalk,
      spec: { ...dingtalk.spec, installState: 'not_installed', updatePolicy: 'manual' },
    }
    await loadAndSelect({
      deviceId: 'device',
      readLocalInstalledPlugins: async () => [
        { ...dingtalk, spec: { ...dingtalk.spec, version: '1.0.0' } },
      ],
      listCloudInstalledPlugins: async () => [cloud],
      listCodexApps: async () => [],
    })
    const before = getPluginMarketplaceCache('test')!.installedPlugins[0]!
    updatePluginInventoryInstallation(
      'test',
      '62',
      {
        ...cloud,
        spec: { ...cloud.spec, updatePolicy: 'auto' },
      },
      { updatePolicy: 'auto' }
    )
    const snapshot = getPluginMarketplaceCache('test')!
    expect(snapshot.installedPlugins[0]).toEqual({
      ...before,
      spec: { ...before.spec, updatePolicy: 'auto' },
    })
    expect(snapshot.installedPlugins[0]!.spec.sourcePayload).toMatchObject({
      localPresent: true,
      localVersion: '1.0.0',
    })
    expect(selectComposerPluginApps(snapshot).map(app => app.id)).toEqual(['plugin:dingtalk'])
  })

  test('keeps actual release components and templates when updating component settings', async () => {
    const local: InstalledPlugin = {
      ...dingtalk,
      spec: {
        ...dingtalk.spec,
        version: '1.0.0',
        interface: { defaultPrompt: ['Installed template'] },
        componentStates: { 'skills:other': false },
      },
    }
    const cloud: InstalledPlugin = {
      ...dingtalk,
      spec: {
        ...dingtalk.spec,
        releaseId: 2,
        version: '2.0.0',
        interface: { defaultPrompt: ['Target template'] },
        components: { ...dingtalk.spec.components, skills: [] },
        componentStates: { 'skills:other': false },
      },
      status: {
        state: 'enabled',
        devices: [
          {
            deviceId: 'device',
            desiredReleaseId: 2,
            actualReleaseId: 1,
            state: 'installed',
            attemptCount: 1,
            updatedAt: '',
          },
        ],
      },
    }
    await loadAndSelect({
      deviceId: 'device',
      readLocalInstalledPlugins: async () => [local],
      listCloudInstalledPlugins: async () => [cloud],
      listCodexApps: async () => [],
    })
    const before = getPluginMarketplaceCache('test')!.installedPlugins[0]!
    updatePluginInventoryInstallation(
      'test',
      '62',
      {
        ...cloud,
        spec: {
          ...cloud.spec,
          componentStates: { 'skills:other': true, 'skills:dingtalk': true },
        },
      },
      { componentStates: { 'skills:dingtalk': true } }
    )
    const snapshot = getPluginMarketplaceCache('test')!
    expect(snapshot.installedPlugins[0]).toEqual({
      ...before,
      spec: { ...before.spec, componentStates: { 'skills:other': false, 'skills:dingtalk': true } },
    })
    expect(snapshot.installedPlugins[0]!.spec.releaseId).toBe(1)
    expect(selectComposerPluginApps(snapshot)[0]!.trialTemplates?.map(item => item.name)).toEqual([
      'Installed template',
    ])
  })

  test('keeps a locally materialized DingTalk package when cloud device acknowledgement is missing', async () => {
    const pending = {
      ...dingtalk,
      spec: { ...dingtalk.spec, installState: 'not_installed' as const },
    }
    const apps = await loadAndSelect({
      deviceId: 'device',
      readLocalInstalledPlugins: async () => [dingtalk],
      listCloudInstalledPlugins: async () => [pending],
      listCodexApps: async () => [],
    })
    expect(apps.map(app => app.pluginKey)).toEqual(['dingtalk'])
    const stored = getPluginMarketplaceCache('test')!.installedPlugins[0]!
    expect(stored.spec.installState).toBe('not_installed')
    expect(stored.spec.sourcePayload?.localPresent).toBe(true)
    const snapshot = writePluginInventory('test', 'device', {
      installedPlugins: [{ ...stored, spec: { ...stored.spec, enabled: false } }],
    })
    expect(selectComposerPluginApps(snapshot)).toEqual([])
  })

  test('keeps app authorization separate from a name-matched skill package', () => {
    const sites = {
      ...dingtalk,
      spec: {
        ...dingtalk.spec,
        displayName: '快速建站',
        source: { ...dingtalk.spec.source, pluginKey: 'wegent-sites' },
      },
    }
    const snapshot = writePluginInventory('test', 'device', {
      installedPlugins: [sites],
      apps: [{ id: 'wegent-sites', name: '快速建站', isAccessible: false, source: 'codex-app' }],
    })
    expect(selectComposerPluginApps(snapshot)).toEqual([
      expect.objectContaining({ id: 'plugin:wegent-sites', isAccessible: true }),
    ])
    expect(snapshot.apps![0]!.isAccessible).toBe(false)
  })

  test('preserves invocation fields after restart and derives project scope without mutating global state', () => {
    const plugin = {
      ...dingtalk,
      spec: {
        ...dingtalk.spec,
        enabled: false,
        interface: { defaultPrompt: ['Build a site'], shortDescription: 'Create sites' },
        components: {
          ...dingtalk.spec.components,
          templates: [
            { name: 'Template', path: 'templates/site', materializedAppIds: ['site-app'] },
          ],
        },
      },
    }
    writePluginInventory('test', 'device', { installedPlugins: [plugin] })
    flushPluginMarketplaceCachePersist()
    resetPluginMarketplaceCacheMemory()
    const snapshot = getPluginMarketplaceCache('test')!
    expect(snapshot.installedPlugins[0]!.spec.components).toMatchObject(plugin.spec.components)
    expect(snapshot.installedPlugins[0]!.spec.interface?.defaultPrompt).toEqual(['Build a site'])
    expect(selectComposerPluginApps(snapshot)).toEqual([])
    expect(selectComposerPluginApps(snapshot, new Set(['dingtalk']))).toHaveLength(1)
    expect(snapshot.installedPlugins[0]!.spec.enabled).toBe(false)
    expect(snapshot.installedPlugins[0]).not.toHaveProperty('raw')
  })

  test('does not resurrect an uninstalled package when an earlier read finishes', async () => {
    writePluginInventory('test', 'device', { installedPlugins: [dingtalk] })
    let resolve!: (plugins: InstalledPlugin[]) => void
    const delayed = new Promise<InstalledPlugin[]>(done => {
      resolve = done
    })
    const loading = loadPluginInventory({
      cacheKey: 'test',
      deviceId: 'device',
      isCurrent: () => true,
      readLocalInstalledPlugins: () => delayed,
      listCloudInstalledPlugins: async () => [],
    })
    removePluginMarketplaceInstallation('test', {
      installedIds: ['62'],
      marketplaceItemIds: [],
      pluginKeys: ['dingtalk'],
    })
    resolve([dingtalk])
    await loading
    expect(getPluginMarketplaceCache('test')!.installedPlugins).toEqual([])
    expect(selectComposerPluginApps(getPluginMarketplaceCache('test')!)).toEqual([])
  })

  test('discards reads from a previous account scope', async () => {
    await loadPluginInventory({
      cacheKey: 'old-account',
      deviceId: 'device',
      isCurrent: () => false,
      readLocalInstalledPlugins: async () => [dingtalk],
      listCloudInstalledPlugins: async () => [],
    })
    expect(getPluginMarketplaceCache('old-account')).toBeNull()
  })

  test('catalog writes preserve app authorization in the same device but never across devices', () => {
    const original = writePluginInventory('test', 'device', {
      installedPlugins: [dingtalk],
      apps: [{ id: 'connector', name: 'Connector', isAccessible: false }],
    })
    const { apps: _apps, connectorApps: _connectors, ...catalog } = original
    void _apps
    void _connectors
    setPluginMarketplaceCache(catalog)
    expect(getPluginMarketplaceCache('test')!.apps).toEqual(original.apps)
    setPluginMarketplaceCache({ ...catalog, deviceId: 'different-device' })
    expect(getPluginMarketplaceCache('test')!.apps).toEqual([])
    expect(getPluginMarketplaceCache('different-account')).toBeNull()
  })
})

const dingtalk: InstalledPlugin = {
  apiVersion: 'wegent.ai/v1',
  kind: 'InstalledPlugin',
  metadata: { name: 'dingtalk-1', namespace: 'default', labels: { id: '62' } },
  spec: {
    source: {
      type: 'marketplace',
      providerKey: 'wegent-market',
      pluginKey: 'dingtalk',
      marketplace: 'wegent',
    },
    pluginId: 1,
    releaseId: 1,
    displayName: '钉钉',
    description: 'DingTalk',
    installState: 'installed',
    enabled: true,
    manifest: {},
    components: {
      skills: [{ name: 'dingtalk', path: 'skills/dingtalk', description: '' }],
      commands: [],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
    },
  },
  status: { state: 'enabled' },
}

describe('pluginInventory', () => {
  test('matches the browser inventory and excludes cloud rows without release membership', async () => {
    const incomplete = { ...dingtalk, spec: { ...dingtalk.spec, releaseId: null } }
    for (const cloud of [[dingtalk], [incomplete], []]) {
      const native = await loadAndSelect({
        deviceId: 'local-device',
        listCodexApps: async () => [],
        readLocalInstalledPlugins: async () => [],
        listCloudInstalledPlugins: async () => cloud,
      })
      const browser = composerAppsFromRuntimeSnapshot(
        {
          taskId: 'task',
          workspacePath: '/workspace',
          projectPluginIds: [],
          apps: [],
          skills: [],
          marketplaces: [],
          store: { storePath: '/store', plugins: [] },
          cloudInstalledPlugins: cloud,
        },
        'local-device',
        key => key
      )
      expect(native).toEqual(browser)
      expect(native).toHaveLength(cloud[0]?.spec.releaseId ? 1 : 0)
    }
  })

  test('uses the selected device materialization instead of a different release template', async () => {
    const cloud: InstalledPlugin = {
      ...dingtalk,
      spec: { ...dingtalk.spec, releaseId: 2, interface: { defaultPrompt: ['new template'] } },
      status: {
        ...dingtalk.status,
        devices: [
          {
            deviceId: 'local-device',
            desiredReleaseId: 2,
            actualReleaseId: 1,
            state: 'installed',
            attemptCount: 1,
            updatedAt: '',
          },
        ],
      },
    }
    const local: InstalledPlugin = {
      ...dingtalk,
      spec: { ...dingtalk.spec, interface: { defaultPrompt: ['installed template'] } },
    }
    const apps = await loadAndSelect({
      deviceId: 'local-device',
      listCodexApps: async () => [],
      readLocalInstalledPlugins: async () => [local],
      listCloudInstalledPlugins: async () => [cloud],
    })
    expect(apps).toHaveLength(1)
    expect(apps[0].trialTemplates?.map(template => template.name)).toEqual(['installed template'])
  })

  test('resolves a declared relative logo from the installed plugin root', async () => {
    const localPlugin: InstalledPlugin = {
      ...dingtalk,
      spec: {
        ...dingtalk.spec,
        origin: 'created',
        source: {
          ...dingtalk.spec.source,
          type: 'local',
        },
        interface: {
          composerIcon: './assets/icon.png',
        },
      },
    }
    const readDetail = vi.fn().mockResolvedValue({
      ...localPlugin,
      spec: {
        ...localPlugin.spec,
        components: {
          ...localPlugin.spec.components,
          skills: [
            {
              name: 'dingtalk',
              path: '/Users/test/.codex/plugins/cache/personal/dingtalk/1/skills/dingtalk/SKILL.md',
            },
          ],
        },
      },
    } satisfies InstalledPlugin)

    const apps = await loadAndSelect(
      {
        deviceId: 'local-device',
        listCodexApps: async () => [],
        readLocalInstalledPlugins: async () => [localPlugin],
        readLocalInstalledPluginDetail: readDetail,
        listCloudInstalledPlugins: async () => [],
      },
      { enrichRelativeLogos: true }
    )

    expect(readDetail).toHaveBeenCalledWith(localPlugin)
    expect(apps).toEqual([
      expect.objectContaining({
        logoUrl: 'file:///Users/test/.codex/plugins/cache/personal/dingtalk/1/assets/icon.png',
      }),
    ])
  })

  test.each(['listCodexApps', 'readLocalInstalledPlugins', 'listCloudInstalledPlugins'] as const)(
    'rejects a failed %s instead of publishing a partial inventory',
    async source => {
      const sources = {
        deviceId: 'local-device',
        listCodexApps: vi.fn().mockResolvedValue([] as LocalDeviceApp[]),
        readLocalInstalledPlugins: vi.fn().mockResolvedValue([]),
        listCloudInstalledPlugins: vi.fn().mockResolvedValue([dingtalk]),
      }
      sources[source].mockRejectedValue(new Error('catalog unavailable'))
      await expect(loadAndSelect(sources)).rejects.toThrow('catalog unavailable')
    }
  )

  test('maps installed cloud rows with valid membership', async () => {
    const apps = await loadAndSelect({
      deviceId: 'local-device',
      listCodexApps: async () => [],
      readLocalInstalledPlugins: async () => [],
      listCloudInstalledPlugins: async () => [dingtalk],
    })
    expect(apps.map(app => app.id)).toEqual(['plugin:dingtalk'])
  })

  test('keeps an installed plugin selectable for chat authorization without enabling its connector', async () => {
    const googleDrive: InstalledPlugin = {
      ...dingtalk,
      metadata: { ...dingtalk.metadata, name: 'google-drive' },
      spec: {
        ...dingtalk.spec,
        source: {
          ...dingtalk.spec.source,
          pluginKey: 'google-drive',
        },
        displayName: 'Google Drive',
        components: {
          ...dingtalk.spec.components,
          apps: [
            {
              name: 'Google Drive',
              path: 'connector_5f3c8c41a1e54ad7a76272c89e2554fa',
            },
          ],
        },
      },
    }

    const apps = await loadAndSelect({
      deviceId: 'local-device',
      listCodexApps: async () => [
        {
          id: 'connector_5f3c8c41a1e54ad7a76272c89e2554fa',
          name: 'Google Drive',
          isAccessible: false,
          isEnabled: true,
          source: 'codex-app',
        },
      ],
      readLocalInstalledPlugins: async () => [googleDrive],
      listCloudInstalledPlugins: async () => [],
    })

    expect(apps).toEqual([
      expect.objectContaining({
        id: 'plugin:google-drive',
        isAccessible: false,
        source: 'installed-plugin',
        skillPath: expect.stringContaining('plugin://google-drive@'),
      }),
    ])
    expect(getPluginMarketplaceCache('test')!.apps![0].isAccessible).toBe(false)
  })

  test('lists a globally disabled plugin when the current project installed it', async () => {
    const projectPlugin: InstalledPlugin = {
      ...dingtalk,
      spec: {
        ...dingtalk.spec,
        enabled: false,
      },
      status: { state: 'disabled' },
    }

    const hiddenApps = await loadAndSelect({
      deviceId: 'local-device',
      listCodexApps: async () => [],
      readLocalInstalledPlugins: async () => [projectPlugin],
      listCloudInstalledPlugins: async () => [],
    })
    expect(hiddenApps).toEqual([])

    const projectApps = await loadAndSelect(
      {
        deviceId: 'local-device',
        listCodexApps: async () => [],
        readLocalInstalledPlugins: async () => [projectPlugin],
        listCloudInstalledPlugins: async () => [],
      },
      { visiblePluginKeys: new Set(['dingtalk']) }
    )
    expect(projectApps).toEqual([
      expect.objectContaining({
        id: 'plugin:dingtalk',
        name: '钉钉',
      }),
    ])
  })

  test('prefers marketplace catalog package logos over unresolved installed logos', async () => {
    const wiki: InstalledPlugin = {
      ...dingtalk,
      metadata: { name: 'weibo-api-wiki', namespace: 'default', labels: { id: '10' } },
      spec: {
        ...dingtalk.spec,
        pluginId: 42,
        source: {
          ...dingtalk.spec.source,
          pluginKey: 'weibo-api-wiki',
        },
        displayName: '微博开放平台内部WIKI',
        interface: {
          logo: './assets/logo.png',
        },
        components: {
          ...dingtalk.spec.components,
          skills: [{ name: 'wiki', path: 'skills/wiki', description: '' }],
        },
      },
    }

    const apps = await loadAndSelect(
      {
        deviceId: 'local-device',
        listCodexApps: async () => [],
        readLocalInstalledPlugins: async () => [],
        listCloudInstalledPlugins: async () => [wiki],
      },
      {
        marketplaceItems: [
          {
            id: 42,
            remotePluginId: 'wegent~Plugin_42',
            name: 'weibo-api-wiki',
            displayName: '微博开放平台内部WIKI',
            description: '',
            visibility: 'workspace',
            featured: false,
            installed: true,
            installedPluginId: 10,
            enabled: true,
            sourceType: 'marketplace',
            ownerUserId: 1,
            components: wiki.spec.components,
            manifest: {},
            interface: {
              logo: 'data:image/png;base64,aaa',
            },
          },
        ],
      }
    )

    expect(apps).toEqual([
      expect.objectContaining({
        id: 'plugin:weibo-api-wiki',
        logoUrl: 'data:image/png;base64,aaa',
      }),
    ])
  })
})
