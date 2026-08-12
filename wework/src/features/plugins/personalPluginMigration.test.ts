import { describe, expect, test } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import {
  codexMarketplaceManifestSource,
  normalizeMarketplaceSource,
} from '@/api/local/codexPlugins'
import { preferWeworkPersonalInstalled } from './personalPluginMigration'

function plugin(marketplace: string, pluginKey: string): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: pluginKey, namespace: marketplace },
    spec: {
      source: {
        type: 'local',
        providerKey: marketplace,
        pluginKey,
        catalogItemId: pluginKey,
        marketplace,
      },
      origin: 'created',
      sourceProvider: 'user',
      sourceLabel: '个人分享',
      visibility: 'personal',
      displayName: pluginKey,
      description: '',
      version: '0.1.0',
      author: null,
      installState: 'installed',
      enabled: true,
      componentStates: {},
      manifest: null,
      components: {
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcps: [],
        apps: [],
        connectors: [],
        lsps: [],
        monitors: [],
        bins: [],
        settings: null,
      },
      interface: null,
      packageRef: null,
      sourcePayload: {
        marketplaceName: marketplace,
        pluginName: pluginKey,
      },
    },
    status: { state: 'enabled' },
  }
}

describe('preferWeworkPersonalInstalled', () => {
  test('normalizes a Codex marketplace manifest path to its marketplace root', () => {
    expect(
      normalizeMarketplaceSource(
        '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal/.agents/plugins/marketplace.json'
      )
    ).toBe('/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal')
  })

  test('builds a Codex marketplace manifest path from a marketplace root', () => {
    expect(
      codexMarketplaceManifestSource(
        '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal'
      )
    ).toBe(
      '/Users/test/.wework/capabilities/bundled-marketplaces/wework-personal/.agents/plugins/marketplace.json'
    )
  })

  test('hides Codex personal duplicates when wework-personal already has the plugin', () => {
    const items = preferWeworkPersonalInstalled([
      plugin('personal', 'dev-tools'),
      plugin('wework-personal', 'dev-tools'),
      plugin('wegent', 'github'),
    ])
    expect(
      items.map(item => `${item.spec.source.marketplace}:${item.spec.source.pluginKey}`)
    ).toEqual(['wework-personal:dev-tools', 'wegent:github'])
  })

  test('keeps Codex personal plugin when wework-personal does not have it yet', () => {
    const items = preferWeworkPersonalInstalled([plugin('personal', 'dev-tools')])
    expect(items).toHaveLength(1)
    expect(items[0]?.spec.source.marketplace).toBe('personal')
  })
})
