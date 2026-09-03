import { describe, expect, it, test, vi } from 'vitest'
import type { HttpClient } from './http'
import { ApiError } from './http'
import {
  DEFAULT_WORK_ITEM_PROJECT_ID,
  DEFAULT_WORK_ITEM_PROJECT_KEY,
  createDeliveryApi,
  isDefaultWorkItemProject,
  nextTaskTrackingStatus,
  type CloudLoopItem,
  type CloudTaskContext,
} from './deliveries'

describe('createDeliveryApi queue and assignment routes', () => {
  it('recognizes only the canonical default work-item project', () => {
    const canonical = {
      id: DEFAULT_WORK_ITEM_PROJECT_ID,
      project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
    } as CloudTaskContext['project']
    expect(isDefaultWorkItemProject(canonical)).toBe(true)
    expect(isDefaultWorkItemProject({ ...canonical, id: 'user-board' })).toBe(false)
    expect(
      isDefaultWorkItemProject({
        ...canonical,
        metadata: { system_kind: 'user_project' },
      })
    ).toBe(false)
  })

  it('moves completed runtime tasks to review until the user completes them', () => {
    expect(nextTaskTrackingStatus('inbox', 'queued')).toBe('pending')
    expect(nextTaskTrackingStatus('pending', 'queued')).toBeNull()
    expect(nextTaskTrackingStatus('in_progress', 'succeeded')).toBe('in_review')
    expect(nextTaskTrackingStatus('completed', 'running')).toBe('in_progress')
    expect(nextTaskTrackingStatus('in_review', 'archived')).toBe('completed')
    expect(nextTaskTrackingStatus('in_progress', 'cancelled')).toBe('in_review')
    expect(nextTaskTrackingStatus('pending', 'failed')).toBe('in_review')
    expect(nextTaskTrackingStatus('pending', 'succeeded')).toBe('in_review')
  })

  it('lists loop items with queue filters', async () => {
    const client = {
      get: vi.fn(async () => ({ items: [] })),
    } as unknown as HttpClient
    const api = createDeliveryApi(client)

    await api.listLoopItems(123, {
      assigneeType: 'agent',
      assigneeId: 'bot-1',
      executionState: 'queued',
    })

    expect(client.get).toHaveBeenCalledWith(
      '/v1/cloud-projects/123/loop-items?assignee_type=agent&assignee_id=bot-1&execution_state=queued'
    )
  })

  it('loads the complete board snapshot through one request', async () => {
    const client = {
      get: vi.fn(async () => ({
        items: [],
        task_bindings: [],
        members: [],
        agents: [],
      })),
    } as unknown as HttpClient
    const api = createDeliveryApi(client)

    await api.getBoardSnapshot(123)

    expect(client.get).toHaveBeenCalledOnce()
    expect(client.get).toHaveBeenCalledWith('/v1/cloud-projects/123/board-snapshot')
  })

  it('loads one external board column page without requesting issue details', async () => {
    const client = {
      get: vi.fn(async () => ({ items: [], task_bindings: [], next_cursor: null })),
    } as unknown as HttpClient
    const api = createDeliveryApi(client)

    await api.listLoopItemsPage(123, {
      status: 'in_progress',
      parentId: 'GH-7',
      cursor: 'next-page',
    })

    expect(client.get).toHaveBeenCalledWith(
      '/v1/cloud-projects/123/loop-item-pages?status=in_progress&limit=10&parent_id=GH-7&cursor=next-page'
    )
  })

  it('lists robot executions through the cloud executions route', async () => {
    const client = {
      get: vi.fn(async () => ({
        items: [
          {
            id: 101,
            loopItemId: 'GL-1',
            cloudProjectId: '11',
            taskTitle: 'Bot queued task',
            taskStatus: 'pending',
            taskPriority: 'medium',
            agentId: 'bot-1',
            assignerUserId: 2,
            status: 'queued',
            version: 1,
            createdAt: '2026-08-07T00:00:00Z',
            updatedAt: '2026-08-07T00:00:00Z',
          },
        ],
        total: 1,
      })),
    } as unknown as HttpClient
    const api = createDeliveryApi(client)

    const response = await api.listLoopItemExecutions(123, { agent_id: 'bot-1' })

    expect(client.get).toHaveBeenCalledWith('/v1/cloud-projects/123/executions?agent_id=bot-1')
    expect(response.items[0]).toMatchObject({
      loop_item_id: 'GL-1',
      task_title: 'Bot queued task',
      agent_id: 'bot-1',
      status: 'queued',
    })
  })

  it('stops an execution through the project route', async () => {
    const client = {
      post: vi.fn(async () => ({ id: 202, status: 'cancelled' })),
    } as unknown as HttpClient
    const api = createDeliveryApi(client)

    const response = await api.stopExecution(123, 202)

    expect(client.post).toHaveBeenCalledWith('/v1/cloud-projects/123/executions/202/stop')
    expect(response).toMatchObject({ id: 202, status: 'cancelled' })
  })

  it('assigns a task to a robot through the project route', async () => {
    const client = {
      post: vi.fn(async () => ({})),
    } as unknown as HttpClient
    const api = createDeliveryApi(client)

    await api.assignLoopItem(123, 'task-1', {
      version: 3,
      assigneeType: 'agent',
      assigneeId: 'bot-1',
    })

    expect(client.post).toHaveBeenCalledWith('/v1/cloud-projects/123/loop-items/task-1/assign', {
      version: 3,
      assigneeType: 'agent',
      assigneeId: 'bot-1',
    })
  })

  it('assigns a task to a project member with a string user id', async () => {
    const client = {
      post: vi.fn(async () => ({})),
    } as unknown as HttpClient
    const api = createDeliveryApi(client)

    await api.assignLoopItem(123, 'task-1', {
      version: 3,
      assigneeType: 'user',
      assigneeId: '42',
    })

    expect(client.post).toHaveBeenCalledWith('/v1/cloud-projects/123/loop-items/task-1/assign', {
      version: 3,
      assigneeType: 'user',
      assigneeId: '42',
    })
  })

  it('approves and rejects pending robot runs', async () => {
    const client = {
      post: vi.fn(async () => ({})),
    } as unknown as HttpClient
    const api = createDeliveryApi(client)

    await api.approveLoopItemRun(123, 'task-1', 4)
    await api.rejectLoopItemRun(123, 'task-1', 4, 'not now')

    expect(client.post).toHaveBeenNthCalledWith(
      1,
      '/v1/cloud-projects/123/loop-items/task-1/approve',
      { version: 4 }
    )
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      '/v1/cloud-projects/123/loop-items/task-1/reject',
      { version: 4, reason: 'not now' }
    )
  })
})

