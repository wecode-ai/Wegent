import { describe, expect, it, vi } from 'vitest'
import { loadLocalComposerApps } from './localComposerCatalog'

const target = { deviceId: 'phone', taskId: 'conversation' }
const wire = {
  taskId: 'conversation',
  workspacePath: '/root/project',
  projectPluginIds: [],
  apps: [],
  skills: [],
  marketplaces: [],
  store: { storePath: '/store', plugins: [] },
}
const plugin = {
  name: 'pdf',
  enabled: true,
  source: { path: './pdf' },
  interface: { displayName: 'PDF', logo: 'icon.svg' },
}
const setup = (response: unknown = wire) => ({
  target,
  runtime: {
    ownsDevice: (deviceId: string) => deviceId === 'phone',
    request: vi.fn().mockResolvedValue(response),
  },
  translate: (key: string) => key,
  resolveAsset: vi.fn().mockResolvedValue('data:image/svg+xml;base64,PHN2Zy8+'),
})

describe('local composer catalog', () => {
  it('loads native plugins and skills in one task-addressed request', async () => {
    const options = setup({
      ...wire,
      marketplaces: [{ name: 'local-tools', path: '/plugins', plugins: [plugin] }],
      skills: [
        {
          skills: [
            { name: 'review', path: '/system/review/SKILL.md', scope: 'system' },
            { name: 'review', path: '/root/.agents/skills/review/SKILL.md', scope: 'user' },
            { name: 'disabled', path: '/disabled/SKILL.md', enabled: false },
          ],
        },
      ],
    })
    const result = await loadLocalComposerApps(options)
    expect(options.runtime.request).toHaveBeenCalledExactlyOnceWith(
      'runtime.composer.catalog.read',
      { taskId: 'conversation', forceRefresh: true }
    )
    expect(result.map(app => app.reference)).toEqual([
      '[$PDF](plugin://pdf@local-tools)',
      '[$review](/root/.agents/skills/review/SKILL.md)',
    ])
    expect(result[0].logoUrl).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    expect(options.resolveAsset).toHaveBeenCalledWith('/plugins/pdf/icon.svg')
  })

  it('uses PC project enablement for locally disabled plugins', async () => {
    const options = setup({
      ...wire,
      marketplaces: [{ name: 'local-tools', plugins: [{ ...plugin, enabled: false }] }],
    })
    expect(await loadLocalComposerApps(options)).toEqual([])
    options.runtime.request.mockResolvedValue({
      ...wire,
      projectPluginIds: ['pdf@local-tools'],
      marketplaces: [{ name: 'local-tools', plugins: [{ ...plugin, enabled: false }] }],
    })
    expect((await loadLocalComposerApps(options))[0].reference).toBe(
      '[$PDF](plugin://pdf@local-tools)'
    )
  })

  it('uses workspace scope before a conversation exists and rejects mismatched ownership', async () => {
    const options = setup({ ...wire, scope: 'workspace', taskId: null })
    await loadLocalComposerApps({
      ...options,
      target: {
        deviceId: 'phone',
        scope: 'workspace',
        workspacePath: '/root/project',
      },
    })
    expect(options.runtime.request).toHaveBeenCalledWith('runtime.composer.catalog.read', {
      scope: 'workspace',
      workspacePath: '/root/project',
      forceRefresh: true,
    })
    await expect(
      loadLocalComposerApps({ ...options, target: { ...target, deviceId: 'remote' } })
    ).rejects.toThrow('插件目录不属于当前手机执行环境')
    options.runtime.request.mockResolvedValue({ ...wire, taskId: 'another-task' })
    await expect(loadLocalComposerApps(options)).rejects.toThrow(
      'Composer catalog belongs to another task'
    )
  })

  it('surfaces native catalog and local asset failures', async () => {
    const options = setup()
    options.runtime.request.mockRejectedValue(new Error('runtime stopped'))
    await expect(loadLocalComposerApps(options)).rejects.toThrow('runtime stopped')
    options.runtime.request.mockResolvedValue({
      ...wire,
      marketplaces: [{ name: 'local-tools', path: '/plugins', plugins: [plugin] }],
    })
    options.resolveAsset.mockRejectedValue(new Error('asset unavailable'))
    await expect(loadLocalComposerApps(options)).rejects.toThrow('asset unavailable')
  })
})
