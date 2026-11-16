// @vitest-environment node

import type { CloudProject } from '@/api/deliveries'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/api/http'
import { DshExecutorTransportError } from '@/api/dsh/executorTransport'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  canEditProjectSpaceIssue,
  findProjectSpaceContextForTask,
  findProjectSpaceContextForTaskInStores,
  forgetProjectSpaceTaskBinding,
  loadProjectSpaceOptions,
  projectSpaceRef,
  projectSpaceForRuntimeTask,
  ProjectSpaceTaskContextUnavailableError,
  rememberProjectSpaceTaskBinding,
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
  test('fails closed for cloud Issues and trusts only the explicit local marker', () => {
    expect(
      canEditProjectSpaceIssue({
        project_store: 'backend',
        can_edit: undefined,
      })
    ).toBe(false)
    expect(
      canEditProjectSpaceIssue({
        project_store: 'backend',
        can_edit: true,
      })
    ).toBe(true)
    expect(
      canEditProjectSpaceIssue({
        project_store: 'local',
        can_edit: undefined,
      })
    ).toBe(true)
  })

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

  test('does not let an unavailable store block a resolved task context', async () => {
    const context = {
      id: 'context-1',
      device_id: 'device-1',
      task_id: 'task-1',
      cloud_project_id: 'space-local',
      loop_item_id: 'todo-1',
      project: project('space-local', 'Local board', 'local'),
      loop_item: null,
    }
    const localApi = {
      findCloudContextForTask: vi.fn().mockResolvedValue(context),
    } as unknown as ProjectSpaceApi
    const unavailableCloudApi = {
      findCloudContextForTask: vi.fn().mockImplementation(() => new Promise(() => {})),
    } as unknown as ProjectSpaceApi

    const lookup = findProjectSpaceContextForTask(
      [localApi, unavailableCloudApi],
      {
        deviceId: 'device-1',
        taskId: 'task-1',
      },
      5_000
    )
    let deadlineId: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      deadlineId = setTimeout(
        () => reject(new Error('Resolved context was blocked by another store')),
        500
      )
    })

    try {
      await expect(Promise.race([lookup, deadline])).resolves.toEqual(context)
    } finally {
      if (deadlineId !== undefined) clearTimeout(deadlineId)
    }
  })

  test('only scopes runtime creation to backend project spaces', () => {
    expect(runtimeCloudProjectId(project('space-local', 'Local board', 'local'))).toBeUndefined()
    expect(runtimeCloudProjectId(project('space-cloud', 'Cloud board', 'backend'))).toBe(
      'space-cloud'
    )
    expect(runtimeCloudProjectId(null)).toBeUndefined()
  })
})

