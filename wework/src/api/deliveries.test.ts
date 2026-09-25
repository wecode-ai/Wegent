import { describe, expect, it, test, vi } from 'vitest'
import type { HttpClient } from './http'
import { ApiError } from './http'
import {
  DEFAULT_WORK_ITEM_PROJECT_ID,
  DEFAULT_WORK_ITEM_PROJECT_KEY,
  createDeliveryApi,
  isDefaultWorkItemProject,
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

  it('persists the runtime task model identity when binding a board task', async () => {
    const post = vi.fn(async () => undefined)
    const api = createDeliveryApi(clientWith({ post }))

    await api.bindTask(
      'WEG-1',
      {
        deviceId: 'local-device',
        taskId: 'runtime-1',
        runtimeHandle: {
          modelSelection: {
            modelName: 'gpt-5.6-codex',
            modelType: 'public',
            options: { reasoning: 'high' },
          },
        },
      },
      'Fix board follow-up'
    )

    expect(post).toHaveBeenCalledWith('/v1/loop-items/WEG-1/tasks', {
      deviceId: 'local-device',
      taskId: 'runtime-1',
      runtimeHandle: {
        modelSelection: {
          modelName: 'gpt-5.6-codex',
          modelType: 'public',
          options: { reasoning: 'high' },
        },
      },
      taskTitle: 'Fix board follow-up',
      modelSelection: {
        modelName: 'gpt-5.6-codex',
        modelType: 'public',
        options: { reasoning: 'high' },
      },
    })
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

    const response = await api.listLoopItemExecutions(123, {
      agent_id: 'bot-1',
      include_terminal: true,
    })

    expect(client.get).toHaveBeenCalledWith(
      '/v1/cloud-projects/123/executions?agent_id=bot-1&include_terminal=true'
    )
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
