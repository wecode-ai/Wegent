import { describe, expect, it, vi } from 'vitest'
import {
  composerAppsFromRuntimeSnapshot,
  createRuntimeComposerPluginSource,
} from './runtime-composer-plugin-source'
import { decodeRuntimeComposerSnapshot } from './runtime-composer-snapshot'
import { toInstalledPlugin } from './codex-installed-plugins'

const address = { deviceId: 'device-b', taskId: 'task-b' }
const translate = (key: string) => key
const wire = {
  taskId: 'task-b',
  workspacePath: '/workspace-b',
  projectPluginIds: [],
  apps: [],
  skills: [],
  marketplaces: [],
  store: { storePath: '/store', plugins: [] },
}
const plugin = {
  id: 'pdf',
  name: 'pdf',
  enabled: true,
  source: { path: './plugins/pdf' },
  interface: { displayName: 'PDF', logo: 'assets/icon.svg', defaultPrompt: 'Read this document' },
}
const snapshot = () =>
  decodeRuntimeComposerSnapshot(address, {
    ...wire,
    marketplaces: [{ name: 'local-tools', path: '/plugins', plugins: [plugin] }],
  })

describe('runtime composer plugin source', () => {
  it('merges a cloud installation with its device store package into one reference', () => {
    const value = snapshot()
    value.marketplaces = []
    const cloud = toInstalledPlugin(
      { name: 'wegent', plugins: [] },
      { ...plugin, installed: true },
      null,
      translate
    )
    cloud.spec.pluginId = 12
    cloud.spec.releaseId = 34
    cloud.metadata.labels = { id: 56 }
    value.cloudInstalledPlugins = [cloud]
    value.store.plugins = [
      {
        name: 'pdf',
        packageId: '12-wegent-pdf-1.0',
        marketplace: 'wegent',
        pluginPath: '/store/pdf',
        enabled: true,
        installedPluginId: 56,
      },
    ]
    const apps = composerAppsFromRuntimeSnapshot(value, address.deviceId, translate)
    expect(apps).toHaveLength(1)
    expect(apps[0]).toMatchObject({ id: 'plugin:pdf', name: 'PDF' })
    expect(apps[0].skillPath).toContain('pdf@')
  })
  it('uses PC normalization for installed references, metadata and local assets', () => {
    const apps = composerAppsFromRuntimeSnapshot(snapshot(), address.deviceId, translate)
    expect(apps).toHaveLength(1)
    expect(apps[0]).toMatchObject({
      id: 'plugin:pdf',
      name: 'PDF',
      logoUrl: '/plugins/plugins/pdf/assets/icon.svg',
      logoUrlDark: '/plugins/plugins/pdf/assets/icon.svg',
      skillPath: 'plugin://pdf@local-tools',
      trialTemplates: [{ name: 'Read this document', description: 'Read this document' }],
    })
  })

  it('coalesces menu readers, addresses the task and refreshes after settlement', async () => {
    const read = vi.fn().mockResolvedValue(snapshot())
    const resolveAsset = vi.fn().mockResolvedValue('data:image/svg+xml;base64,PHN2Zy8+')
    const source = createRuntimeComposerPluginSource(read, address, translate, resolveAsset)
    const [apps, skills] = await Promise.all([source.listApps(), source.listSkills()])
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(address, true)
    expect(apps[0].logoUrl).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    expect(skills).toEqual([])
    read.mockResolvedValueOnce(decodeRuntimeComposerSnapshot(address, wire))
    expect(await source.listApps()).toEqual([])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('surfaces failures and allows a fresh request without retaining partial catalogs', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot())
    const resolveAsset = vi
      .fn()
      .mockRejectedValueOnce(new Error('image offline'))
      .mockResolvedValue('data:image/png;base64,AA==')
    const source = createRuntimeComposerPluginSource(read, address, translate, resolveAsset)
    await expect(source.listApps()).rejects.toThrow('offline')
    await expect(source.listApps()).rejects.toThrow('image offline')
    expect(await source.listApps()).toHaveLength(1)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('keeps inaccessible apps inaccessible instead of adding a second selectable entry', () => {
    const value = snapshot()
    value.apps = [{ id: 'pdf', name: 'PDF', isAccessible: false }]
    const apps = composerAppsFromRuntimeSnapshot(value, address.deviceId, translate)
    expect(apps).toHaveLength(1)
    expect(apps[0].isAccessible).toBe(false)
  })

  it('uses explicit project enablement and the PC personal-marketplace preference', () => {
    const value = decodeRuntimeComposerSnapshot(address, {
      ...wire,
      marketplaces: [
        { name: 'personal', plugins: [plugin] },
        { name: 'wework-personal', plugins: [{ ...plugin, enabled: false }] },
      ],
    })
    expect(composerAppsFromRuntimeSnapshot(value, address.deviceId, translate)).toEqual([])
    value.projectPluginIds = ['pdf@wework-personal']
    const apps = composerAppsFromRuntimeSnapshot(value, address.deviceId, translate)
    expect(apps).toHaveLength(1)
    expect(apps[0].skillPath).toContain('wework-personal')
  })
})
