import { describe, expect, it } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import { buildProjectPluginCatalog, mergeProjectPluginCatalogs } from './projectPluginCatalog'

function installedPlugin(
  pluginName: string,
  marketplaceId: string,
  displayName = pluginName
): InstalledPlugin {
  return {
    apiVersion: 'wegent.ai/v1',
    kind: 'InstalledPlugin',
    metadata: { name: pluginName },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: marketplaceId,
        pluginKey: pluginName,
        marketplace: marketplaceId,
      },
      displayName,
      description: '',
      installState: 'installed',
      enabled: true,
      manifest: {},
      components: {},
    },
    status: { state: 'installed' },
  }
}

describe('projectPluginCatalog', () => {
  it('uses Codex Apps to enrich local installed plugin names', () => {
    expect(
      buildProjectPluginCatalog(
        [installedPlugin('github', 'openai')],
        [
          {
            id: 'github',
            name: 'GitHub App',
            pluginDisplayNames: ['github'],
            source: 'codex-app',
          },
        ]
      )
    ).toEqual([
      {
        id: 'github@openai',
        pluginName: 'github',
        marketplaceId: 'openai',
        displayName: 'GitHub App',
      },
    ])
  })

  it('merges local and cloud inventories by plugin identity', () => {
    expect(
      mergeProjectPluginCatalogs(
        [
          {
            id: 'github@openai',
            pluginName: 'github',
            marketplaceId: 'openai',
            displayName: 'GitHub',
          },
        ],
        [
          {
            id: 'github@openai',
            pluginName: 'github',
            marketplaceId: 'openai',
            displayName: 'github',
          },
          {
            id: 'gmail@openai',
            pluginName: 'gmail',
            marketplaceId: 'openai',
            displayName: 'Gmail',
          },
        ]
      )
    ).toEqual([
      {
        id: 'github@openai',
        pluginName: 'github',
        marketplaceId: 'openai',
        displayName: 'GitHub',
      },
      {
        id: 'gmail@openai',
        pluginName: 'gmail',
        marketplaceId: 'openai',
        displayName: 'Gmail',
      },
    ])
  })
})
