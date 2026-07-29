import { describe, expect, test } from 'vitest'
import type { InstalledPlugin, LocalDeviceApp } from '@/types/api'
import { enrichComposerApps } from './composerPluginMetadata'

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

describe('enrichComposerApps', () => {
  test('uses the installed plugin icon and localized metadata for slash commands', () => {
    expect(enrichComposerApps([githubApp], [githubPlugin])).toEqual([
      expect.objectContaining({
        name: 'GitHub',
        description: '检查仓库、处理拉取请求和 Issue，并通过 GitHub 工作流发布代码变更。',
        logoUrl: '/Users/test/plugins/github/assets/icon.png',
        pluginDisplayNames: ['GitHub'],
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
