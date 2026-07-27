import { describe, expect, test, vi } from 'vitest'
import { createExternalIssueApi, createLocalDeliveryApi } from './localDelivery'

const projectRecord = {
  id: 'project-1',
  resource_type: 'project',
  cloud_project_id: null,
  parent_id: null,
  public_id: 'public-1',
  project_key: 'LOCAL',
  name: 'Local board',
  title: null,
  description: '',
  sequence_number: null,
  status: 'active',
  priority: null,
  sort_order: 0,
  current_delivery_id: null,
  metadata: { task_provider: 'local', tags: [] },
  version: 1,
  created_at: '2026-07-27T00:00:00Z',
  updated_at: '2026-07-27T00:00:00Z',
  completed_at: null,
}

const taskRecord = {
  ...projectRecord,
  id: 'LOCAL-1',
  resource_type: 'task',
  cloud_project_id: projectRecord.id,
  public_id: null,
  project_key: null,
  name: null,
  title: 'First task',
  sequence_number: 1,
  status: 'inbox',
  priority: 'none',
  metadata: { tags: ['local'] },
}

describe('local delivery API', () => {
  test('queries a backend project provider without creating a local project', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'external_projects.configure') return projectRecord
      if (method === 'external_todos.list') return [taskRecord]
      throw new Error(`Unexpected method: ${method}`)
    })
    const api = createExternalIssueApi(request)
    const cloudProject = {
      id: 'cloud-1',
      public_id: 'cloud-public-1',
      project_key: 'CLOUD',
      name: 'Cloud GitHub board',
      description: '',
      project_store: 'backend' as const,
      task_provider: 'github' as const,
      provider_config: { repository: 'acme/repo' },
      created_by_user_id: 1,
      status: 'active',
      tags: [],
      version: 1,
      created_at: '2026-07-27T00:00:00Z',
      updated_at: '2026-07-27T00:00:00Z',
    }

    await api.configureProject(cloudProject, 'local-secret')
    await api.listLoopItems(cloudProject)

    expect(request).toHaveBeenCalledWith('external_projects.configure', {
      project: expect.objectContaining({
        id: 'cloud-1',
        project_store: 'backend',
        task_provider: 'github',
        provider_config: {
          repository: 'acme/repo',
          token: 'local-secret',
        },
      }),
    })
    expect(request).toHaveBeenCalledWith('external_todos.list', {
      project: expect.objectContaining({
        id: 'cloud-1',
        project_store: 'backend',
        task_provider: 'github',
      }),
    })
    expect(request).not.toHaveBeenCalledWith('projects.create', expect.anything())
  })

  test('passes external provider credentials only through executor IPC', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'projects.create') {
        return {
          ...projectRecord,
          metadata: {
            task_provider: 'github',
            provider_config: {
              repository: 'acme/repo',
              credential_configured: true,
            },
          },
        }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const api = createLocalDeliveryApi(request)

    await api.createCloudProject({
      name: 'GitHub board',
      task_provider: 'github',
      provider_config: {
        repository: 'acme/repo',
        token: 'github-secret',
      },
    })

    expect(request).toHaveBeenCalledWith('projects.create', {
      name: 'GitHub board',
      task_provider: 'github',
      provider_config: {
        repository: 'acme/repo',
        token: 'github-secret',
      },
    })
  })

  test('routes project and task operations through executor IPC', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'projects.list') return [projectRecord]
      if (method === 'projects.update') {
        return { ...projectRecord, name: 'Renamed board', version: 2 }
      }
      if (method === 'todos.list') return [taskRecord]
      if (method === 'todos.create') return taskRecord
      throw new Error(`Unexpected method: ${method}`)
    })
    const api = createLocalDeliveryApi(request)

    await expect(api.listCloudProjects()).resolves.toMatchObject({
      items: [{ id: 'project-1', name: 'Local board' }],
    })
    await expect(api.listLoopItems('project-1')).resolves.toMatchObject({
      items: [{ id: 'LOCAL-1', title: 'First task', tags: ['local'] }],
    })
    await expect(
      api.updateCloudProject('project-1', { name: 'Renamed board', version: 1 })
    ).resolves.toMatchObject({ name: 'Renamed board', version: 2 })
    await api.createLoopItem('project-1', { title: 'First task' })

    expect(request).toHaveBeenCalledWith('todos.create', {
      project_id: 'project-1',
      todo: {
        title: 'First task',
        description: '',
        status: 'inbox',
        priority: 'none',
        parent_id: null,
        tags: [],
      },
    })
    expect(request).toHaveBeenCalledWith('projects.update', {
      project_id: 'project-1',
      project: { name: 'Renamed board', version: 1 },
    })
  })

  test('does not expose cached backend projects as local project spaces', async () => {
    const backendProjectRecord = {
      ...projectRecord,
      id: 'cloud-1',
      name: 'Cloud GitLab board',
      metadata: {
        project_store: 'backend',
        task_provider: 'gitlab',
        provider_config: { repository: 'group/project' },
      },
    }
    const request = vi.fn(async (method: string) => {
      if (method === 'projects.list') return [projectRecord, backendProjectRecord]
      throw new Error(`Unexpected method: ${method}`)
    })
    const api = createLocalDeliveryApi(request)

    await expect(api.listCloudProjects()).resolves.toMatchObject({
      items: [{ id: 'project-1', name: 'Local board' }],
    })
  })

  test('remembers task ownership for updates and persists board order', async () => {
    const updatedRecord = { ...taskRecord, title: 'Updated', version: 2 }
    const request = vi.fn(async (method: string) => {
      if (method === 'todos.list') return [taskRecord]
      if (method === 'todos.update') return updatedRecord
      if (method === 'todos.reorder') return [updatedRecord]
      throw new Error(`Unexpected method: ${method}`)
    })
    const api = createLocalDeliveryApi(request)

    await api.listLoopItems('project-1')
    await expect(
      api.updateLoopItem('LOCAL-1', { version: 1, title: 'Updated' })
    ).resolves.toMatchObject({ title: 'Updated', version: 2 })
    await expect(
      api.reorderLoopItems('project-1', {
        parent_id: null,
        status: 'inbox',
        item_ids: ['LOCAL-1'],
      })
    ).resolves.toMatchObject({ items: [{ id: 'LOCAL-1' }] })

    expect(request).toHaveBeenCalledWith('todos.update', {
      project_id: 'project-1',
      task_id: 'LOCAL-1',
      todo: { version: 1, title: 'Updated' },
    })
    expect(request).toHaveBeenCalledWith('todos.reorder', {
      project_id: 'project-1',
      reorder: {
        parent_id: null,
        status: 'inbox',
        item_ids: ['LOCAL-1'],
      },
    })
  })

  test('binds a runtime task through executor storage', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'todos.list') return [taskRecord]
      if (method === 'todos.bind') return { id: '1' }
      if (method === 'runtime_tasks.context') {
        return {
          id: '1',
          cloud_project_id: 'project-1',
          loop_item_id: 'LOCAL-1',
          task_user_id: 0,
          device_id: 'local-device',
          task_id: 'runtime-1',
          task_title: 'Runtime',
          backend_task_id: null,
          linked_at: '2026-07-27T00:00:00Z',
        }
      }
      if (method === 'todos.get') return taskRecord
      throw new Error(`Unexpected method: ${method}`)
    })
    const api = createLocalDeliveryApi(request)
    const runtimeTask = { deviceId: 'local-device', taskId: 'runtime-1' }

    await api.listLoopItems('project-1')
    await api.bindTask('LOCAL-1', runtimeTask, 'Runtime')
    await expect(api.findLoopItemForTask(runtimeTask)).resolves.toMatchObject({ id: 'LOCAL-1' })

    expect(request).toHaveBeenCalledWith('todos.bind', {
      project_id: 'project-1',
      item_id: 'LOCAL-1',
      task: {
        deviceId: 'local-device',
        taskId: 'runtime-1',
        taskTitle: 'Runtime',
      },
    })
  })

  test('routes local files, attachments, and deliveries through executor IPC', async () => {
    const delivery = {
      id: 'delivery-1',
      loop_item_id: 'LOCAL-1',
      created_by_user_id: 0,
      source_task_binding_id: null,
      source_task_snapshot: null,
      status: 'draft',
      created_at: '2026-07-27T00:00:00Z',
      delivered_at: null,
      assets: [],
    }
    const request = vi.fn(async (method: string) => {
      if (method === 'todos.list') return [taskRecord]
      if (method === 'files.create_folder') {
        return {
          id: 'folder-1',
          cloud_project_id: 'project-1',
          path: 'docs',
          name: 'docs',
          kind: 'folder',
          content_type: null,
          size_bytes: 0,
          sha256: null,
          description: '',
          created_by_user_id: 0,
          updated_by_user_id: 0,
          version: 1,
          created_at: '2026-07-27T00:00:00Z',
          updated_at: '2026-07-27T00:00:00Z',
        }
      }
      if (method === 'deliveries.create') return delivery
      if (method === 'deliveries.get') return { ...delivery, markdown: '# Done', chat: null }
      if (method === 'deliveries.finalize') return { ...delivery, status: 'delivered' }
      throw new Error(`Unexpected method: ${method}`)
    })
    const api = createLocalDeliveryApi(request)

    await api.listLoopItems('project-1')
    await expect(api.createCloudFolder('project-1', 'docs')).resolves.toMatchObject({
      id: 'folder-1',
      kind: 'folder',
    })
    await expect(api.createDelivery('LOCAL-1', { markdown: '# Done' })).resolves.toMatchObject({
      id: 'delivery-1',
    })
    await expect(api.finalizeDelivery('delivery-1')).resolves.toMatchObject({
      status: 'delivered',
    })

    expect(request).toHaveBeenCalledWith('files.create_folder', {
      project_id: 'project-1',
      path: 'docs',
    })
    expect(request).toHaveBeenCalledWith('deliveries.create', {
      project_id: 'project-1',
      item_id: 'LOCAL-1',
      delivery: { markdown: '# Done' },
    })
    expect(request).toHaveBeenCalledWith('deliveries.finalize', {
      item_id: 'LOCAL-1',
      delivery_id: 'delivery-1',
    })
  })
})
