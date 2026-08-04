import { describe, expect, test, vi } from 'vitest'
import type { CloudProject, CloudProjectLocalBinding } from '@/api/deliveries'
import {
  findProjectSpaceContextForTask,
  loadProjectSpaceBindingOptions,
  readCachedAutoJoinProjectSpace,
  saveAutoJoinProjectSpace,
  type ProjectSpaceBindingApi,
} from './projectSpaceLocalBindings'

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

function binding(
  id: string,
  projectId: string,
  localProjectId: number,
  isDefault: boolean
): CloudProjectLocalBinding {
  return {
    id,
    cloud_project_id: projectId,
    local_project_id: localProjectId,
    device_id: 'device-1',
    is_default: isDefault,
    created_at: '2026-08-04T00:00:00Z',
    updated_at: '2026-08-04T00:00:00Z',
  }
}

function api(
  cloudProject: CloudProject,
  localBindings: CloudProjectLocalBinding[]
): ProjectSpaceBindingApi {
  return {
    listCloudProjects: vi.fn().mockResolvedValue({ items: [cloudProject] }),
    listLocalBindings: vi.fn().mockResolvedValue(localBindings),
    updateLocalBinding: vi.fn().mockImplementation(async (_projectId, bindingId, data) => ({
      ...localBindings.find(candidate => candidate.id === bindingId)!,
      ...data,
    })),
    addLocalBinding: vi.fn(),
  } as unknown as ProjectSpaceBindingApi
}

describe('projectSpaceLocalBindings', () => {
  test('moves automatic joining between local and cloud project-space stores', async () => {
    window.localStorage.clear()
    const localProjectId = 7
    const firstProject = project('space-local', 'Local board', 'local')
    const secondProject = project('space-cloud', 'Cloud board', 'backend')
    const firstBinding = binding('binding-local', firstProject.id, localProjectId, true)
    const secondBinding = binding('binding-cloud', secondProject.id, localProjectId, false)
    const localApi = api(firstProject, [firstBinding])
    const cloudApi = api(secondProject, [secondBinding])

    const options = await loadProjectSpaceBindingOptions(
      [localApi, cloudApi],
      localProjectId,
      'device-1'
    )
    await saveAutoJoinProjectSpace(options, 'backend:space-cloud', localProjectId, 'device-1')

    expect(cloudApi.updateLocalBinding).toHaveBeenCalledWith(secondProject.id, secondBinding.id, {
      is_default: true,
    })
    expect(localApi.updateLocalBinding).toHaveBeenCalledWith(firstProject.id, firstBinding.id, {
      is_default: false,
    })
    expect(readCachedAutoJoinProjectSpace(localProjectId, 'device-1')).toEqual(secondProject)
  })

  test('finds a local project-space context when the cloud store has no binding', async () => {
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
    } as unknown as ProjectSpaceBindingApi
    const localApi = {
      findCloudContextForTask: vi.fn().mockResolvedValue(context),
    } as unknown as ProjectSpaceBindingApi

    await expect(
      findProjectSpaceContextForTask([cloudApi, localApi], {
        deviceId: 'device-1',
        taskId: 'task-1',
      })
    ).resolves.toEqual(context)
  })
})
