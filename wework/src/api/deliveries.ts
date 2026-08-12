import { invoke } from '@tauri-apps/api/core'
import { ApiError, type HttpClient } from './http'
import type { RuntimeTaskAddress } from '@/types/api'

import { openLocalFile } from '@/lib/local-terminal'
import { isTauriRuntime } from '@/lib/runtime-environment'

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
  created_by_user_name?: string | null
  can_view_detail?: boolean
  can_edit?: boolean
  assignee_user_id: number | null
  assignee_name?: string | null
  assignee_agent_id?: string | null
  assignee_agent_name?: string | null
  execution_id?: number | null
  execution_state?: string | null
  can_approve?: boolean
  assignment_history?: Array<{
    by_user_id: number
    to_type: 'user' | 'agent' | null
    to_id: string | null
    to_name?: string | null
    action: 'assign' | 'reassign' | 'unassign'
    at: string
  }>
  approval?: {
    status: 'pending' | 'approved' | 'rejected'
    requested_at?: string
    approved_by_user_id?: number
    approved_at?: string
    rejected_by_user_id?: number
    rejected_at?: string
    reason?: string | null
  } | null
  queued_at?: string | null
  execution_note?: string | null
  execution_error?: string | null
  automation?: {
    rule_id?: string
    run_id?: string
    trigger?: 'scheduled' | 'manual' | string
    scheduled_for?: string | null
    bug_key?: string
  } | null
  ai_state?: {
    run_id?: string
    status?: string
    agent_id?: string | null
    agent_name?: string | null
    trigger_message_id?: string | null
    project_chat_message_id?: string | null
    runtime_device_id?: string | null
    runtime_task_id?: string | null
    started_at?: string | null
    heartbeat_at?: string | null
    lease_expires_at?: string | null
    completed_at?: string | null
    updated_at?: string | null
    last_error?: string | null
    auto_retry?: boolean
    auto_retry_count?: number
  } | null
  title: string
  description: string
  status: string
  priority: 'none' | 'low' | 'medium' | 'high' | 'urgent'
  due_at: string | null
  tags: string[]
  sort_order: number
  current_delivery_id: string | null
  version: number
  created_at: string
  updated_at: string
  completed_at: string | null
  source_status?: string | null
  source_record_id?: string | null
  source_cells?: Record<string, unknown>
}

export interface CloudLoopItemExecution {
  id: number
  loop_item_id: string
  cloud_project_id: string
  task_title: string
  task_status?: string | null
  task_priority?: string | null
  agent_id: string
  assigner_user_id: number
  execution_environment: string
  execution_device_id?: string | null
  status: string
  priority_weight: number
  queued_at?: string | null
  started_at?: string | null
  completed_at?: string | null
  lease_expires_at?: string | null
  heartbeat_at?: string | null
  retry_attempt: number
  error_message?: string | null
  execution_note?: string | null
  approval_status?: string | null
  approved_by_user_id?: number | null
  rejected_reason?: string | null
  runtime_device_id?: string | null
  runtime_task_id?: string | null
  version: number
  created_at: string
  updated_at: string
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
  markdown_url: string
  markdown: string
}

