// @vitest-environment node

import type { InstalledPlugin, PluginMarketplaceItem } from '@/types/api'
import { describe, expect, test } from 'vitest'
import type { InstalledPluginItem } from './PluginManagementRows'
import { retainMarketplaceInstalledState } from './retainMarketplaceInstallHints'

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

  test('does not retain a stale installed row after authoritative reconciliation', () => {
    const previousItem = item({
      installed: true,
      installedLocally: true,
      installedPluginId: 'github@openai-curated-remote',
      enabled: true,
    })

    const retained = retainMarketplaceInstalledState({
      previousItems: [previousItem],
      nextItems: [item()],
      previousInstalled: [installedItem()],
      nextInstalled: [],
      previousStateMatchesScope: true,
      authoritativeInstalledState: true,
    })

    expect(retained.items).toEqual([item()])
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
