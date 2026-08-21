import type { CloudMyWorkItem } from '@/api/deliveries'
import type {
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/api'
import {
  getRuntimeTaskLifecycleKey,
  type RuntimeTaskLifecycleStoreSnapshot,
} from '@/features/workbench/runtimeTaskLifecycle'
import { runtimeTaskBoardState } from '@/features/workbench/runtimeTaskLifecycle/projection'

export interface RuntimeMyWorkItem extends CloudMyWorkItem {
  runtime_address: RuntimeTaskAddress
}

function taskBoardStatus(
  task: RuntimeTaskSummary,
  address: RuntimeTaskAddress,
  lifecycleSnapshot?: RuntimeTaskLifecycleStoreSnapshot
): {
  status: CloudMyWorkItem['status']
  hasActiveTask: boolean
} {
  const lifecycle = lifecycleSnapshot?.tasks.get(getRuntimeTaskLifecycleKey(address))
  if (lifecycle?.derived.isRunning) {
    return { status: 'in_progress', hasActiveTask: true }
  }
  if (lifecycle?.derived.isQueued) {
    return { status: 'pending', hasActiveTask: false }
  }
  const state = runtimeTaskBoardState(lifecycle?.task ?? task)
  if (state === 'active') return { status: 'in_progress', hasActiveTask: true }
  if (state === 'completed') return { status: 'completed', hasActiveTask: false }
  if (state === 'queued') return { status: 'pending', hasActiveTask: false }
  return { status: 'in_review', hasActiveTask: false }
}

function timestamp(value: string | number | null | undefined): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value
    return new Date(milliseconds).toISOString()
  }
  return new Date(0).toISOString()
}

function runtimeCloudProjectId(task: RuntimeTaskSummary): string | null {
  const value = task.runtimeHandle?.cloudProjectId ?? task.runtimeHandle?.cloud_project_id
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

function workspaceItems(
  workspace: RuntimeDeviceWorkspace,
  project: { key: string; name: string },
  lifecycleSnapshot?: RuntimeTaskLifecycleStoreSnapshot
): RuntimeMyWorkItem[] {
  return workspace.tasks.map(task => {
    const runtimeAddress: RuntimeTaskAddress = {
      deviceId: workspace.deviceId,
      taskId: task.taskId,
      runtime: task.runtime,
      threadId: task.threadId,
      workspacePath: task.workspacePath || workspace.workspacePath,
      runtimeHandle: task.runtimeHandle,
    }
    const lifecycle = taskBoardStatus(task, runtimeAddress, lifecycleSnapshot)
    const projectId = runtimeCloudProjectId(task) ?? `runtime:${project.key}`
    return {
      id: task.taskId,
      cloud_project_id: projectId,
      sequence_number: 0,
      parent_id: null,
      created_by_user_id: 0,
      can_view_detail: true,
      can_edit: false,
      assignee_user_id: null,
      assignee_agent_id: null,
      execution_id: null,
      execution_state: lifecycle.hasActiveTask ? 'running' : null,
      assignee_name: null,
      title: task.title,
      description: '',
      status: lifecycle.status,
      priority: 'none',
      due_at: null,
      tags: [],
      sort_order: 0,
      current_delivery_id: null,
      version: 0,
      created_at: timestamp(task.createdAt),
      updated_at: timestamp(task.updatedAt ?? task.createdAt),
      completed_at: task.completedAt == null ? null : timestamp(task.completedAt),
      project_key: project.key,
      project_name: project.name,
      has_active_task: lifecycle.hasActiveTask,
      runtime_address: runtimeAddress,
    }
  })
}

export function runtimeMyWorkItems(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  lifecycleSnapshot?: RuntimeTaskLifecycleStoreSnapshot
) {
  if (!runtimeWork) return []
  const items = [
    ...runtimeWork.projects.flatMap(projectWork =>
      projectWork.deviceWorkspaces.flatMap(workspace =>
        workspaceItems(
          workspace,
          {
            key: projectWork.project.key,
            name: projectWork.project.name,
          },
          lifecycleSnapshot
        )
      )
    ),
    ...runtimeWork.chats.flatMap(workspace =>
      workspaceItems(
        workspace,
        {
          key: 'LOCAL',
          name: workspace.label || '本地任务',
        },
        lifecycleSnapshot
      )
    ),
  ]
  const unique = new Map<string, RuntimeMyWorkItem>()
  for (const item of items) {
    unique.set(`${item.runtime_address.deviceId}:${item.runtime_address.taskId}`, item)
  }
  return [...unique.values()]
}

export function isRuntimeMyWorkItem(item: CloudMyWorkItem): item is RuntimeMyWorkItem {
  return 'runtime_address' in item
}
