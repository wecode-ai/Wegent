import { describe, expect, test } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import { retainOpenAiOfficialLocalInstalls } from './retainOpenAiOfficialLocalInstalls'

const emptyComponents = {
  skills: [],
  commands: [],
  agents: [],
  hooks: [],
  mcps: [],
  lsps: [],
  monitors: [],
  bins: [],
}

function officialPlugin(name = 'github'): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: {
      name,
      namespace: 'openai-curated-remote',
      labels: { id: `${name}@openai-curated-remote` },
    },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'openai-curated-remote',
        pluginKey: name,
        catalogItemId: `plugin_connector_1p_${name}`,
        marketplace: 'openai-curated-remote',
      },
      origin: 'market',
      sourceProvider: 'codex',
      sourceLabel: 'OpenAI 官方',
      visibility: 'public',
      displayName: name,
      description: '',
      version: '0.1.8',
      installState: 'installed',
      enabled: true,
      componentStates: {},
      manifest: {},
      components: emptyComponents,
      interface: null,
      packageRef: null,
      sourcePayload: { marketplaceName: 'openai-curated-remote' },
    },
    status: { state: 'enabled' },
  }
}

function wegentPlugin(): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: 'tianhe', namespace: 'wegent', labels: { id: 'tianhe@wegent' } },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent',
        pluginKey: 'tianhe',
        catalogItemId: 'tianhe',
        marketplace: 'wegent',
      },
      origin: 'market',
      pluginId: 269069,
      sourceProvider: 'wegent',
      sourceLabel: '企业内部',
      visibility: 'workspace',
      displayName: '天河',
      description: '',
      version: '0.1.7',
      installState: 'installed',
      enabled: true,
      componentStates: {},
      manifest: {},
      components: emptyComponents,
      interface: null,
      packageRef: null,
      sourcePayload: { marketplaceName: 'wegent' },
    },
    status: { state: 'enabled' },
  }
}

describe('retainOpenAiOfficialLocalInstalls', () => {
  test('keeps cached OpenAI installs when live plugin/installed omitted them', () => {
    const github = officialPlugin()
    expect(retainOpenAiOfficialLocalInstalls([wegentPlugin()], [github, wegentPlugin()])).toEqual([
      wegentPlugin(),
      github,
    ])
  })

  test('trusts live OpenAI membership when plugin/installed returned official rows', () => {
    const liveGithub = officialPlugin('gmail')
    const cachedGithub = officialPlugin('github')
    expect(retainOpenAiOfficialLocalInstalls([liveGithub], [cachedGithub])).toEqual([liveGithub])
  })

  test('does not invent official installs when neither side has them', () => {
    expect(retainOpenAiOfficialLocalInstalls([wegentPlugin()], [wegentPlugin()])).toEqual([
      wegentPlugin(),
    ])
  })
})
