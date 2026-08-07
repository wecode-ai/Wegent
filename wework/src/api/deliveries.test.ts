import { describe, expect, test, vi } from 'vitest'
import { createDeliveryApi, type CloudLoopItem, type CloudTaskContext } from './deliveries'
import { ApiError, type HttpClient } from './http'

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
      status: 'in_progress',
    })
    expect(post).toHaveBeenNthCalledWith(2, '/v1/loop-items/WEG-1/tasks', {
      ...task,
      taskTitle: 'Runtime task',
    })
    expect(post).toHaveBeenCalledTimes(2)
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

  test('updates tracking status through the existing loop item endpoint', async () => {
    const reviewedItem = { ...trackedItem, status: 'in_review', version: 2 }
    const context = { loop_item_id: trackedItem.id } as CloudTaskContext
    const get = vi.fn().mockResolvedValueOnce(context).mockResolvedValueOnce(trackedItem)
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
    expect(patch).toHaveBeenCalledWith('/v1/loop-items/WEG-1', {
      version: 1,
      status: 'in_review',
    })
    expect(patch).toHaveBeenCalledOnce()
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
