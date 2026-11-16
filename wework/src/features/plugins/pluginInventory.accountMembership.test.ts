import { toInstalledPlugin } from '@wegent/chat-core/codex-installed-plugins'
import { afterEach, expect, test } from 'vitest'
import {
  loadPluginInventory,
  selectComposerPluginApps,
  writePluginInventory,
} from './pluginInventory'
import { clearPluginMarketplaceCache } from './pluginMarketplaceCache'

afterEach(clearPluginMarketplaceCache)

const managed = toInstalledPlugin(
  { name: 'wegent', plugins: [] },
  { id: 'removed@wegent', name: 'removed', installed: true, enabled: true },
  undefined,
  key => key
)
const independent = toInstalledPlugin(
  { name: 'openai-api-curated', plugins: [] },
  { id: 'independent@openai-api-curated', name: 'independent', installed: true, enabled: true },
  undefined,
  key => key
)

test.each(['fresh', 'cached'] as const)(
  'keeps a %s account removal authoritative over stale Codex membership',
  async source => {
    writePluginInventory('account', 'device', {
      installedPlugins: [],
      installedPluginsFetchedAt: Date.now(),
    })
    const snapshot = await loadPluginInventory({
      cacheKey: 'account',
      deviceId: 'device',
      readLocalInstalledPlugins: async () => ({ items: [managed, independent] }),
      listCloudInstalledPlugins: async () => (source === 'fresh' ? [] : undefined),
      cloudMembershipAuthoritative: true,
      isCurrent: () => true,
    })

    expect(snapshot?.installedPlugins).toEqual([independent])
    expect(selectComposerPluginApps(snapshot!).map(app => app.id)).toEqual(['plugin:independent'])
  }
)

test('retains managed disk membership when account membership is unavailable', async () => {
  const snapshot = await loadPluginInventory({
    cacheKey: 'account',
    deviceId: 'device',
    readLocalInstalledPlugins: async () => ({ items: [managed, independent] }),
    listCloudInstalledPlugins: async () => undefined,
    cloudMembershipAuthoritative: false,
    isCurrent: () => true,
  })

  expect(snapshot?.installedPlugins).toMatchObject([managed, independent])
  expect(snapshot?.installedPlugins).toHaveLength(2)
})

test('preserves a surviving account install beside an uninstalled Codex entry', async () => {
  const retained = {
    ...managed,
    metadata: { ...managed.metadata, name: 'retained', labels: { id: '77' } },
    spec: {
      ...managed.spec,
      pluginId: 77,
      releaseId: 1,
      source: { ...managed.spec.source, pluginKey: 'retained' },
    },
  }
  writePluginInventory('account', 'device', { installedPlugins: [retained] })
  const snapshot = await loadPluginInventory({
    cacheKey: 'account',
    deviceId: 'device',
    readLocalInstalledPlugins: async () => ({ items: [managed, independent] }),
    listCloudInstalledPlugins: async () => undefined,
    cloudMembershipAuthoritative: true,
    isCurrent: () => true,
  })

  expect(snapshot?.installedPlugins).toEqual([retained, independent])
})
