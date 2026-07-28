import { convertFileSrc } from '@tauri-apps/api/core'

import type {
  CloudLoopItemAttachment,
  CloudLoopItem,
  CloudProject,
  CloudProjectFile,
  CloudProjectId,
  CloudProjectMember,
  Delivery,
  DeliveryAsset,
  DeliveryCreateInput,
  DeliveryDetail,
} from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskAddress } from '@/types/api'

type LocalRequest = <T>(
  method: string,
  params?: Record<string, unknown>,
  deviceId?: string
) => Promise<T>

interface LocalLoopItemRecord {
  id: string
  resource_type: 'project' | 'task' | string
  cloud_project_id: string | null
  parent_id: string | null
  public_id: string | null
  project_key: string | null
  name: string | null
  title: string | null
  description: string
  sequence_number: number | null
  status: string | null
  priority: string | null
  sort_order: number
  current_delivery_id: string | null
  metadata: Record<string, unknown>
  version: number
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface LocalTaskBindingRecord {
  id: string
  cloud_project_id: string
  loop_item_id: string | null
  task_user_id: number
  device_id: string
  task_id: string
  task_title: string | null
  backend_task_id: number | null
  linked_at: string
}

interface LocalProjectFileRecord {
  id: string
  cloud_project_id: string
  path: string
  name: string
  kind: 'file' | 'folder' | string
  content_type: string | null
  size_bytes: number
  sha256: string | null
  description: string
  created_by_user_id: number
  updated_by_user_id: number
  version: number
  created_at: string
  updated_at: string
}

interface LocalAccessRecord {
  path: string
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

function localProject(record: LocalLoopItemRecord): CloudProject {
  const taskProvider =
    record.metadata.task_provider === 'github' || record.metadata.task_provider === 'gitlab'
      ? record.metadata.task_provider
      : 'local'
  return {
    id: record.id,
    public_id: record.public_id ?? record.id,
    project_key: record.project_key ?? 'LOCAL',
    name: record.name ?? '',
    description: record.description,
    project_store: 'local',
    task_provider: taskProvider,
    provider_config:
      record.metadata.provider_config &&
      typeof record.metadata.provider_config === 'object' &&
      !Array.isArray(record.metadata.provider_config)
        ? (record.metadata.provider_config as CloudProject['provider_config'])
        : {},
    created_by_user_id: 0,
    status: record.status ?? 'active',
    tags: stringList(record.metadata.tags),
    version: record.version,
    created_at: record.created_at,
    updated_at: record.updated_at,
  }
}

function externalProjectDescriptor(project: CloudProject, token?: string) {
  return {
    id: project.id,
    public_id: project.public_id,
    project_key: project.project_key,
    name: project.name,
    description: project.description,
    project_store: project.project_store,
    task_provider: project.task_provider,
    provider_config: {
      ...project.provider_config,
      ...(token?.trim() ? { token: token.trim() } : {}),
    },
    version: project.version,
  }
}

export function createExternalIssueApi(request: LocalRequest) {
  return {
    async configureProject(project: CloudProject, token?: string) {
      await request('external_projects.configure', {
        project: externalProjectDescriptor(project, token),
      })
    },
    async listLoopItems(project: CloudProject) {
      const records = await request<LocalLoopItemRecord[]>('external_todos.list', {
        project: externalProjectDescriptor(project),
      })
      return { items: records.map(localTask) }
    },
    async getLoopItem(project: CloudProject, itemId: string) {
      const record = await request<LocalLoopItemRecord>('external_todos.get', {
        project: externalProjectDescriptor(project),
        task_id: itemId,
      })
      return localTask(record)
    },
    async createLoopItem(
      project: CloudProject,
      data: {
        title: string
        description?: string
        status?: CloudLoopItem['status']
        priority?: CloudLoopItem['priority']
        parent_id?: string | null
        tags?: string[]
      }
    ) {
      const record = await request<LocalLoopItemRecord>('external_todos.create', {
        project: externalProjectDescriptor(project),
        todo: {
          title: data.title,
          description: data.description ?? '',
          status: data.status ?? 'inbox',
          priority: data.priority ?? 'none',
          parent_id: data.parent_id ?? null,
          tags: data.tags ?? [],
        },
      })
      return localTask(record)
    },
    async updateLoopItem(
      project: CloudProject,
      itemId: string,
      data: Record<string, unknown> & { version: number }
    ) {
      const record = await request<LocalLoopItemRecord>('external_todos.update', {
        project: externalProjectDescriptor(project),
        task_id: itemId,
        todo: data,
      })
      return localTask(record)
    },
  }
}

function localTask(record: LocalLoopItemRecord): CloudLoopItem {
  return {
    id: record.id,
    cloud_project_id: record.cloud_project_id ?? '',
    sequence_number: record.sequence_number ?? 0,
    parent_id: record.parent_id,
    created_by_user_id: 0,
    assignee_user_id: null,
    title: record.title ?? '',
    description: record.description,
    status: (record.status ?? 'inbox') as CloudLoopItem['status'],
    priority: (record.priority ?? 'none') as CloudLoopItem['priority'],
    due_at: null,
    tags: stringList(record.metadata.tags),
    sort_order: record.sort_order,
    current_delivery_id: record.current_delivery_id,
    version: record.version,
    created_at: record.created_at,
    updated_at: record.updated_at,
    completed_at: record.completed_at,
  }
}

function localProjectFile(record: LocalProjectFileRecord): CloudProjectFile {
  return {
    ...record,
    kind: record.kind === 'folder' ? 'folder' : 'file',
  }
}

function fileBytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

async function fileInput(file: File) {
  return {
    display_name: file.name,
    content_type: file.type || null,
    base64: fileBytesToBase64(new Uint8Array(await file.arrayBuffer())),
  }
}

function localAccess(record: LocalAccessRecord) {
  return {
    url: convertFileSrc(record.path),
    expires_in_seconds: 0,
  }
}

function unsupported(name: string): never {
  throw new Error(`${name} is not available for local projects yet`)
}

export function createLocalDeliveryApi(
  request: LocalRequest
): NonNullable<WorkbenchServices['deliveryApi']> {
  const taskProjects = new Map<string, CloudProjectId>()

  function rememberTasks(projectId: CloudProjectId, records: LocalLoopItemRecord[]) {
    for (const record of records) taskProjects.set(record.id, projectId)
  }

  async function resolveProjectId(itemId: string): Promise<CloudProjectId> {
    const known = taskProjects.get(itemId)
    if (known) return known
    const projectRecords = await request<LocalLoopItemRecord[]>('projects.list')
    const projects = projectRecords.map(localProject)
    const prefixMatches = projects.filter(project => itemId.startsWith(`${project.project_key}-`))
    if (prefixMatches.length === 1) return prefixMatches[0].id
    for (const project of projects) {
      try {
        const record = await request<LocalLoopItemRecord>('todos.get', {
          project_id: project.id,
          task_id: itemId,
        })
        taskProjects.set(record.id, project.id)
        return project.id
      } catch {
        // Read-only probing is safe when legacy projects reuse a project key.
      }
    }
    throw new Error('Local task not found')
  }

  const api = {
    async listCloudProjects() {
      const records = await request<LocalLoopItemRecord[]>('projects.list')
      return {
        items: records
          .filter(record => record.metadata.project_store !== 'backend')
          .map(localProject),
      }
    },
    async createCloudProject(data: {
      project_key?: string
      name: string
      description?: string
      task_provider?: 'local' | 'github' | 'gitlab'
      provider_config?: {
        repository?: string
        domain?: string
        api_base?: string
        token?: string
      }
    }) {
      const record = await request<LocalLoopItemRecord>('projects.create', {
        ...data,
        task_provider: data.task_provider ?? 'local',
        provider_config: data.provider_config ?? {},
      })
      return localProject(record)
    },
    async updateCloudProject(
      projectId: CloudProjectId,
      data: {
        name?: string
        description?: string
        tags?: string[]
        version: number
      }
    ) {
      const record = await request<LocalLoopItemRecord>('projects.update', {
        project_id: projectId,
        project: data,
      })
      return localProject(record)
    },
    async listMyWork() {
      return { items: [] }
    },
    async listLoopItems(projectId: CloudProjectId) {
      const records = await request<LocalLoopItemRecord[]>('todos.list', {
        project_id: projectId,
      })
      rememberTasks(projectId, records)
      return { items: records.map(localTask) }
    },
    async getLoopItem(itemId: string) {
      const projectId = await resolveProjectId(itemId)
      const record = await request<LocalLoopItemRecord>('todos.get', {
        project_id: projectId,
        task_id: itemId,
      })
      taskProjects.set(record.id, projectId)
      return localTask(record)
    },
    async createLoopItem(
      projectId: CloudProjectId,
      data: {
        title: string
        description?: string
        status?: CloudLoopItem['status']
        priority?: CloudLoopItem['priority']
        due_at?: string
        parent_id?: string | null
        tags?: string[]
      }
    ) {
      const record = await request<LocalLoopItemRecord>('todos.create', {
        project_id: projectId,
        todo: {
          title: data.title,
          description: data.description ?? '',
          status: data.status ?? 'inbox',
          priority: data.priority ?? 'none',
          parent_id: data.parent_id ?? null,
          tags: data.tags ?? [],
        },
      })
      taskProjects.set(record.id, projectId)
      return localTask(record)
    },
    async updateLoopItem(itemId: string, data: Record<string, unknown> & { version: number }) {
      const projectId = await resolveProjectId(itemId)
      const record = await request<LocalLoopItemRecord>('todos.update', {
        project_id: projectId,
        task_id: itemId,
        todo: data,
      })
      taskProjects.set(record.id, projectId)
      return localTask(record)
    },
    async reorderLoopItems(
      projectId: CloudProjectId,
      data: {
        parent_id: string | null
        status: CloudLoopItem['status']
        item_ids: string[]
      }
    ) {
      const records = await request<LocalLoopItemRecord[]>('todos.reorder', {
        project_id: projectId,
        reorder: data,
      })
      rememberTasks(projectId, records)
      return { items: records.map(localTask) }
    },
    async listLoopItemAttachments(itemId: string) {
      return request<CloudLoopItemAttachment[]>('attachments.list', {
        item_id: itemId,
      })
    },
    async addLoopItemAttachment(itemId: string, file: File) {
      const projectId = await resolveProjectId(itemId)
      return request<CloudLoopItemAttachment>('attachments.add', {
        project_id: projectId,
        item_id: itemId,
        file: await fileInput(file),
      })
    },
    async accessLoopItemAttachment(attachmentId: string) {
      return localAccess(
        await request<LocalAccessRecord>('attachments.access', {
          attachment_id: attachmentId,
        })
      )
    },
    async deleteLoopItemAttachment(attachmentId: string) {
      await request('attachments.delete', { attachment_id: attachmentId })
    },
    async listTaskBindings(itemId: string) {
      const records = await request<LocalTaskBindingRecord[]>('todos.bindings', {
        task_id: itemId,
      })
      return records.map(record => ({ ...record, id: Number(record.id) }))
    },
    listLoopItemCollaborators: async () => [],
    addLoopItemCollaborator: async () => unsupported('Task collaborators'),
    removeLoopItemCollaborator: async () => unsupported('Task collaborators'),
    async bindTask(itemId: string, task: RuntimeTaskAddress, taskTitle?: string | null) {
      const projectId = await resolveProjectId(itemId)
      await request('todos.bind', {
        project_id: projectId,
        item_id: itemId,
        task: { ...task, ...(taskTitle ? { taskTitle } : {}) },
      })
    },
    async bindProjectTask(
      projectId: CloudProjectId,
      task: RuntimeTaskAddress,
      taskTitle?: string | null
    ) {
      await request('projects.bind_task', {
        project_id: projectId,
        task: { ...task, ...(taskTitle ? { taskTitle } : {}) },
      })
    },
    async unbindCloudContext(task: RuntimeTaskAddress) {
      await request('runtime_tasks.unbind', {
        device_id: task.deviceId,
        task_id: task.taskId,
      })
    },
    async unbindTask(_itemId: string, task: RuntimeTaskAddress) {
      await request('runtime_tasks.unbind', {
        device_id: task.deviceId,
        task_id: task.taskId,
      })
    },
    async findLoopItemForTask(task: RuntimeTaskAddress) {
      const binding = await request<LocalTaskBindingRecord>('runtime_tasks.context', {
        device_id: task.deviceId,
        task_id: task.taskId,
      })
      if (!binding.loop_item_id) throw new Error('Runtime task is linked to a project only')
      taskProjects.set(binding.loop_item_id, binding.cloud_project_id)
      return api.getLoopItem(binding.loop_item_id)
    },
    async findCloudContextForTask(task: RuntimeTaskAddress) {
      const binding = await request<LocalTaskBindingRecord>('runtime_tasks.context', {
        device_id: task.deviceId,
        task_id: task.taskId,
      })
      const projectRecords = await request<LocalLoopItemRecord[]>('projects.list')
      const projectRecord = projectRecords.find(record => record.id === binding.cloud_project_id)
      if (!projectRecord) throw new Error('Local project not found')
      const loopItem = binding.loop_item_id ? await api.getLoopItem(binding.loop_item_id) : null
      return {
        ...binding,
        id: binding.id,
        project: localProject(projectRecord),
        loop_item: loopItem,
      }
    },
    listLocalBindings: async () => [],
    listCloudProjectMembers: async (): Promise<CloudProjectMember[]> => [],
    addCloudProjectMember: async () => unsupported('Project members'),
    updateCloudProjectMember: async () => unsupported('Project members'),
    removeCloudProjectMember: async () => unsupported('Project members'),
    searchCloudProjectUsers: async () => ({ users: [], total: 0 }),
    addLocalBinding: async () => unsupported('Local bindings'),
    async listCloudFiles(projectId: CloudProjectId) {
      const records = await request<LocalProjectFileRecord[]>('files.list', {
        project_id: projectId,
      })
      return { items: records.map(localProjectFile) }
    },
    listProjectDeliveryFiles: async () => ({ items: [] }),
    async createCloudFolder(projectId: CloudProjectId, path: string) {
      const record = await request<LocalProjectFileRecord>('files.create_folder', {
        project_id: projectId,
        path,
      })
      return localProjectFile(record)
    },
    async uploadCloudFile(projectId: CloudProjectId, file: File, path = file.name) {
      const record = await request<LocalProjectFileRecord>('files.upload', {
        project_id: projectId,
        path,
        file: await fileInput(file),
      })
      return localProjectFile(record)
    },
    async accessCloudFile(fileId: string) {
      return localAccess(await request<LocalAccessRecord>('files.access', { file_id: fileId }))
    },
    async accessDeliveryFile(assetId: string) {
      return localAccess(
        await request<LocalAccessRecord>('deliveries.access_asset', { asset_id: assetId })
      )
    },
    async moveCloudFile(fileId: string, path: string, version: number) {
      const record = await request<LocalProjectFileRecord>('files.move', {
        file_id: fileId,
        path,
        version,
      })
      return localProjectFile(record)
    },
    async deleteCloudFile(fileId: string, recursive = false) {
      await request('files.delete', { file_id: fileId, recursive })
    },
    async createDelivery(itemId: string, data: DeliveryCreateInput) {
      const projectId = await resolveProjectId(itemId)
      return request<Delivery>('deliveries.create', {
        project_id: projectId,
        item_id: itemId,
        delivery: data,
      })
    },
    async addAsset(deliveryId: string, file: File, relativePath: string) {
      return request<DeliveryAsset>('deliveries.add_asset', {
        delivery_id: deliveryId,
        relative_path: relativePath,
        file: await fileInput(file),
      })
    },
    async finalizeDelivery(deliveryId: string) {
      const delivery = await api.getDelivery(deliveryId)
      return request<Delivery>('deliveries.finalize', {
        item_id: delivery.loop_item_id,
        delivery_id: deliveryId,
      })
    },
    async discardDraft(deliveryId: string) {
      await request('deliveries.discard', { delivery_id: deliveryId })
    },
    async listDeliveries(itemId: string) {
      const records = await request<Delivery[]>('deliveries.list', { item_id: itemId })
      return { items: records }
    },
    async getDelivery(deliveryId: string) {
      return request<DeliveryDetail>('deliveries.get', { delivery_id: deliveryId })
    },
  }
  return api as unknown as NonNullable<WorkbenchServices['deliveryApi']>
}
