import { describe, expect, test } from 'vitest'
import type { PluginMarketplaceItem } from '@/types/api'
import type { InstalledPlugin } from '@/types/api'
import type { InstalledPluginItem } from './PluginManagementRows'
import {
  retainMarketplaceInstalledState,
  retainMarketplaceInstallHints,
} from './retainMarketplaceInstallHints'

function item(overrides: Partial<PluginMarketplaceItem> = {}): PluginMarketplaceItem {
  return {
    id: 'github@openai-curated-remote',
    name: 'github',
    displayName: 'GitHub',
    description: '',
    version: '0.1.8',
    author: 'OpenAI',
    installed: false,
    installedLocally: false,
    installedPluginId: null,
    enabled: false,
    updateAvailable: false,
    latestReleaseId: null,
    components: {
      skills: [],
      commands: [],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
      connectors: [],
    },
    manifest: { marketplaceId: 'openai-curated-remote' },
    interface: null,
    ...overrides,
  }
}

function installedItem(): InstalledPluginItem {
  const raw: InstalledPlugin = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name: 'github',
      namespace: 'openai-curated-remote',
      labels: { id: 'github@openai-curated-remote' },
    },
    spec: {
      source: {
        type: 'local',
        providerKey: 'openai-curated-remote',
        pluginKey: 'github',
        catalogItemId: 'github@openai-curated-remote',
        marketplace: 'openai-curated-remote',
      },
      origin: 'market',
      installState: 'installed',
      enabled: true,
      displayName: 'GitHub',
      description: '',
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
      sourcePayload: null,
    },
    status: { state: 'enabled' },
  }
  return {
    id: 'github@openai-curated-remote',
    name: 'GitHub',
    description: '',
    enabled: true,
    version: '0.1.8',
    origin: 'market',
    sourceLabel: 'OpenAI',
    distribution: 'official',
    updateAvailable: false,
    componentCounts: {},
    raw,
  }
}

describe('retainMarketplaceInstallHints', () => {
  test('keeps an optimistic install when the next catalog snapshot lags', () => {
    const previous = [
      item({
        installed: true,
        installedLocally: true,
        installedPluginId: 'github@openai-curated-remote',
        enabled: true,
      }),
    ]
    const next = [item({ description: 'fresh description' })]

    expect(retainMarketplaceInstallHints(previous, next)).toEqual([
      expect.objectContaining({
        id: 'github@openai-curated-remote',
        description: 'fresh description',
        installed: true,
        installedLocally: true,
        installedPluginId: 'github@openai-curated-remote',
        enabled: true,
      }),
    ])
  })

  test('does not revive an install after the row was cleared', () => {
    const previous = [item({ installed: false, installedPluginId: null })]
    const next = [item({ installed: false, installedPluginId: null })]
    expect(retainMarketplaceInstallHints(previous, next)).toEqual(next)
  })

  test('keeps a previous device gap when the next catalog omits device rows', () => {
    const pending = {
      deviceId: 'current-device',
      desiredReleaseId: 1001,
      actualReleaseId: null,
      state: 'pending' as const,
      errorCode: null,
      errorMessage: null,
      attemptCount: 1,
      lastSyncAt: null,
      updatedAt: '2026-07-25T12:00:00',
    }
    const previous = [
      item({
        id: 101,
        installed: false,
        installedPluginId: 101,
        currentDeviceInstallation: pending,
      }),
    ]
    const next = [
      item({
        id: 101,
        installed: true,
        installedPluginId: 101,
        currentDeviceInstallation: null,
      }),
    ]

    expect(retainMarketplaceInstallHints(previous, next)).toEqual([
      expect.objectContaining({
        id: 101,
        installed: true,
        installedPluginId: 101,
        currentDeviceInstallation: pending,
      }),
    ])
  })

  test('retains the matching installed row with an optimistic marketplace hint', () => {
    const previousItem = item({
      installed: true,
      installedLocally: true,
      installedPluginId: 'github@openai-curated-remote',
      enabled: true,
    })
    const plugin = installedItem()

    const retained = retainMarketplaceInstalledState({
      previousItems: [previousItem],
      nextItems: [item()],
      previousInstalled: [plugin],
      nextInstalled: [],
      previousStateMatchesScope: true,
    })

    expect(retained.items[0]?.installed).toBe(true)
    expect(retained.installed).toEqual([plugin])
  })

  test('clears a stale installed card when no installed row can be retained', () => {
    const retained = retainMarketplaceInstalledState({
      previousItems: [
        item({
          installed: true,
          installedLocally: true,
          installedPluginId: 'github@openai-curated-remote',
          enabled: true,
        }),
      ],
      nextItems: [item()],
      previousInstalled: [],
      nextInstalled: [],
      previousStateMatchesScope: true,
    })

    expect(retained.items[0]?.installed).toBe(false)
    expect(retained.installed).toEqual([])
  })

  test('does not retain installed state from a different cache scope', () => {
    const previousItem = item({
      installed: true,
      installedLocally: true,
      installedPluginId: 'github@openai-curated-remote',
      enabled: true,
    })
    const nextItem = item()

    const retained = retainMarketplaceInstalledState({
      previousItems: [previousItem],
      nextItems: [nextItem],
      previousInstalled: [installedItem()],
      nextInstalled: [],
      previousStateMatchesScope: false,
    })

    expect(retained.items).toEqual([nextItem])
    expect(retained.installed).toEqual([])
  })

  test('does not revive an uninstalled OpenAI remote plugin when live membership listed that marketplace', () => {
    const previousGithub = item({
      installed: true,
      installedLocally: true,
      installedPluginId: 'github@openai-curated-remote',
      enabled: true,
    })
    const previousGmail = item({
      id: 'gmail@openai-curated-remote',
      name: 'gmail',
      displayName: 'Gmail',
      installed: true,
      installedLocally: true,
      installedPluginId: 'gmail@openai-curated-remote',
      enabled: true,
    })
    const gmailPlugin = installedItem()
    gmailPlugin.id = 'gmail@openai-curated-remote'
    gmailPlugin.name = 'Gmail'
    gmailPlugin.raw = {
      ...gmailPlugin.raw,
      metadata: {
        name: 'gmail',
        namespace: 'openai-curated-remote',
        labels: { id: 'gmail@openai-curated-remote' },
      },
      spec: {
        ...gmailPlugin.raw.spec,
        source: {
          ...gmailPlugin.raw.spec.source,
          pluginKey: 'gmail',
          catalogItemId: 'gmail@openai-curated-remote',
        },
        displayName: 'Gmail',
      },
    }

    const retained = retainMarketplaceInstalledState({
      previousItems: [previousGithub, previousGmail],
      nextItems: [item(), previousGmail],
      previousInstalled: [installedItem(), gmailPlugin],
      nextInstalled: [gmailPlugin],
      previousStateMatchesScope: true,
    })

    expect(retained.items.find(entry => entry.id === previousGithub.id)?.installed).toBe(false)
    expect(retained.installed.map(plugin => plugin.id)).toEqual(['gmail@openai-curated-remote'])
  })
})
