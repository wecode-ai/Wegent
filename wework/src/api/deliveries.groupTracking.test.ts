// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createDeliveryApi } from './deliveries'
import { ApiError, type HttpClient } from './http'
import { createLocalDeliveryApi } from './local/localDelivery'

const task = { deviceId: 'device', taskId: 'runtime' }
const item = {
  id: 'G-1',
  group_id: 'group',
  cloud_project_id: 'group',
  resource_type: 'task',
  title: 'Task',
  status: 'pending',
  version: 1,
  metadata: { tags: [] },
}

describe('task-origin Group tracking keeps classification separate from ownership', () => {
  it.each([undefined, 'classification'])(
    'forwards only explicit classification to cloud creation (%s)',
    async classification => {
      const get = vi.fn().mockRejectedValue(new ApiError('Not bound', 404))
      const post = vi.fn().mockResolvedValueOnce(item).mockResolvedValueOnce(undefined)
      const api = createDeliveryApi({ get, post } as unknown as HttpClient)
      const requests = await Promise.all([
        api.trackProjectTask('group', task, 'Task', 'Description', classification),
        api.trackProjectTask('group', task, 'Task', 'Description', classification),
      ])
      expect(requests).toEqual([{ item }, { item }])
      expect(post).toHaveBeenNthCalledWith(1, '/v1/cloud-projects/group/loop-items', {
        title: 'Task',
        description: 'Description',
        status: 'pending',
        ...(classification === undefined ? {} : { classification_project_id: classification }),
      })
      expect(post.mock.calls[1][0]).toBe('/v1/loop-items/G-1/tasks')
      expect(post).toHaveBeenCalledTimes(2)
    }
  )

  it('never binds or retries against the classification project after cloud authorization denial', async () => {
    const denied = new ApiError('Classification forbidden', 403)
    const get = vi.fn().mockRejectedValue(new ApiError('Not bound', 404))
    const post = vi.fn().mockRejectedValue(denied)
    await expect(
      createDeliveryApi({ get, post } as unknown as HttpClient).trackProjectTask(
        'group',
        task,
        'Task',
        'Description',
        'classification'
      )
    ).rejects.toBe(denied)
    expect(post).toHaveBeenCalledExactlyOnceWith('/v1/cloud-projects/group/loop-items', {
      title: 'Task',
      description: 'Description',
      status: 'pending',
      classification_project_id: 'classification',
    })
  })

  it.each([undefined, 'classification'])(
    'forwards only explicit classification to native creation (%s)',
    async classification => {
      const request = vi.fn(async (method: string) => {
        if (method === 'runtime_tasks.user_context')
          return { cloud_project_id: null, loop_item_id: null }
        if (method === 'todos.create') return item
        if (method === 'todos.bind') return undefined
        throw new Error(`Unexpected ${method}`)
      })
      await createLocalDeliveryApi(request).trackProjectTask(
        'group',
        task,
        'Task',
        'Description',
        classification
      )
      const create = request.mock.calls.find(
        ([method]) => method === 'todos.create'
      ) as unknown as [string, { project_id: string; todo: Record<string, unknown> }]
      expect(create[1].project_id).toBe('group')
      if (classification === undefined)
        expect(create[1].todo).not.toHaveProperty('classification_project_id')
      else expect(create[1].todo.classification_project_id).toBe(classification)
      expect(request).toHaveBeenLastCalledWith(
        'todos.bind',
        expect.objectContaining({
          project_id: 'group',
          item_id: 'G-1',
          task: expect.objectContaining(task),
        })
      )
    }
  )

  it('does not bind, retry or change owner when native classification authorization fails', async () => {
    const denied = new Error('Classification forbidden')
    const request = vi.fn(async (method: string) => {
      if (method === 'runtime_tasks.user_context')
        return { cloud_project_id: null, loop_item_id: null }
      if (method === 'todos.create') throw denied
      throw new Error(`Unexpected ${method}`)
    })
    await expect(
      createLocalDeliveryApi(request).trackProjectTask(
        'group',
        task,
        'Task',
        'Description',
        'classification'
      )
    ).rejects.toBe(denied)
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'runtime_tasks.user_context',
      'todos.create',
    ])
    expect(request).toHaveBeenLastCalledWith(
      'todos.create',
      expect.objectContaining({
        project_id: 'group',
        todo: expect.objectContaining({ classification_project_id: 'classification' }),
      })
    )
  })
})
