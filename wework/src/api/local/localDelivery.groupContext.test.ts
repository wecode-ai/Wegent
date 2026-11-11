// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createLocalDeliveryApi } from './localDelivery'

const timestamp = '2026-11-12T00:00:00Z'
const group = {
  id: 'group',
  project_key: 'G',
  name: 'Independent group',
  description: '',
  status: 'active',
  role: 'Owner',
  version: 1,
  created_by_user_id: 0,
  created_at: timestamp,
  updated_at: timestamp,
}
const item = {
  id: 'G-1',
  resource_type: 'task',
  group_id: 'group',
  cloud_project_id: 'group',
  title: 'Own work',
  description: '',
  status: 'pending',
  metadata: { tags: [] },
  created_by_user_id: 0,
  version: 1,
  created_at: timestamp,
  updated_at: timestamp,
}
const binding = {
  id: 'binding',
  cloud_project_id: 'group',
  loop_item_id: 'G-1',
  task_user_id: 0,
  device_id: 'device',
  task_id: 'runtime',
  task_title: 'Personal',
  linked_at: timestamp,
  modelSelection: { modelName: 'personal-model' },
  executionContext: { runtime: 'codex', threadId: 'session', workspacePath: '/work' },
}
const task = { deviceId: 'device', taskId: 'runtime' }

describe('local Group runtime recovery and independent My Work inventory', () => {
  it('recovers an own Group binding without consulting the Project catalog', async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'runtime_tasks.context') return binding
      if (method === 'todos.get') {
        expect(params).toEqual({ project_id: 'group', task_id: 'G-1' })
        return item
      }
      if (method === 'chat_groups.get') {
        expect(params).toEqual({ group_id: 'group' })
        return { group }
      }
      throw new Error(`Unexpected ${method}`)
    })
    const result = await createLocalDeliveryApi(request).findCloudContextForTask(task)
    expect(result).toMatchObject({
      ...binding,
      project: {
        id: 'group',
        resource_type: 'chat_group',
        project_store: 'local',
        access_role: 'Owner',
      },
      loop_item: { id: 'G-1', group_id: 'group', cloud_project_id: 'group' },
    })
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'runtime_tasks.context',
      'todos.get',
      'chat_groups.get',
    ])
  })

  it('rejects another local binding owner before reading its Thread', async () => {
    const request = vi.fn().mockResolvedValue({ ...binding, task_user_id: 8 })
    await expect(createLocalDeliveryApi(request).findCloudContextForTask(task)).rejects.toThrow(
      'binding is unavailable'
    )
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([{ id: 'other' }, { group_id: 'other' }, { cloud_project_id: 'other' }])(
    'rejects a mismatched stored Thread identity %j',
    async patch => {
      const request = vi.fn(async (method: string) => {
        if (method === 'runtime_tasks.context') return binding
        if (method === 'todos.get') return { ...item, ...patch }
        throw new Error(`Unexpected ${method}`)
      })
      await expect(createLocalDeliveryApi(request).findCloudContextForTask(task)).rejects.toThrow(
        'binding is unavailable'
      )
      expect(request).toHaveBeenCalledTimes(2)
    }
  )

  it('propagates fresh Group denial without using a classification project or cloud', async () => {
    const denied = new Error('Group unavailable')
    const request = vi.fn(async (method: string) => {
      if (method === 'runtime_tasks.context') return binding
      if (method === 'todos.get') return item
      if (method === 'chat_groups.get') throw denied
      throw new Error(`Unexpected ${method}`)
    })
    await expect(createLocalDeliveryApi(request).findCloudContextForTask(task)).rejects.toBe(denied)
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'runtime_tasks.context',
      'todos.get',
      'chat_groups.get',
    ])
  })

  it('loads unclassified Group work and deduplicates the same Thread aggregated by a project', async () => {
    const project = {
      ...item,
      id: 'project',
      resource_type: 'project',
      group_id: undefined,
      public_id: 'project',
      name: 'Classification',
      project_key: 'P',
      cloud_project_id: null,
      metadata: { task_provider: 'local' },
    }
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'projects.list') return [project]
      if (method === 'chat_groups.list') return { items: [group] }
      if (method === 'todos.list' && params?.project_id === 'project') return [item]
      if (method === 'todos.list' && params?.project_id === 'group')
        return [item, { ...item, id: 'G-2' }]
      throw new Error(`Unexpected ${method}`)
    })
    const result = await createLocalDeliveryApi(request).listMyWork()
    expect(result.errors).toEqual([])
    expect(result.items.map(row => [row.cloud_project_id, row.id, row.project_name])).toEqual([
      ['group', 'G-1', group.name],
      ['group', 'G-2', group.name],
    ])
  })

  it('retains independent Group work when the unrelated project catalog fails', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'projects.list') throw new Error('Project catalog offline')
      if (method === 'chat_groups.list') return { items: [group] }
      if (method === 'todos.list') return [item]
      throw new Error(`Unexpected ${method}`)
    })
    const result = await createLocalDeliveryApi(request).listMyWork()
    expect(result.items.map(row => row.id)).toEqual(['G-1'])
    expect(result.errors).toEqual(['Project catalog offline'])
  })

  it('does not expose archived Group work and reports a current Group read failure', async () => {
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'projects.list') return []
      if (method === 'chat_groups.list')
        return { items: [group, { ...group, id: 'archived', status: 'archived' }] }
      if (method === 'todos.list') {
        expect(params).toEqual({ project_id: 'group' })
        throw new Error('Access revoked')
      }
      throw new Error(`Unexpected ${method}`)
    })
    const result = await createLocalDeliveryApi(request).listMyWork()
    expect(result.items).toEqual([])
    expect(result.errors).toEqual([`${group.name}: Access revoked`])
  })
})
