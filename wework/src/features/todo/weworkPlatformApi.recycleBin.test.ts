import { describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi, WorkspaceRecycleBinItem } from '@wegent/collaboration'
import { createWeworkPlatformApi } from './weworkPlatformApi'
import { LOCAL_WORKSPACE_ID } from './localWorkspaceApi'

const item: WorkspaceRecycleBinItem = {
  id: 'deleted-local-project',
  kind: 'project',
  name: 'Deleted',
  workspaceId: LOCAL_WORKSPACE_ID,
  workspaceName: 'Local',
  version: 2,
  deletedAt: '2026-11-06T00:00:00Z',
  parentDeleted: false,
}

function source(items: WorkspaceRecycleBinItem[]): SharedWorkspaceApi {
  return {
    workspaces: {},
    projects: { list: vi.fn(async () => []) },
    recycleBin: {
      list: vi.fn(async () => ({ items, errors: [] })),
      restore: vi.fn(async () => undefined),
    },
  } as unknown as SharedWorkspaceApi
}

describe('unified recycle bin', () => {
  it('routes local recovery without searching the active catalog', async () => {
    const cloud = source([])
    const local = source([item])
    const api = createWeworkPlatformApi(cloud, local)!
    await api.recycleBin!.restore(item)
    expect(local.recycleBin!.restore).toHaveBeenCalledWith(item)
    expect(cloud.recycleBin!.restore).not.toHaveBeenCalled()
    expect(local.projects.list).not.toHaveBeenCalled()
    const cloudItem = { ...item, id: '12', workspaceId: '42' }
    await api.recycleBin!.restore(cloudItem)
    expect(cloud.recycleBin!.restore).toHaveBeenCalledWith(cloudItem)
  })

  it('keeps local recovery available and explicitly reports cloud failures', async () => {
    const cloud = source([])
    cloud.recycleBin!.list = vi.fn(async () => {
      throw new Error('Cloud offline')
    })
    const api = createWeworkPlatformApi(cloud, source([item]))!
    expect(await api.recycleBin!.list()).toEqual({ items: [item], errors: ['Cloud offline'] })
  })
})