const trackedItem: CloudLoopItem = {
  id: 'WEG-1',
  cloud_project_id: 'project-1',
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  assignee_user_id: null,
  title: 'Runtime task',
  description: 'Track this task',
  status: 'in_progress',
  priority: 'none',
  due_at: null,
  tags: [],
  sort_order: 1,
  current_delivery_id: null,
  version: 1,
  created_at: '2026-08-05T00:00:00Z',
  updated_at: '2026-08-05T00:00:00Z',
  completed_at: null,
}

function clientWith(methods: Partial<HttpClient>): HttpClient {
  return methods as HttpClient
}

describe('createDeliveryApi task tracking', () => {
  test('creates and binds a board item through stable project APIs', async () => {
    const get = vi.fn().mockRejectedValue(new ApiError('Cloud context not found', 404))
    const post = vi.fn().mockResolvedValueOnce(trackedItem).mockResolvedValueOnce(undefined)
    const api = createDeliveryApi(clientWith({ get, post }))
    const task = { deviceId: 'local-device', taskId: 'runtime-1' }

    const first = api.trackProjectTask('project-1', task, 'Runtime task', 'Track this task')
    const second = api.trackProjectTask(
      'project-1',
      task,
      'Changed during rendering',
      'Changed during rendering'
    )

    await expect(Promise.all([first, second])).resolves.toEqual([
      { item: trackedItem },
      { item: trackedItem },
    ])
    expect(get).toHaveBeenCalledOnce()
    expect(post).toHaveBeenNthCalledWith(1, '/v1/cloud-projects/project-1/loop-items', {
      title: 'Runtime task',
      description: 'Track this task',
      status: 'pending',
    })
    expect(post).toHaveBeenNthCalledWith(2, '/v1/loop-items/WEG-1/tasks', {
      ...task,
      taskTitle: 'Runtime task',
    })
    expect(post).toHaveBeenCalledTimes(2)
  })

  test('creates default My Tasks items in inbox before runtime status synchronization', async () => {
    const inboxItem = {
      ...trackedItem,
      cloud_project_id: DEFAULT_WORK_ITEM_PROJECT_ID,
      status: 'inbox' as const,
    }
    const get = vi.fn().mockRejectedValue(new ApiError('Cloud context not found', 404))
    const post = vi.fn().mockResolvedValueOnce(inboxItem).mockResolvedValueOnce(undefined)
    const api = createDeliveryApi(clientWith({ get, post }))

    await api.trackProjectTask(
      DEFAULT_WORK_ITEM_PROJECT_ID,
      { deviceId: 'local-device', taskId: 'runtime-1' },
      'Runtime task',
      ''
    )

    expect(post).toHaveBeenNthCalledWith(
      1,
      `/v1/cloud-projects/${DEFAULT_WORK_ITEM_PROJECT_ID}/loop-items`,
      {
        title: 'Runtime task',
        description: '',
        status: 'inbox',
      }
    )
  })

  test('reuses a created board item when binding is retried', async () => {
    const get = vi.fn().mockRejectedValue(new ApiError('Cloud context not found', 404))
    const post = vi
      .fn()
      .mockResolvedValueOnce(trackedItem)
      .mockRejectedValueOnce(new Error('Temporary bind failure'))
      .mockResolvedValueOnce(undefined)
    const api = createDeliveryApi(clientWith({ get, post }))
    const task = { deviceId: 'local-device', taskId: 'runtime-1' }

    await expect(
      api.trackProjectTask('project-1', task, 'Runtime task', 'Track this task')
    ).rejects.toThrow('Temporary bind failure')
    await expect(
      api.trackProjectTask('project-1', task, 'Runtime task', 'Track this task')
    ).resolves.toEqual({ item: trackedItem })

    expect(post).toHaveBeenCalledTimes(3)
    expect(post.mock.calls.filter(([endpoint]) => endpoint.endsWith('/loop-items'))).toHaveLength(1)
  })

  test('creates a new board item when moving a task from another project', async () => {
    const get = vi.fn().mockResolvedValue({
      project: { id: 'project-old' },
      loop_item_id: 'OLD-1',
    })
    const movedItem = { ...trackedItem, id: 'NEW-1', cloud_project_id: 'project-new' }
    const post = vi.fn().mockResolvedValueOnce(movedItem).mockResolvedValueOnce(undefined)
    const api = createDeliveryApi(clientWith({ get, post }))
    const task = { deviceId: 'local-device', taskId: 'runtime-1' }

    await expect(
      api.trackProjectTask('project-new', task, 'Runtime task', 'Move this task')
    ).resolves.toEqual({ item: movedItem })

    expect(post).toHaveBeenNthCalledWith(1, '/v1/cloud-projects/project-new/loop-items', {
      title: 'Runtime task',
      description: 'Move this task',
      status: 'pending',
    })
    expect(post).toHaveBeenNthCalledWith(2, '/v1/loop-items/NEW-1/tasks', {
      ...task,
      taskTitle: 'Runtime task',
    })
  })

  test('updates tracking status through the existing loop item endpoint', async () => {
    const reviewedItem = { ...trackedItem, status: 'in_review', version: 2 }
    const context = { loop_item_id: trackedItem.id } as CloudTaskContext
    const get = vi
      .fn()
      .mockResolvedValueOnce(context)
      .mockResolvedValueOnce(trackedItem)
      .mockResolvedValueOnce([])
    const patch = vi.fn().mockResolvedValue(reviewedItem)
    const api = createDeliveryApi(clientWith({ get, patch }))

    await expect(
      api.updateTaskTrackingStatus({ deviceId: 'local-device', taskId: 'runtime-1' }, 'succeeded')
    ).resolves.toEqual(reviewedItem)
    expect(get).toHaveBeenNthCalledWith(
      1,
      '/v1/runtime-tasks/cloud-context?device_id=local-device&task_id=runtime-1'
    )
    expect(get).toHaveBeenNthCalledWith(2, '/v1/loop-items/WEG-1')
    expect(get).toHaveBeenNthCalledWith(3, '/v1/loop-items/WEG-1/tasks')
    expect(patch).toHaveBeenCalledWith('/v1/loop-items/WEG-1', {
      version: 1,
      status: 'in_review',
    })
    expect(patch).toHaveBeenCalledOnce()
  })

  test('moves a successful runtime task on the default work-item project to review', async () => {
    const reviewedItem = { ...trackedItem, status: 'in_review', version: 2 }
    const context = {
      loop_item_id: trackedItem.id,
      loop_item: trackedItem,
      project: {
        id: DEFAULT_WORK_ITEM_PROJECT_ID,
        project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
      },
    } as CloudTaskContext
    const get = vi.fn().mockResolvedValue(context)
    const patch = vi.fn().mockResolvedValue(reviewedItem)
    const api = createDeliveryApi(clientWith({ get, patch }))

    await expect(
      api.updateTaskTrackingStatus({ deviceId: 'local-device', taskId: 'runtime-1' }, 'succeeded')
    ).resolves.toEqual(reviewedItem)
    expect(patch).toHaveBeenCalledWith('/v1/loop-items/WEG-1', {
      version: 1,
      status: 'in_review',
    })
  })

  test('leaves robot execution status projection to the backend state machine', async () => {
    const managedItem = {
      ...trackedItem,
      execution_id: 42,
      status: 'in_review' as const,
    }
    const context = {
      loop_item_id: managedItem.id,
      loop_item: managedItem,
    } as CloudTaskContext
    const get = vi.fn().mockResolvedValue(context)
    const patch = vi.fn()
    const api = createDeliveryApi(clientWith({ get, patch }))

    await expect(
      api.updateTaskTrackingStatus(
        { deviceId: 'cloud-device', taskId: 'managed-runtime' },
        'running'
      )
    ).resolves.toEqual(managedItem)
    expect(patch).not.toHaveBeenCalled()
  })

  test('serializes rapid runtime status updates for the same board task', async () => {
    const task = { deviceId: 'local-device', taskId: 'runtime-1' }
    const defaultProject = {
      id: DEFAULT_WORK_ITEM_PROJECT_ID,
      project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
    } as CloudTaskContext['project']
    let currentItem = { ...trackedItem, status: 'pending' as const }
    let releaseRunningUpdate: (() => void) | null = null
    const runningUpdateReleased = new Promise<void>(resolve => {
      releaseRunningUpdate = resolve
    })
    const get = vi.fn(async () => ({
      loop_item_id: currentItem.id,
      loop_item: currentItem,
      project: defaultProject,
    }))
    const patch = vi.fn(async (_endpoint: string, body: { version: number; status: string }) => {
      if (body.status === 'in_progress') await runningUpdateReleased
      currentItem = {
        ...currentItem,
        status: body.status as CloudLoopItem['status'],
        version: body.version + 1,
      }
      return currentItem
    })
    const runningApi = createDeliveryApi(clientWith({ get, patch }))
    const succeededApi = createDeliveryApi(clientWith({ get, patch }))

    const running = runningApi.updateTaskTrackingStatus(task, 'running')
    const succeeded = succeededApi.updateTaskTrackingStatus(task, 'succeeded')
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(get).toHaveBeenCalledOnce()

    releaseRunningUpdate?.()

    await expect(running).resolves.toMatchObject({ status: 'in_progress', version: 2 })
    await expect(succeeded).resolves.toMatchObject({ status: 'in_review', version: 3 })
    expect(patch).toHaveBeenNthCalledWith(1, `/v1/loop-items/${trackedItem.id}`, {
      version: 1,
      status: 'in_progress',
    })
    expect(patch).toHaveBeenNthCalledWith(2, `/v1/loop-items/${trackedItem.id}`, {
      version: 2,
      status: 'in_review',
    })
  })

  test('leaves cloud workflow status projection to runtime events', async () => {
    const workflowItem: CloudLoopItem = {
      ...trackedItem,
      status: 'pending',
      workflow: {
        version: 1,
        definition_version: 1,
        nodes: [
          {
            id: 'develop',
            name: 'Develop',
            kind: 'my_task',
            depends_on: [],
            required: true,
            workspace_policy: 'composer',
            status: 'ready',
            task_binding_id: null,
            execution_id: null,
          },
          {
            id: 'docs',
            name: 'Docs',
            kind: 'my_task',
            depends_on: [],
            required: true,
            workspace_policy: 'composer',
            status: 'ready',
            task_binding_id: null,
            execution_id: null,
          },
        ],
      },
    }
    const currentItem = workflowItem
    const get = vi.fn(async (endpoint: string) => {
      if (endpoint.includes('/cloud-context')) {
        const nodeId = endpoint.includes('runtime-develop') ? 'develop' : 'docs'
        return {
          loop_item_id: currentItem.id,
          loop_item: currentItem,
          workflow_node_id: nodeId,
        } as CloudTaskContext
      }
      return currentItem
    })
    const patch = vi.fn()
    const developApi = createDeliveryApi(clientWith({ get, patch }))
    const docsApi = createDeliveryApi(clientWith({ get, patch }))

    const develop = developApi.updateTaskTrackingStatus(
      { deviceId: 'local-device', taskId: 'runtime-develop' },
      'running'
    )
    const docs = docsApi.updateTaskTrackingStatus(
      { deviceId: 'local-device', taskId: 'runtime-docs' },
      'running'
    )
    await Promise.all([develop, docs])
    expect(patch).not.toHaveBeenCalled()
    expect(get).toHaveBeenCalledTimes(2)
  })

  test('synchronizes a friendly runtime title to the bound task', async () => {
    const renamedItem = { ...trackedItem, title: '修复登录回调', version: 2 }
    const context = { loop_item_id: trackedItem.id } as CloudTaskContext
    const get = vi.fn().mockResolvedValueOnce(context).mockResolvedValueOnce(trackedItem)
    const patch = vi.fn().mockResolvedValue(renamedItem)
    const api = createDeliveryApi(clientWith({ get, patch }))

    await expect(
      api.updateTaskTrackingTitle({ deviceId: 'local-device', taskId: 'runtime-1' }, '修复登录回调')
    ).resolves.toEqual(renamedItem)

    expect(patch).toHaveBeenCalledWith('/v1/loop-items/WEG-1', {
      version: 1,
      title: '修复登录回调',
    })
  })
})