describe('known project context lifecycle', () => {
  const task: RuntimeTaskAddress = { deviceId: 'device-context-source', taskId: 'current-task' }
  const localProject = project('known-local', 'Local', 'local')
  const backendProject = project('known-backend', 'Backend', 'backend')
  const sources = () => ({
    local: {
      findCloudContextForTask: vi
        .fn()
        .mockResolvedValue({ project: localProject, loop_item: null }),
    },
    backend: {
      findCloudContextForTask: vi
        .fn()
        .mockResolvedValue({ project: backendProject, loop_item: null }),
    },
  })
  afterEach(() => {
    const binding = projectSpaceForRuntimeTask(task)
    if (binding) forgetProjectSpaceTaskBinding(task, binding)
  })

  test.each(['local', 'backend'] as const)(
    'invalidates a missing %s binding before discovery',
    async store => {
      const apis = sources()
      const expected = store === 'local' ? localProject : backendProject
      const other = store === 'local' ? backendProject : localProject
      const missing =
        store === 'local'
          ? new DshExecutorTransportError('not_found', 'Task not found')
          : new ApiError('Task not linked', 404)
      rememberProjectSpaceTaskBinding(task, projectSpaceRef(expected))
      apis[store].findCloudContextForTask.mockRejectedValue(missing)
      await expect(
        findProjectSpaceContextForTaskInStores(task, apis.local, apis.backend)
      ).resolves.toEqual({ project: other, loop_item: null })
      expect(projectSpaceForRuntimeTask(task)).toBeUndefined()
      expect(apis[store].findCloudContextForTask).toHaveBeenCalledTimes(2)
      expect(
        apis[store === 'local' ? 'backend' : 'local'].findCloudContextForTask
      ).toHaveBeenCalledOnce()
    }
  )

  test.each([
    new ApiError('Forbidden', 403),
    new ApiError('Service unavailable', 503),
    new DshExecutorTransportError('transport_failed', 'Connection interrupted'),
    new Error('Task not found'),
  ])('keeps the known source and mapping for $message', async error => {
    const apis = sources()
    rememberProjectSpaceTaskBinding(task, projectSpaceRef(localProject))
    apis.local.findCloudContextForTask.mockRejectedValue(error)
    await expect(
      findProjectSpaceContextForTaskInStores(task, apis.local, apis.backend)
    ).rejects.toMatchObject({ errors: [error] })
    expect(apis.local.findCloudContextForTask).toHaveBeenCalledOnce()
    expect(apis.backend.findCloudContextForTask).not.toHaveBeenCalled()
    expect(projectSpaceForRuntimeTask(task)).toEqual(projectSpaceRef(localProject))
  })

  test('restores discovery and its nondefault priority after the actual project mismatches cache', async () => {
    const apis = sources()
    const defaultProject = {
      ...localProject,
      id: 'default-work-items',
      project_key: 'WORK',
      metadata: { system_kind: 'default_work_items' },
    }
    apis.local.findCloudContextForTask.mockResolvedValue({
      project: defaultProject,
      loop_item: null,
    })
    rememberProjectSpaceTaskBinding(task, projectSpaceRef(localProject))
    await expect(
      findProjectSpaceContextForTaskInStores(task, apis.local, apis.backend)
    ).resolves.toEqual({ project: backendProject, loop_item: null })
    expect(projectSpaceForRuntimeTask(task)).toBeUndefined()
    expect(apis.local.findCloudContextForTask).toHaveBeenCalledTimes(2)
    expect(apis.backend.findCloudContextForTask).toHaveBeenCalledOnce()
  })

  test('does not discover local contexts after a project-session authorization miss', async () => {
    const apis = sources()
    const missing = new ApiError('Project session unavailable', 404)
    rememberProjectSpaceTaskBinding(task, projectSpaceRef(localProject))
    apis.backend.findCloudContextForTask.mockRejectedValue(missing)
    await expect(
      findProjectSpaceContextForTaskInStores(
        { ...task, projectSession: { projectId: 'cloud-project', issueId: 'cloud-issue' } },
        apis.local,
        apis.backend
      )
    ).rejects.toMatchObject({ errors: [missing] })
    expect(apis.local.findCloudContextForTask).not.toHaveBeenCalled()
    expect(projectSpaceForRuntimeTask(task)).toEqual(projectSpaceRef(localProject))
  })

  test('invalidates an actual store mismatch even when the project ID is unchanged', async () => {
    const apis = sources()
    const actualProject = { ...backendProject, id: localProject.id }
    rememberProjectSpaceTaskBinding(task, projectSpaceRef(localProject))
    apis.local.findCloudContextForTask.mockResolvedValue({
      project: actualProject,
      loop_item: null,
    })
    await expect(
      findProjectSpaceContextForTaskInStores(task, apis.local, apis.backend)
    ).resolves.toEqual({ project: actualProject, loop_item: null })
    expect(projectSpaceForRuntimeTask(task)).toBeUndefined()
    expect(apis.local.findCloudContextForTask).toHaveBeenCalledTimes(2)
    expect(apis.backend.findCloudContextForTask).toHaveBeenCalledOnce()
  })

  test('does not erase a newer binding when the old owner reports a late miss', async () => {
    const apis = sources()
    let rejectInitial!: (error: unknown) => void
    apis.local.findCloudContextForTask.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectInitial = reject
        })
    )
    rememberProjectSpaceTaskBinding(task, projectSpaceRef(localProject))
    const lookup = findProjectSpaceContextForTaskInStores(task, apis.local, apis.backend)
    rememberProjectSpaceTaskBinding(task, projectSpaceRef(backendProject))
    rejectInitial(new ApiError('No previous binding', 404))
    await expect(lookup).rejects.toBeInstanceOf(AggregateError)
    expect(projectSpaceForRuntimeTask(task)).toEqual(projectSpaceRef(backendProject))
    expect(apis.backend.findCloudContextForTask).not.toHaveBeenCalled()
  })

  test('reports an unavailable known owner without substituting another store', async () => {
    const apis = sources()
    rememberProjectSpaceTaskBinding(task, projectSpaceRef(backendProject))
    await expect(
      findProjectSpaceContextForTaskInStores(task, apis.local, undefined)
    ).rejects.toBeInstanceOf(ProjectSpaceTaskContextUnavailableError)
    expect(apis.local.findCloudContextForTask).not.toHaveBeenCalled()
    expect(projectSpaceForRuntimeTask(task)).toEqual(projectSpaceRef(backendProject))
  })
})
