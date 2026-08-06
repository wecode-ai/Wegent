import { describe, expect, test, vi } from 'vitest'
import type { InstalledPlugin, LocalDeviceApp } from '@/types/api'
import { loadComposerPluginApps } from './loadComposerPluginApps'

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
  test('still lists cloud installs when local Codex state read fails', async () => {
    const apps = await loadComposerPluginApps({
      listCodexApps: vi.fn().mockResolvedValue([] as LocalDeviceApp[]),
      readLocalInstalledPlugins: vi.fn().mockRejectedValue(new Error('codex unavailable')),
      listCloudInstalledPlugins: vi.fn().mockResolvedValue([dingtalk]),
    })

    expect(apps).toEqual([
      expect.objectContaining({
        id: 'plugin:dingtalk',
        name: '钉钉',
        skillPath: 'plugin://dingtalk@wegent',
      }),
    ])
  })

  test('maps cloud installs even when merge filters would drop incomplete local rows', async () => {
    const apps = await loadComposerPluginApps({
      listCodexApps: async () => [],
      readLocalInstalledPlugins: async () => [],
      listCloudInstalledPlugins: async () => [dingtalk],
    })
    expect(apps.map(app => app.id)).toEqual(['plugin:dingtalk'])
  })
})
