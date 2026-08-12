import { describe, expect, test } from 'vitest'
import type { InstalledPlugin, LocalDeviceApp } from '@/types/api'
import {
  appendInstalledPluginsAsComposerApps,
  composerAppPluginKey,
  enrichComposerApps,
  overlayMarketplaceLogosOnComposerApps,
} from './composerPluginMetadata'

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

test('uses the connector slug as its plugin icon key', () => {
  expect(
    composerAppPluginKey({
      ...githubApp,
      id: 'wegent:github',
      pluginDisplayNames: ['Wegent Cloud'],
      source: 'wegent-connector',
    })
  ).toBe('github')
})

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
        pluginKey: 'github',
        description: '检查仓库、处理拉取请求和 Issue，并通过 GitHub 工作流发布代码变更。',
        logoUrl: '/Users/test/plugins/github/assets/icon.png',
        pluginDisplayNames: ['GitHub'],
        trialTemplates: expect.any(Array),
      }),
    ])
  })

  test('preserves the canonical plugin key when the app uses a localized display name', () => {
    const localizedPlugin: InstalledPlugin = {
      ...githubPlugin,
      metadata: { name: 'weibo-api-wiki', namespace: 'default' },
      spec: {
        ...githubPlugin.spec,
        source: {
          ...githubPlugin.spec.source,
          pluginKey: 'weibo-api-wiki',
        },
        displayName: '微博开放平台内部WIKI',
        components: {
          ...githubPlugin.spec.components,
          apps: [{ name: '微博开放平台内部WIKI', path: 'weibo-api-wiki' }],
        },
        interface: null,
      },
    }
    const localizedApp: LocalDeviceApp = {
      ...githubApp,
      id: 'weibo-api-wiki',
      name: '微博开放平台内部WIKI',
      pluginDisplayNames: ['微博开放平台内部WIKI'],
    }

    const [app] = enrichComposerApps([localizedApp], [localizedPlugin])

    expect(app?.pluginKey).toBe('weibo-api-wiki')
    expect(app && composerAppPluginKey(app)).toBe('weibo-api-wiki')
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

  test('drops apps that do not belong to an installed plugin', () => {
    const unrelatedApp: LocalDeviceApp = {
      ...githubApp,
      id: 'calendar',
      name: 'Calendar',
      pluginDisplayNames: ['Calendar'],
    }

    expect(enrichComposerApps([unrelatedApp], [githubPlugin])).toEqual([])
  })

  test('drops authorized cloud connectors that are not installed plugins', () => {
    const connectorApp: LocalDeviceApp = {
      ...githubApp,
      id: 'wegent:drive',
      name: 'Google Drive',
      pluginDisplayNames: ['Wegent Cloud'],
      source: 'wegent-connector',
    }

    expect(enrichComposerApps([connectorApp], [githubPlugin])).toEqual([])
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
        pluginKey: 'superpowers',
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

  test('includes installed plugins that only have a mention path and no skill files', () => {
    const mentionOnly = {
      ...superpowersPlugin,
      spec: {
        ...superpowersPlugin.spec,
        components: {
          ...superpowersPlugin.spec.components,
          skills: [],
        },
        sourcePayload: {
          marketplaceName: 'desktop-e2e-marketplace',
          pluginName: 'desktop-e2e-plugin',
        },
        source: {
          ...superpowersPlugin.spec.source,
          pluginKey: 'desktop-e2e-plugin',
          marketplace: 'desktop-e2e-marketplace',
        },
        displayName: 'Desktop E2E Plugin',
      },
      metadata: {
        ...superpowersPlugin.metadata,
        name: 'desktop-e2e-plugin',
        namespace: 'desktop-e2e-marketplace',
      },
    }

    expect(appendInstalledPluginsAsComposerApps([], [mentionOnly])).toEqual([
      expect.objectContaining({
        id: 'plugin:desktop-e2e-plugin',
        name: 'Desktop E2E Plugin',
        skillPath: 'plugin://desktop-e2e-plugin@desktop-e2e-marketplace',
      }),
    ])
  })

  test('maps cloud wegent installs that use namespace default and incomplete components', () => {
    const dingtalkCloud: InstalledPlugin = {
      ...superpowersPlugin,
      metadata: { name: 'dingtalk-67ace226d5', namespace: 'default', labels: { id: '62' } },
      spec: {
        ...superpowersPlugin.spec,
        displayName: '钉钉',
        source: {
          type: 'marketplace',
          providerKey: 'wegent-market',
          pluginKey: 'dingtalk',
          catalogItemId: '1',
          marketplace: 'wegent',
        },
        // Local/runtime merges sometimes omit component arrays entirely.
        components: undefined as unknown as InstalledPlugin['spec']['components'],
        sourcePayload: { releaseId: 1 },
      },
    }

    expect(appendInstalledPluginsAsComposerApps([], [dingtalkCloud])).toEqual([
      expect.objectContaining({
        id: 'plugin:dingtalk',
        name: '钉钉',
        skillPath: 'plugin://dingtalk@wegent',
        source: 'installed-plugin',
      }),
    ])
  })

  test('uses the workspace marketplace for managed installs without explicit marketplace', () => {
    const dingtalkCloud: InstalledPlugin = {
      ...superpowersPlugin,
      metadata: { name: 'dingtalk-67ace226d5', namespace: 'default', labels: { id: '62' } },
      spec: {
        ...superpowersPlugin.spec,
        displayName: '钉钉',
        source: {
          type: 'marketplace',
          providerKey: 'wegent-market',
          pluginKey: 'dingtalk',
          catalogItemId: '1',
        },
        components: undefined as unknown as InstalledPlugin['spec']['components'],
        sourcePayload: { releaseId: 1 },
      },
    }

    expect(appendInstalledPluginsAsComposerApps([], [dingtalkCloud])).toEqual([
      expect.objectContaining({
        id: 'plugin:dingtalk',
        name: '钉钉',
        skillPath: 'plugin://dingtalk@wegent',
        source: 'installed-plugin',
      }),
    ])
  })

  test('uses visibility over stale source marketplace for managed installs', () => {
    const dingtalkCloud: InstalledPlugin = {
      ...superpowersPlugin,
      metadata: { name: 'dingtalk-67ace226d5', namespace: 'default', labels: { id: '62' } },
      spec: {
        ...superpowersPlugin.spec,
        displayName: '钉钉',
        visibility: 'workspace',
        source: {
          type: 'marketplace',
          providerKey: 'wegent-market',
          pluginKey: 'dingtalk',
          catalogItemId: '1',
          marketplace: 'wework',
        },
        components: undefined as unknown as InstalledPlugin['spec']['components'],
        sourcePayload: { releaseId: 1 },
      },
    }

    expect(appendInstalledPluginsAsComposerApps([], [dingtalkCloud])).toEqual([
      expect.objectContaining({
        id: 'plugin:dingtalk',
        name: '钉钉',
        skillPath: 'plugin://dingtalk@wegent',
        source: 'installed-plugin',
      }),
    ])
  })

  test('uses the public marketplace for public managed installs without explicit marketplace', () => {
    const dingtalkCloud: InstalledPlugin = {
      ...superpowersPlugin,
      metadata: { name: 'dingtalk-67ace226d5', namespace: 'default', labels: { id: '62' } },
      spec: {
        ...superpowersPlugin.spec,
        displayName: '钉钉',
        visibility: 'public',
        source: {
          type: 'marketplace',
          providerKey: 'wegent-market',
          pluginKey: 'dingtalk',
          catalogItemId: '1',
        },
        components: undefined as unknown as InstalledPlugin['spec']['components'],
        sourcePayload: { releaseId: 1 },
      },
    }

    expect(appendInstalledPluginsAsComposerApps([], [dingtalkCloud])).toEqual([
      expect.objectContaining({
        id: 'plugin:dingtalk',
        name: '钉钉',
        skillPath: 'plugin://dingtalk@wework',
        source: 'installed-plugin',
      }),
    ])
  })

  test('uses the personal marketplace for personal managed installs without explicit marketplace', () => {
    const dingtalkCloud: InstalledPlugin = {
      ...superpowersPlugin,
      metadata: { name: 'dingtalk-67ace226d5', namespace: 'default', labels: { id: '62' } },
      spec: {
        ...superpowersPlugin.spec,
        displayName: '钉钉',
        visibility: 'personal',
        source: {
          type: 'marketplace',
          providerKey: 'wegent-market',
          pluginKey: 'dingtalk',
          catalogItemId: '1',
        },
        components: undefined as unknown as InstalledPlugin['spec']['components'],
        sourcePayload: { releaseId: 1 },
      },
    }

    expect(appendInstalledPluginsAsComposerApps([], [dingtalkCloud])).toEqual([
      expect.objectContaining({
        id: 'plugin:dingtalk',
        name: '钉钉',
        skillPath: 'plugin://dingtalk@wework-personal',
        source: 'installed-plugin',
      }),
    ])
  })

  test('keeps composer apps when another installed plugin has broken components', () => {
    const broken: InstalledPlugin = {
      ...githubPlugin,
      metadata: { name: 'broken-plugin', namespace: 'default' },
      spec: {
        ...githubPlugin.spec,
        displayName: 'Broken Plugin',
        source: {
          type: 'marketplace',
          providerKey: 'wegent-market',
          pluginKey: 'broken-plugin',
          marketplace: 'wegent',
        },
        components: undefined as unknown as InstalledPlugin['spec']['components'],
      },
    }

    expect(enrichComposerApps([githubApp], [githubPlugin, broken])).toEqual([
      expect.objectContaining({ id: 'github', name: 'GitHub' }),
    ])
    expect(appendInstalledPluginsAsComposerApps([githubApp], [githubPlugin, broken])).toEqual([
      githubApp,
      expect.objectContaining({
        id: 'plugin:broken-plugin',
        skillPath: 'plugin://broken-plugin@wegent',
      }),
    ])
  })
})

describe('overlayMarketplaceLogosOnComposerApps', () => {
  test('replaces unresolved composer logos with marketplace package logos', () => {
    const apps: LocalDeviceApp[] = [
      {
        id: 'plugin:weibo-api-wiki',
        name: '微博开放平台内部WIKI',
        pluginKey: 'weibo-api-wiki',
        description: null,
        logoUrl: '/plugin-icons/wework.svg',
        isAccessible: true,
        isEnabled: true,
        source: 'installed-plugin',
      },
      {
        id: 'wegent:dingtalk',
        name: '钉钉',
        description: null,
        logoUrl: 'https://example.com/dingtalk.png',
        isAccessible: true,
        isEnabled: true,
        source: 'wegent-connector',
      },
    ]

    expect(
      overlayMarketplaceLogosOnComposerApps(apps, [
        {
          id: 42,
          remotePluginId: 'wegent~Plugin_42',
          name: 'weibo-api-wiki',
          displayName: '微博开放平台内部WIKI',
          description: '',
          visibility: 'workspace',
          featured: false,
          installed: true,
          enabled: true,
          sourceType: 'marketplace',
          ownerUserId: 1,
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
          manifest: {},
          interface: { logo: 'data:image/png;base64,wiki' },
        },
      ])
    ).toEqual([
      expect.objectContaining({
        id: 'plugin:weibo-api-wiki',
        logoUrl: 'data:image/png;base64,wiki',
      }),
      expect.objectContaining({
        id: 'wegent:dingtalk',
        logoUrl: 'https://example.com/dingtalk.png',
      }),
    ])
  })
})
