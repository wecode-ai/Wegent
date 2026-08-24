import { describe, expect, test, vi } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import {
  findProjectSpaceContextForTask,
  loadProjectSpaceOptions,
  projectSpaceRef,
  runtimeCloudProjectId,
  type ProjectSpaceApi,
} from './projectSpaceSelection'

function project(id: string, name: string, projectStore: 'local' | 'backend'): CloudProject {
  return {
    id,
    public_id: `public-${id}`,
    project_key: id.toUpperCase(),
    name,
    description: '',
    project_store: projectStore,
    task_provider: projectStore === 'local' ? 'local' : 'native',
    provider_config: {},
    created_by_user_id: 1,
    status: 'active',
    tags: [],
    version: 1,
    created_at: '2026-08-04T00:00:00Z',
    updated_at: '2026-08-04T00:00:00Z',
  }
}

describe('projectSpaceSelection', () => {
  test('lists local and cloud project spaces without querying per-project bindings', async () => {
    const defaultProject = {
      ...project('default-work-items', 'My Tasks', 'local'),
      project_key: 'WORK',
      metadata: { system_kind: 'default_work_items' },
    }
    const localProject = project('space-local', 'Local board', 'local')
    const cloudProject = project('space-cloud', 'Cloud board', 'backend')
    const localApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [defaultProject, localProject] }),
    } as unknown as ProjectSpaceApi
    const cloudApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [cloudProject] }),
    } as unknown as ProjectSpaceApi

    await expect(loadProjectSpaceOptions([localApi, cloudApi])).resolves.toEqual([
      {
        key: 'backend:space-cloud',
        project: cloudProject,
        api: cloudApi,
      },
      {
        key: 'local:space-local',
        project: localProject,
        api: localApi,
      },
    ])
    expect(projectSpaceRef(cloudProject)).toEqual({
      projectStore: 'backend',
      projectId: 'space-cloud',
    })
  })

  test('finds a local project-space context when the cloud store has no context', async () => {
    const context = {
      id: 'context-1',
      device_id: 'device-1',
      task_id: 'task-1',
      cloud_project_id: 'space-local',
      loop_item_id: 'todo-1',
      project: project('space-local', 'Local board', 'local'),
      loop_item: null,
    }
    const cloudApi = {
      findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not found')),
    } as unknown as ProjectSpaceApi
    const localApi = {
      findCloudContextForTask: vi.fn().mockResolvedValue(context),
    } as unknown as ProjectSpaceApi

    await expect(
      findProjectSpaceContextForTask([cloudApi, localApi], {
        deviceId: 'device-1',
        taskId: 'task-1',
      })
    ).resolves.toEqual(context)
  })

  test('prefers a user Issue over the system My Tasks Issue across stores', async () => {
    const localContext = {
      id: 'local-context',
      device_id: 'device-1',
      task_id: 'task-1',
      cloud_project_id: 'default-work-items',
      loop_item_id: 'todo-local',
      project: {
        ...project('default-work-items', 'My Tasks', 'local'),
        project_key: 'WORK',
        metadata: { system_kind: 'default_work_items' },
      },
      loop_item: null,
    }
    const cloudContext = {
      ...localContext,
      id: 'cloud-context',
      cloud_project_id: 'space-cloud',
      loop_item_id: 'todo-cloud',
      project: project('space-cloud', 'Cloud board', 'backend'),
    }
    const localApi = {
      findCloudContextForTask: vi.fn().mockResolvedValue(localContext),
    } as unknown as ProjectSpaceApi
    const cloudApi = {
      findCloudContextForTask: vi.fn().mockResolvedValue(cloudContext),
    } as unknown as ProjectSpaceApi

    await expect(
      findProjectSpaceContextForTask([localApi, cloudApi], {
        deviceId: 'device-1',
        taskId: 'task-1',
      })
    ).resolves.toEqual(cloudContext)
    expect(localApi.findCloudContextForTask).toHaveBeenCalledOnce()
    expect(cloudApi.findCloudContextForTask).toHaveBeenCalledOnce()
  })

  test('only scopes runtime creation to backend project spaces', () => {
    expect(runtimeCloudProjectId(project('space-local', 'Local board', 'local'))).toBeUndefined()
    expect(runtimeCloudProjectId(project('space-cloud', 'Cloud board', 'backend'))).toBe(
      'space-cloud'
    )
    expect(runtimeCloudProjectId(null)).toBeUndefined()
  })
})