export interface CloudProject {
  id: CloudProjectId
  location?: 'local' | 'cloud'
  public_id: string
  project_key: string
  name: string
  description: string
  project_store: 'local' | 'backend'
  // Cloud responses can contain provider kinds introduced by a newer backend.
  task_provider: string
  provider_config: {
    repository?: string
    domain?: string
    api_base?: string
    credential_configured?: boolean
    base_id?: string
    table_id?: string
    sheet_id?: string
    source_url?: string
    view_id?: string
    board_mapping?: Record<string, string>
    status_mode?: 'mapped' | 'custom'
    status_mapping?: Record<string, CloudLoopItem['status']>
    custom_statuses?: string[]
  }
  card_display?: {
    show_assignee: boolean
    show_priority: boolean
    show_tags: boolean
    show_date: boolean
  }
  board_config?: {
    group_by: 'status' | 'priority' | 'assignee' | 'tag'
    statuses: Array<{
      id: string
      name: string
      color: 'gray' | 'blue' | 'orange' | 'purple' | 'green' | 'red'
    }>
  }
  ai_automation?: {
    auto_retry_on_failure: boolean
    max_retry_count: number
  }
  created_by_user_id: number
  current_user_id?: number
  current_user_name?: string
  access_role?: 'Owner' | 'Maintainer' | 'Developer' | 'Reporter' | 'RestrictedAnalyst'
  visibility?: 'private' | 'public'
  status: string
  tags: string[]
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

type TaskExecutionStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

export function nextTaskTrackingStatus(
  itemStatus: CloudLoopItem['status'],
  executionStatus: TaskExecutionStatus
): CloudLoopItem['status'] | null {
  if (
    executionStatus === 'running' &&
    (itemStatus === 'inbox' || itemStatus === 'pending' || itemStatus === 'in_review')
  ) {
    return 'in_progress'
  }
  if (executionStatus === 'succeeded' && itemStatus === 'in_progress') {
    return 'in_review'
  }
  return null
}

function projectTaskTrackingKey(projectId: CloudProjectIdInput, task: RuntimeTaskAddress): string {
  return `${projectId}:${task.deviceId}:${task.taskId}`
}

export function createProjectTaskTrackingSingleFlight() {
  const requests = new Map<string, Promise<{ item: CloudLoopItem }>>()

  return (
    projectId: CloudProjectIdInput,
    task: RuntimeTaskAddress,
    create: () => Promise<{ item: CloudLoopItem }>
  ): Promise<{ item: CloudLoopItem }> => {
    const key = projectTaskTrackingKey(projectId, task)
    const existing = requests.get(key)
    if (existing) return existing

    const request = create()
    requests.set(key, request)
    const clear = () => {
      if (requests.get(key) === request) requests.delete(key)
    }
    void request.then(clear, clear)
    return request
  }
}

export function createDeliveryApi(client: HttpClient) {
  const trackProjectTaskOnce = createProjectTaskTrackingSingleFlight()
  const pendingTrackedItems = new Map<string, CloudLoopItem>()

  const api = {
    listCloudProjects(): Promise<{ items: CloudProject[] }> {
      return client.get('/v1/cloud-projects')
    },
    createCloudProject(data: {
      project_key?: string
      name: string
      description?: string
      task_provider?: 'local' | 'github' | 'gitlab' | 'dingtalk_aitable'
      visibility?: 'private' | 'public'
      provider_config?: {
        repository?: string
        domain?: string
        api_base?: string
        token?: string
        base_id?: string
        table_id?: string
        sheet_id?: string
        source_url?: string
        view_id?: string
        board_mapping?: Record<string, string>
        status_mode?: 'mapped' | 'custom'
        status_mapping?: Record<string, CloudLoopItem['status']>
        custom_statuses?: string[]
      }
    }): Promise<CloudProject> {
      return client.post('/v1/cloud-projects', data)
    },
    updateCloudProject(
      projectId: CloudProjectIdInput,
      data: {
        name?: string
        description?: string
        tags?: string[]
        visibility?: 'private' | 'public'
        card_display?: CloudProject['card_display']
        board_config?: CloudProject['board_config']
        provider_config?: {
          repository?: string
          domain?: string
          api_base?: string
          token?: string
          base_id?: string
          table_id?: string
          sheet_id?: string
          source_url?: string
          view_id?: string
          board_mapping?: Record<string, string>
          status_mode?: 'mapped' | 'custom'
          status_mapping?: Record<string, CloudLoopItem['status']>
          custom_statuses?: string[]
        }
        version: number
      }
    ): Promise<CloudProject> {
      return client.patch(`/v1/cloud-projects/${projectId}`, data)
    },
    archiveCloudProject(projectId: CloudProjectIdInput, version: number): Promise<void> {
      return client.delete(`/v1/cloud-projects/${projectId}?version=${version}`)
    },
    listMyWork(): Promise<{ items: CloudMyWorkItem[] }> {
      return client.get('/v1/cloud-work-items/my-work')
    },
    listLoopItems(
      projectId: CloudProjectIdInput,
      filters?: {
        assigneeType?: 'user' | 'agent'
        assigneeId?: string | number
        executionState?: string
      }
    ): Promise<{ items: CloudLoopItem[] }> {
      const query = new URLSearchParams()
      if (filters?.assigneeType) query.set('assignee_type', filters.assigneeType)
      if (filters?.assigneeId !== undefined && filters.assigneeId !== null) {
        query.set('assignee_id', String(filters.assigneeId))
      }
      if (filters?.executionState) query.set('execution_state', filters.executionState)
      const suffix = query.toString() ? `?${query.toString()}` : ''
      return client.get(`/v1/cloud-projects/${projectId}/loop-items${suffix}`)
    },
    listLoopItemExecutions(
      projectId: CloudProjectIdInput,
      options: { agent_id?: string; status?: string } = {}
    ): Promise<{ items: CloudLoopItemExecution[] }> {
      const query = new URLSearchParams()
      if (options.agent_id) query.set('agent_id', options.agent_id)
      if (options.status) query.set('status', options.status)
      const suffix = query.toString() ? `?${query.toString()}` : ''
      return client
        .get<{
          items: Array<Record<string, unknown>>
        }>(`/v1/cloud-projects/${projectId}/executions${suffix}`)
        .then(response => ({
          items: response.items.map(row => ({
            id: Number(row.id),
            loop_item_id: String(row.loopItemId ?? ''),
            cloud_project_id: String(row.cloudProjectId ?? ''),
            task_title: String(row.taskTitle ?? ''),
            task_status: row.taskStatus == null ? null : String(row.taskStatus),
            task_priority: row.taskPriority == null ? null : String(row.taskPriority),
            agent_id: String(row.agentId ?? ''),
            assigner_user_id: Number(row.assignerUserId ?? 0),
            execution_environment: String(row.executionEnvironment ?? ''),
            execution_device_id:
              row.executionDeviceId == null ? null : String(row.executionDeviceId),
            status: String(row.status ?? ''),
            priority_weight: Number(row.priorityWeight ?? 0),
            queued_at: row.queuedAt == null ? null : String(row.queuedAt),
            started_at: row.startedAt == null ? null : String(row.startedAt),
            completed_at: row.completedAt == null ? null : String(row.completedAt),
            lease_expires_at: row.leaseExpiresAt == null ? null : String(row.leaseExpiresAt),
            heartbeat_at: row.heartbeatAt == null ? null : String(row.heartbeatAt),
            retry_attempt: Number(row.retryAttempt ?? 0),
            error_message: row.errorMessage == null ? null : String(row.errorMessage),
            execution_note: row.executionNote == null ? null : String(row.executionNote),
            approval_status: row.approvalStatus == null ? null : String(row.approvalStatus),
            approved_by_user_id: row.approvedByUserId == null ? null : Number(row.approvedByUserId),
            rejected_reason: row.rejectedReason == null ? null : String(row.rejectedReason),
            runtime_device_id: row.runtimeDeviceId == null ? null : String(row.runtimeDeviceId),
            runtime_task_id: row.runtimeTaskId == null ? null : String(row.runtimeTaskId),
            version: Number(row.version ?? 1),
            created_at: String(row.createdAt ?? ''),
            updated_at: String(row.updatedAt ?? ''),
          })),
        }))
    },
    stopExecution(
      projectId: CloudProjectIdInput,
      executionId: number
    ): Promise<{ id: number; status: string }> {
      return client.post(`/v1/cloud-projects/${projectId}/executions/${executionId}/stop`)
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
        tags?: string[]
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
          | 'assignee_agent_id'
          | 'due_at'
          | 'tags'
        >
      > & {
        version: number
      }
    ): Promise<CloudLoopItem> {
      return client.patch(`/v1/loop-items/${encodeURIComponent(itemId)}`, data)
    },
    assignLoopItem(
      projectId: CloudProjectIdInput,
      itemId: string,
      data: {
        version: number
        assigneeType: 'user' | 'agent'
        assigneeId: string
      }
    ): Promise<CloudLoopItem> {
      return client.post(
        `/v1/cloud-projects/${projectId}/loop-items/${encodeURIComponent(itemId)}/assign`,
        data
      )
    },
    approveLoopItemRun(
      projectId: CloudProjectIdInput,
      itemId: string,
      version: number
    ): Promise<CloudLoopItem> {
      return client.post(
        `/v1/cloud-projects/${projectId}/loop-items/${encodeURIComponent(itemId)}/approve`,
        { version }
      )
    },
    rejectLoopItemRun(
      projectId: CloudProjectIdInput,
      itemId: string,
      version: number,
      reason?: string
    ): Promise<CloudLoopItem> {
      return client.post(
        `/v1/cloud-projects/${projectId}/loop-items/${encodeURIComponent(itemId)}/reject`,
        { version, reason: reason ?? null }
      )
    },
    archiveLoopItem(itemId: string): Promise<void> {
      return client.delete(`/v1/loop-items/${encodeURIComponent(itemId)}`)
    },
    reorderLoopItems(
      projectId: CloudProjectIdInput,
      data: {
        parent_id: string | null
        status: string
        item_ids: string[]
      }
    ): Promise<{ items: CloudLoopItem[] }> {
      return client.post(`/v1/cloud-projects/${projectId}/loop-items/reorder`, data)
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
    readLoopItemAttachment(attachmentId: string): Promise<Blob> {
      return client.getBlob(`/v1/loop-item-attachments/${attachmentId}/content`)
    },
    async downloadLoopItemAttachment(attachmentId: string, filename: string): Promise<void> {
      const content = await client.getBlob(`/v1/loop-item-attachments/${attachmentId}/content`)
      if (isTauriRuntime()) {
        const path = await invoke<string>('save_local_attachment_file', {
          workspacePath: null,
          filename,
          bytes: Array.from(new Uint8Array(await content.arrayBuffer())),
        })
        await openLocalFile(path)
        return
      }
      const url = URL.createObjectURL(content)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
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
    trackProjectTask(
      projectId: CloudProjectIdInput,
      task: RuntimeTaskAddress,
      taskTitle: string,
      description: string
    ): Promise<{ item: CloudLoopItem }> {
      return trackProjectTaskOnce(projectId, task, async () => {
        const trackingKey = projectTaskTrackingKey(projectId, task)
        try {
          const existing = await api.findCloudContextForTask(task)
          if (existing.loop_item_id) {
            pendingTrackedItems.delete(trackingKey)
            return { item: await api.getLoopItem(existing.loop_item_id) }
          }
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error
        }

        const item =
          pendingTrackedItems.get(trackingKey) ??
          (await api.createLoopItem(projectId, {
            title: taskTitle,
            description,
            status: 'in_progress',
          }))
        pendingTrackedItems.set(trackingKey, item)
        await api.bindTask(item.id, task, taskTitle)
        pendingTrackedItems.delete(trackingKey)
        return { item }
      })
    },
    async updateTaskTrackingStatus(
      task: RuntimeTaskAddress,
      executionStatus: TaskExecutionStatus
    ): Promise<CloudLoopItem | null> {
      let context: CloudTaskContext
      try {
        context = await api.findCloudContextForTask(task)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null
        throw error
      }
      if (!context.loop_item_id) return null
      const item = await api.getLoopItem(context.loop_item_id)
      const nextStatus = nextTaskTrackingStatus(item.status, executionStatus)
      return nextStatus
        ? api.updateLoopItem(item.id, {
            version: item.version,
            status: nextStatus,
          })
        : item
    },
    async updateTaskTrackingTitle(
      task: RuntimeTaskAddress,
      title: string
    ): Promise<CloudLoopItem | null> {
      let context: CloudTaskContext
      try {
        context = await api.findCloudContextForTask(task)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null
        throw error
      }
      if (!context.loop_item_id) return null
      const item = await api.getLoopItem(context.loop_item_id)
      return item.title === title
        ? item
        : api.updateLoopItem(item.id, {
            version: item.version,
            title,
          })
    },
    unbindCloudContext(task: RuntimeTaskAddress): Promise<void> {
      return client.delete('/v1/runtime-tasks/cloud-context', task)
    },
    unbindTask(itemId: string, task: RuntimeTaskAddress): Promise<void> {
      return client.delete(`/v1/loop-items/${encodeURIComponent(itemId)}/tasks`, task)
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
  return api
}
