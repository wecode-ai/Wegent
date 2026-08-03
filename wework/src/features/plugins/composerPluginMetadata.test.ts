import { describe, expect, test } from 'vitest'
import type { InstalledPlugin, LocalDeviceApp } from '@/types/api'
import { appendInstalledPluginsAsComposerApps, enrichComposerApps } from './composerPluginMetadata'

const githubApp: LocalDeviceApp = {
  id: 'github',
  name: 'GitHub',
  description: 'GitHub repositories, issues, pull requests, and Actions',
  isAccessible: true,
  isEnabled: true,
  pluginDisplayNames: ['GitHub'],
}

const githubPlugin: InstalledPlugin = {
  apiVersion: 'wegent.ai/v1',
  kind: 'InstalledPlugin',
  metadata: { name: 'github', namespace: 'openai-api-curated' },
  spec: {
    source: {
      type: 'marketplace',
      providerKey: 'openai-api-curated',
      pluginKey: 'github',
    },
    displayName: 'GitHub',
    description: '检查仓库、处理拉取请求和 Issue，并通过 GitHub 工作流发布代码变更。',
    installState: 'installed',
    enabled: true,
    manifest: {},
    components: {
      skills: [],
      commands: [],
      apps: [{ name: 'GitHub', path: 'github' }],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
    },
    interface: {
      composerIcon: '/Users/test/plugins/github/assets/icon.png',
    },
  },
  status: { state: 'enabled' },
}

const superpowersPlugin: InstalledPlugin = {
  apiVersion: 'wegent.ai/v1',
  kind: 'InstalledPlugin',
  metadata: { name: 'superpowers', namespace: 'openai-official' },
  spec: {
    source: {
      type: 'marketplace',
      providerKey: 'openai-official',
      pluginKey: 'superpowers',
    },
    displayName: 'superpowers',
    description: 'A complete software development workflow',
    installState: 'installed',
    enabled: true,
    manifest: {},
    components: {
      skills: [{ name: 'superpowers', path: '/tmp/plugins/superpowers/skills/superpowers' }],
      commands: [],
      apps: [],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
    },
    interface: {
      logo: '/tmp/plugins/superpowers/assets/icon.png',
      shortDescription: 'A complete software development workflow',
    },
    sourcePayload: {
      pluginName: 'superpowers',
      marketplaceName: 'openai-official',
    },
  },
  status: { state: 'enabled' },
}

describe('enrichComposerApps', () => {
  test('uses the installed plugin icon and localized metadata for slash commands', () => {
    expect(enrichComposerApps([githubApp], [githubPlugin])).toEqual([
      expect.objectContaining({
        name: 'GitHub',
        description: '检查仓库、处理拉取请求和 Issue，并通过 GitHub 工作流发布代码变更。',
        logoUrl: '/Users/test/plugins/github/assets/icon.png',
        pluginDisplayNames: ['GitHub'],
        trialTemplates: expect.any(Array),
      }),
    ])
  })

  test('enriches a Wegent connector app after connector synchronization', () => {
    const connectorApp: LocalDeviceApp = {
      ...githubApp,
      id: 'wegent:github',
      pluginDisplayNames: ['Wegent Cloud'],
      source: 'wegent-connector',
    }

    expect(enrichComposerApps([connectorApp], [githubPlugin])).toEqual([
      expect.objectContaining({
        id: 'wegent:github',
        description: '检查仓库、处理拉取请求和 Issue，并通过 GitHub 工作流发布代码变更。',
        logoUrl: '/Users/test/plugins/github/assets/icon.png',
        pluginDisplayNames: ['GitHub', 'Wegent Cloud'],
        trialTemplates: expect.any(Array),
      }),
    ])
  })

  test('uses metadata while an installed plugin update is available', () => {
    const updateAvailablePlugin = {
      ...githubPlugin,
      spec: { ...githubPlugin.spec, installState: 'update_available' as const },
    }

    expect(enrichComposerApps([githubApp], [updateAvailablePlugin])[0]?.description).toBe(
      '检查仓库、处理拉取请求和 Issue，并通过 GitHub 工作流发布代码变更。'
    )
  })

  test('removes apps owned by a disabled plugin from composer menus', () => {
    const disabledPlugin = {
      ...githubPlugin,
      spec: { ...githubPlugin.spec, enabled: false },
    }

    expect(enrichComposerApps([githubApp], [disabledPlugin])).toEqual([])
  })

  test('keeps apps that do not belong to an installed plugin', () => {
    const unrelatedApp: LocalDeviceApp = {
      ...githubApp,
      id: 'calendar',
      name: 'Calendar',
      pluginDisplayNames: ['Calendar'],
    }

    expect(enrichComposerApps([unrelatedApp], [githubPlugin])).toEqual([unrelatedApp])
  })
})

describe('appendInstalledPluginsAsComposerApps', () => {
  test('adds skill-only installed plugins that have no Codex app entry', () => {
    expect(
      appendInstalledPluginsAsComposerApps([githubApp], [githubPlugin, superpowersPlugin])
    ).toEqual([
      githubApp,
      expect.objectContaining({
        id: 'plugin:superpowers',
        name: 'superpowers',
        source: 'installed-plugin',
        skillPath: 'plugin://superpowers@openai-official',
        logoUrl: '/tmp/plugins/superpowers/assets/icon.png',
        trialTemplates: expect.any(Array),
      }),
    ])
  })

  test('does not duplicate plugins already represented by an app', () => {
    expect(appendInstalledPluginsAsComposerApps([githubApp], [githubPlugin])).toEqual([githubApp])
  })

  test('skips disabled skill-only plugins', () => {
    const disabled = {
      ...superpowersPlugin,
      spec: { ...superpowersPlugin.spec, enabled: false },
    }
    expect(appendInstalledPluginsAsComposerApps([], [disabled])).toEqual([])
  })
})
