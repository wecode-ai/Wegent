import { describe, expect, test, vi } from 'vitest'
import type { InstalledPlugin, LocalDeviceApp } from '@/types/api'
import { loadComposerPluginApps } from './loadComposerPluginApps'
import { composerAppsFromRuntimeSnapshot } from '@wegent/chat-core/runtime-composer-plugin-source'

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

describe('loadComposerPluginApps', () => {
  test('matches the browser inventory and excludes cloud rows without release membership', async () => {
    const incomplete = { ...dingtalk, spec: { ...dingtalk.spec, releaseId: null } }
    for (const cloud of [[dingtalk], [incomplete], []]) {
      const native = await loadComposerPluginApps({
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
    const apps = await loadComposerPluginApps({
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

    const apps = await loadComposerPluginApps(
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
      await expect(loadComposerPluginApps(sources)).rejects.toThrow('catalog unavailable')
    }
  )

  test('maps installed cloud rows with valid membership', async () => {
    const apps = await loadComposerPluginApps({
      deviceId: 'local-device',
      listCodexApps: async () => [],
      readLocalInstalledPlugins: async () => [],
      listCloudInstalledPlugins: async () => [dingtalk],
    })
    expect(apps.map(app => app.id)).toEqual(['plugin:dingtalk'])
  })

  test('does not make an inaccessible Codex connector selectable through its installed plugin', async () => {
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

    const apps = await loadComposerPluginApps({
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
        id: 'connector_5f3c8c41a1e54ad7a76272c89e2554fa',
        isAccessible: false,
        source: 'codex-app',
      }),
    ])
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

    const hiddenApps = await loadComposerPluginApps({
      deviceId: 'local-device',
      listCodexApps: async () => [],
      readLocalInstalledPlugins: async () => [projectPlugin],
      listCloudInstalledPlugins: async () => [],
    })
    expect(hiddenApps).toEqual([])

    const projectApps = await loadComposerPluginApps(
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

    const apps = await loadComposerPluginApps(
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
