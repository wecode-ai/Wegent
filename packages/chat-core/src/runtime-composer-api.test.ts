import { describe, expect, it, vi } from 'vitest'
import { createRuntimeComposerApi, decodeRuntimeSkills } from './runtime-composer-api'

const address = { deviceId: 'remote-device', taskId: 'side-task' }
const snapshot = {
  taskId: 'side-task',
  workspacePath: '/side-workspace',
  projectPluginIds: ['tool@local'],
  apps: [],
  marketplaces: [],
  skills: [],
  store: { storePath: '/executor/store', plugins: [] },
}

describe('addressed composer catalogs', () => {
  it('merges the addressed device cloud installs and fails when that membership is unavailable', async () => {
    const request = vi.fn().mockResolvedValue(snapshot)
    const listCloud = vi.fn().mockResolvedValue([])
    const api = createRuntimeComposerApi({ request }, listCloud)
    expect((await api.readCatalog(address)).cloudInstalledPlugins).toEqual([])
    expect(listCloud).toHaveBeenCalledWith('remote-device')
    listCloud.mockRejectedValueOnce(new Error('cloud inventory unavailable'))
    await expect(api.readCatalog(address)).rejects.toThrow('cloud inventory unavailable')
  })
  it('uses the selected device and task, leaving workspace resolution to the executor', async () => {
    const request = vi.fn().mockResolvedValue(snapshot)
    const api = createRuntimeComposerApi({ request }, async () => [])
    expect(
      await api.readCatalog({ ...address, workspacePath: '/stale-client-path' }, true)
    ).toMatchObject({ workspacePath: '/side-workspace', projectPluginIds: ['tool@local'] })
    expect(request).toHaveBeenCalledWith(
      'runtime.composer.catalog.read',
      { taskId: 'side-task', forceRefresh: true },
      'remote-device'
    )
    await api.searchWorkspaceEntries('remote-device', '/side-workspace', 'readme', 'search-id')
    expect(request).toHaveBeenLastCalledWith(
      'runtime.workspace.search',
      {
        deviceId: 'remote-device',
        root: '/side-workspace',
        query: 'readme',
        cancellationToken: 'search-id',
      },
      'remote-device'
    )
  })
  it('preserves disabled installed membership and inaccessible app flags for later merging', async () => {
    const request = vi.fn().mockResolvedValue({
      ...snapshot,
      apps: [{ id: 'app', name: 'App', isAccessible: false }],
      marketplaces: [
        {
          name: 'local',
          plugins: [{ name: 'tool', enabled: false, interface: { displayName: 'Tool' } }],
        },
      ],
      skills: [
        {
          cwd: '/side-workspace',
          skills: [{ name: 'pdf', path: '/side-workspace/pdf', scope: 'repo' }],
        },
      ],
      store: {
        storePath: '/store',
        plugins: [
          {
            name: 'managed',
            packageId: 'managed-id',
            enabled: true,
            marketplace: 'wegent',
            pluginPath: '/store/managed',
          },
        ],
      },
    })
    const result = await createRuntimeComposerApi({ request }, async () => []).readCatalog(address)
    expect(result.apps[0]).toMatchObject({ id: 'app', isAccessible: false })
    expect(result.marketplaces[0].plugins[0]).toMatchObject({ name: 'tool', enabled: false })
    expect(result.skills[0]).toMatchObject({ name: 'pdf', path: '/side-workspace/pdf' })
    expect(result.store.plugins[0]).toMatchObject({ packageId: 'managed-id' })
  })
  it('rejects a snapshot for another task and malformed sources', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...snapshot, taskId: 'main-task' })
      .mockResolvedValueOnce({ ...snapshot, store: { storePath: '/store', plugins: [{}] } })
      .mockRejectedValueOnce(new Error('offline'))
    const api = createRuntimeComposerApi({ request }, async () => [])
    await expect(api.readCatalog(address)).rejects.toThrow('another task')
    await expect(api.readCatalog(address)).rejects.toThrow('identifier')
    await expect(api.readCatalog(address)).rejects.toThrow('offline')
    await expect(api.readCatalog({ ...address, taskId: '' })).rejects.toThrow('required')
    expect(request).toHaveBeenCalledTimes(3)
  })
  it('keeps the device command decoder used by other device tools', () => {
    const alpha = { name: 'Alpha', path: '/alpha', source_priority: 1, mtime: 2 }
    expect(
      decodeRuntimeSkills(
        JSON.stringify([
          { name: 'zeta', path: '/zeta' },
          alpha,
          { ...alpha, path: '/old', mtime: 1 },
          { ...alpha, path: '/lower', source_priority: 2, mtime: 10 },
        ])
      )
    ).toEqual([alpha, { name: 'zeta', path: '/zeta' }])
    expect(() => decodeRuntimeSkills({})).toThrow('Invalid runtime skill catalog')
  })
})
