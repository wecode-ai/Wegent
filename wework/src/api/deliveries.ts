import type { HttpClient } from './http'
import type { RuntimeTaskAddress } from '@/types/api'

export type CloudProjectId = string
type CloudProjectIdInput = CloudProjectId | number

export interface DeliveryAsset {
  id: string
  kind: string
  display_name: string
  relative_path: string
  content_type: string | null
  size_bytes: number
  sha256: string
}

export interface Delivery {
  id: string
  loop_item_id: string
  created_by_user_id: number
  source_task_binding_id: number | null
  source_task_snapshot: Record<string, unknown> | null
  status: 'draft' | 'delivered'
  created_at: string
  delivered_at: string | null
  assets: DeliveryAsset[]
}

export interface DeliveryDetail extends Delivery {
  markdown: string
  chat: Record<string, unknown> | null
}

export interface DeliveryCreateInput {
  markdown: string
  chat?: Record<string, unknown>
  source_task?: RuntimeTaskAddress
}

export interface CloudLoopItem {
  id: string
  cloud_project_id: CloudProjectId
  sequence_number: number
  parent_id: string | null
  created_by_user_id: number
  assignee_user_id: number | null
  title: string
  description: string
  status: 'inbox' | 'pending' | 'in_progress' | 'in_review' | 'completed'
  priority: 'none' | 'low' | 'medium' | 'high' | 'urgent'
  due_at: string | null
  sort_order: number
  current_delivery_id: string | null
  version: number
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface CloudLoopItemAttachment {
  id: string
  loop_item_id: string
  display_name: string
  content_type: string | null
  size_bytes: number
  sha256: string
  created_by_user_id: number
  created_at: string
}

export interface CloudProject {
  id: CloudProjectId
  public_id: string
  project_key: string
  name: string
  description: string
  created_by_user_id: number
  status: string
  version: number
  created_at: string
  updated_at: string
}

export interface CloudTaskContext {
  id: string
  cloud_project_id: CloudProjectId
  loop_item_id: string | null
  task_user_id: number
  device_id: string
  task_id: string
  task_title: string | null
  backend_task_id: number | null
  project: CloudProject
  loop_item: CloudLoopItem | null
  linked_at: string
}

export interface CloudProjectFile {
  id: string
  cloud_project_id: CloudProjectId
  path: string
  name: string
  kind: 'file' | 'folder'
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

export interface ProjectDeliveryFile {
  asset_id: string
  delivery_id: string
  loop_item_id: string
  loop_item_title: string
  relative_path: string
  display_name: string
  content_type: string | null
  size_bytes: number
  delivered_at: string
}

export interface CloudProjectLocalBinding {
  id: string
  cloud_project_id: CloudProjectId
  local_project_id: number
  user_id: number
  device_id: string | null
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface CloudProjectMember {
  id: number
  user_id: number
  user_name: string
  email: string | null
  role: 'Owner' | 'Maintainer' | 'Developer' | 'Reporter'
}

export interface CloudLoopItemCollaborator {
  id: string
  loop_item_id: string
  user_id: number
  user_name: string
  email: string | null
  source: 'manual' | 'task' | 'delivery' | string
  added_by_user_id: number
  created_at: string
}

export interface CloudUserSearchItem {
  id: number
  user_name: string
  email: string | null
}

export interface CloudMyWorkItem extends CloudLoopItem {
  project_key: string
  project_name: string
  has_active_task: boolean
}

export function createDeliveryApi(client: HttpClient) {
  return {
    listCloudProjects(): Promise<{ items: CloudProject[] }> {
      return client.get('/v1/cloud-projects')
    },
    createCloudProject(data: {
      project_key?: string
      name: string
      description?: string
    }): Promise<CloudProject> {
      return client.post('/v1/cloud-projects', data)
    },
    listMyWork(): Promise<{ items: CloudMyWorkItem[] }> {
      return client.get('/v1/cloud-work-items/my-work')
    },
    listLoopItems(projectId: CloudProjectIdInput): Promise<{ items: CloudLoopItem[] }> {
      return client.get(`/v1/cloud-projects/${projectId}/loop-items`)
    },
    getLoopItem(itemId: string): Promise<CloudLoopItem> {
      return client.get(`/v1/loop-items/${encodeURIComponent(itemId)}`)
    },
    findLoopItemForTask(task: RuntimeTaskAddress): Promise<CloudLoopItem> {
      const query = new URLSearchParams({ device_id: task.deviceId, task_id: task.taskId })
      return client.get(`/v1/runtime-tasks/loop-item?${query.toString()}`)
    },
    findCloudContextForTask(task: RuntimeTaskAddress): Promise<CloudTaskContext> {
      const query = new URLSearchParams({ device_id: task.deviceId, task_id: task.taskId })
      return client.get(`/v1/runtime-tasks/cloud-context?${query.toString()}`)
    },
    createLoopItem(
      projectId: CloudProjectIdInput,
      data: {
        title: string
        description?: string
        status?: CloudLoopItem['status']
        priority?: CloudLoopItem['priority']
        due_at?: string
        parent_id?: string | null
      }
    ): Promise<CloudLoopItem> {
      return client.post(`/v1/cloud-projects/${projectId}/loop-items`, data)
    },
    updateLoopItem(
      itemId: string,
      data: Partial<
        Pick<
          CloudLoopItem,
          | 'title'
          | 'description'
          | 'status'
          | 'priority'
          | 'parent_id'
          | 'assignee_user_id'
          | 'due_at'
        >
      > & {
        version: number
      }
    ): Promise<CloudLoopItem> {
      return client.patch(`/v1/loop-items/${encodeURIComponent(itemId)}`, data)
    },
    listLoopItemAttachments(itemId: string): Promise<CloudLoopItemAttachment[]> {
      return client.get(`/v1/loop-items/${encodeURIComponent(itemId)}/attachments`)
    },
    addLoopItemAttachment(itemId: string, file: File): Promise<CloudLoopItemAttachment> {
      const form = new FormData()
      form.set('file', file, file.name)
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/attachments`, form)
    },
    accessLoopItemAttachment(
      attachmentId: string
    ): Promise<{ url: string; expires_in_seconds: number }> {
      return client.get(`/v1/loop-item-attachments/${attachmentId}/access`)
    },
    deleteLoopItemAttachment(attachmentId: string): Promise<void> {
      return client.delete(`/v1/loop-item-attachments/${attachmentId}`)
    },
    listTaskBindings(itemId: string): Promise<
      Array<{
        id: number
        loop_item_id: string
        task_user_id: number
        device_id: string
        task_id: string
        task_title: string | null
        backend_task_id: number | null
        linked_at: string
      }>
    > {
      return client.get(`/v1/loop-items/${encodeURIComponent(itemId)}/tasks`)
    },
    listLoopItemCollaborators(itemId: string): Promise<CloudLoopItemCollaborator[]> {
      return client.get(`/v1/loop-items/${encodeURIComponent(itemId)}/collaborators`)
    },
    addLoopItemCollaborator(itemId: string, userId: number): Promise<CloudLoopItemCollaborator> {
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/collaborators`, {
        user_id: userId,
      })
    },
    removeLoopItemCollaborator(itemId: string, userId: number): Promise<void> {
      return client.delete(`/v1/loop-items/${encodeURIComponent(itemId)}/collaborators/${userId}`)
    },
    bindTask(itemId: string, task: RuntimeTaskAddress, taskTitle?: string | null): Promise<void> {
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/tasks`, {
        ...task,
        ...(taskTitle ? { taskTitle } : {}),
      })
    },
    bindProjectTask(
      projectId: CloudProjectIdInput,
      task: RuntimeTaskAddress,
      taskTitle?: string | null
    ): Promise<void> {
      return client.post(`/v1/cloud-projects/${projectId}/tasks`, {
        ...task,
        ...(taskTitle ? { taskTitle } : {}),
      })
    },
    unbindCloudContext(task: RuntimeTaskAddress): Promise<void> {
      return client.delete('/v1/runtime-tasks/cloud-context', task)
    },
    unbindTask(itemId: string, task: RuntimeTaskAddress): Promise<void> {
      return client.delete(`/v1/loop-items/${encodeURIComponent(itemId)}/tasks`, task)
    },
    listLocalBindings(projectId: CloudProjectIdInput): Promise<CloudProjectLocalBinding[]> {
      return client.get(`/v1/cloud-projects/${projectId}/local-bindings`)
    },
    listCloudProjectMembers(projectId: CloudProjectIdInput): Promise<CloudProjectMember[]> {
      return client.get(`/v1/cloud-projects/${projectId}/members`)
    },
    addCloudProjectMember(
      projectId: CloudProjectIdInput,
      userId: number,
      role: CloudProjectMember['role'] = 'Developer'
    ): Promise<CloudProjectMember> {
      return client.post(`/v1/cloud-projects/${projectId}/members`, {
        user_id: userId,
        role,
      })
    },
    updateCloudProjectMember(
      projectId: CloudProjectIdInput,
      userId: number,
      role: Exclude<CloudProjectMember['role'], 'Owner'>
    ): Promise<CloudProjectMember> {
      return client.patch(`/v1/cloud-projects/${projectId}/members/${userId}`, { role })
    },
    removeCloudProjectMember(projectId: CloudProjectIdInput, userId: number): Promise<void> {
      return client.delete(`/v1/cloud-projects/${projectId}/members/${userId}`)
    },
    searchCloudProjectUsers(
      query: string
    ): Promise<{ users: CloudUserSearchItem[]; total: number }> {
      return client.get(`/users/search?q=${encodeURIComponent(query)}&limit=20`)
    },
    addLocalBinding(
      projectId: CloudProjectIdInput,
      data: { local_project_id: number; device_id?: string; is_default?: boolean }
    ): Promise<CloudProjectLocalBinding> {
      return client.post(`/v1/cloud-projects/${projectId}/local-bindings`, data)
    },
    listCloudFiles(projectId: CloudProjectIdInput): Promise<{ items: CloudProjectFile[] }> {
      return client.get(`/v1/cloud-projects/${projectId}/files`)
    },
    listProjectDeliveryFiles(
      projectId: CloudProjectIdInput
    ): Promise<{ items: ProjectDeliveryFile[] }> {
      return client.get(`/v1/cloud-projects/${projectId}/delivery-files`)
    },
    createCloudFolder(projectId: CloudProjectIdInput, path: string): Promise<CloudProjectFile> {
      return client.post(`/v1/cloud-projects/${projectId}/folders`, { path })
    },
    uploadCloudFile(
      projectId: CloudProjectIdInput,
      file: File,
      path = file.name
    ): Promise<CloudProjectFile> {
      const form = new FormData()
      form.set('file', file, file.name)
      form.set('path', path)
      return client.post(`/v1/cloud-projects/${projectId}/files`, form)
    },
    accessCloudFile(fileId: string): Promise<{ url: string; expires_in_seconds: number }> {
      return client.get(`/v1/cloud-projects/files/${fileId}/access`)
    },
    accessDeliveryFile(assetId: string): Promise<{ url: string; expires_in_seconds: number }> {
      return client.get(`/v1/delivery-assets/${encodeURIComponent(assetId)}/access`)
    },
    moveCloudFile(fileId: string, path: string, version: number): Promise<CloudProjectFile> {
      return client.patch(`/v1/cloud-projects/files/${fileId}`, { path, version })
    },
    deleteCloudFile(fileId: string, recursive = false): Promise<void> {
      return client.delete(
        `/v1/cloud-projects/files/${fileId}${recursive ? '?recursive=true' : ''}`
      )
    },
    createDelivery(itemId: string, data: DeliveryCreateInput): Promise<Delivery> {
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/deliveries`, data)
    },
    addAsset(deliveryId: string, file: File, relativePath: string): Promise<DeliveryAsset> {
      const form = new FormData()
      form.set('file', file, file.name)
      form.set('relative_path', relativePath)
      return client.post(`/v1/deliveries/${deliveryId}/assets`, form)
    },
    finalizeDelivery(deliveryId: string): Promise<Delivery> {
      return client.post(`/v1/deliveries/${deliveryId}/finalize`)
    },
    discardDraft(deliveryId: string): Promise<void> {
      return client.delete(`/v1/deliveries/${deliveryId}`)
    },
    listDeliveries(itemId: string): Promise<{ items: Delivery[] }> {
      return client.get(`/v1/loop-items/${encodeURIComponent(itemId)}/deliveries`)
    },
    getDelivery(deliveryId: string): Promise<DeliveryDetail> {
      return client.get(`/v1/deliveries/${deliveryId}`)
    },
  }
}
