import type { CloudLoopItem } from '@/api/deliveries'
import {
  getRuntimeTaskLifecycleKey,
  type RuntimeTaskLifecycleStoreSnapshot,
} from '@/features/workbench/runtimeTaskLifecycle'
import { runtimeTaskBoardState } from '@/features/workbench/runtimeTaskLifecycle/projection'
import type {
  RuntimeDeviceWorkspace,
  RuntimeProjectSpaceRef,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/api'

export interface RuntimeMyWorkItem extends CloudLoopItem {
  project_store: RuntimeProjectSpaceRef['projectStore']
  runtime_address: RuntimeTaskAddress
  cloud_issue_id: string | null
}

export interface RuntimeMyWorkProjectionTarget {
  projectId: string
  projectStore: RuntimeProjectSpaceRef['projectStore']
  createdByUserId: number
}

export interface RuntimeIssueBinding {
  loop_item_id?: string | null
  device_id: string
  task_id: string
}

function runtimeTaskKey(address: Pick<RuntimeTaskAddress, 'deviceId' | 'taskId'>): string {
  return `${address.deviceId}\0${address.taskId}`
}

function taskBoardStatus(
  task: RuntimeTaskSummary,
  address: RuntimeTaskAddress,
  lifecycleSnapshot?: RuntimeTaskLifecycleStoreSnapshot
): Pick<RuntimeMyWorkItem, 'status' | 'execution_state'> {
  const lifecycle = lifecycleSnapshot?.tasks.get(getRuntimeTaskLifecycleKey(address))
  if (lifecycle?.derived.isRunning) {
    return { status: 'in_progress', execution_state: 'running' }
  }
  if (lifecycle?.derived.isQueued) {
    return { status: 'pending', execution_state: null }
  }
  const state = runtimeTaskBoardState(lifecycle?.task ?? task)
  if (state === 'active') return { status: 'in_progress', execution_state: 'running' }
  if (state === 'completed') return { status: 'completed', execution_state: null }
  if (state === 'queued') return { status: 'pending', execution_state: null }
  return { status: 'in_review', execution_state: null }
}

function timestamp(value: string | number | null | undefined): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value
    return new Date(milliseconds).toISOString()
  }
  return new Date(0).toISOString()
}

function runtimeIssueId(task: RuntimeTaskSummary): string | null {
  const handle = task.runtimeHandle
  const origin =
    handle?.origin && typeof handle.origin === 'object'
      ? (handle.origin as Record<string, unknown>)
      : null
  const value =
    handle?.loopItemId ?? handle?.loop_item_id ?? origin?.loopItemId ?? origin?.loop_item_id
  return typeof value === 'string' && value ? value : null
}

export function runtimeWorkItemReference(
  task: RuntimeTaskSummary
): { projectId: string; itemId: string } | null {
  const handle = task.runtimeHandle
  const origin =
    handle?.origin && typeof handle.origin === 'object'
      ? (handle.origin as Record<string, unknown>)
      : null
  const projectId =
    handle?.cloudProjectId ??
    handle?.cloud_project_id ??
    origin?.cloudProjectId ??
    origin?.cloud_project_id
  const itemId = runtimeIssueId(task)
  return (typeof projectId === 'string' || typeof projectId === 'number') && itemId
    ? { projectId: String(projectId), itemId }
    : null
}

function workspaceItems(
  workspace: RuntimeDeviceWorkspace,
  localProject: { id: number | null; name: string | null },
  target: RuntimeMyWorkProjectionTarget,
  lifecycleSnapshot?: RuntimeTaskLifecycleStoreSnapshot
): RuntimeMyWorkItem[] {
  return workspace.tasks.map(task => {
    const runtimeAddress: RuntimeTaskAddress = {
      deviceId: workspace.deviceId,
      taskId: task.taskId,
      runtime: task.runtime,
      threadId: task.threadId,
      workspacePath: task.workspacePath || workspace.workspacePath,
      workspaceKind: task.workspaceKind ?? workspace.workspaceKind,
      worktreeId: task.worktreeId ?? workspace.worktreeId,
      runtimeHandle: task.runtimeHandle,
    }
    const lifecycle = taskBoardStatus(task, runtimeAddress, lifecycleSnapshot)
    return {
      id: `runtime:${encodeURIComponent(workspace.deviceId)}:${encodeURIComponent(task.taskId)}`,
      cloud_project_id: target.projectId,
      sequence_number: 0,
      parent_id: null,
      created_by_user_id: target.createdByUserId,
      can_view_detail: true,
      can_edit: false,
      detail_loaded: true,
      assignee_user_id: null,
      assignee_agent_id: null,
      execution_id: null,
      execution_state: lifecycle.execution_state,
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
      local_project_id: localProject.id,
      local_project_name: localProject.name,
      project_store: target.projectStore,
      runtime_address: runtimeAddress,
      cloud_issue_id: runtimeIssueId(task),
    }
  })
}

export function runtimeMyWorkItems(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  target: RuntimeMyWorkProjectionTarget,
  lifecycleSnapshot?: RuntimeTaskLifecycleStoreSnapshot
): RuntimeMyWorkItem[] {
  if (!runtimeWork) return []
  const items = [
    ...runtimeWork.projects.flatMap(projectWork =>
      projectWork.deviceWorkspaces.flatMap(workspace =>
        workspaceItems(
          workspace,
          {
            id: projectWork.project.id ?? null,
            name: projectWork.project.name,
          },
          target,
          lifecycleSnapshot
        )
      )
    ),
    ...runtimeWork.chats.flatMap(workspace =>
      workspaceItems(
        workspace,
        {
          id: null,
          name: workspace.label ?? null,
        },
        target,
        lifecycleSnapshot
      )
    ),
  ]
  const unique = new Map<string, RuntimeMyWorkItem>()
  for (const item of items) {
    unique.set(runtimeTaskKey(item.runtime_address), item)
  }
  return [...unique.values()]
}

export function mergeRuntimeMyWorkItems<T extends CloudLoopItem>(
  persistedItems: T[],
  runtimeItems: RuntimeMyWorkItem[],
  bindings: RuntimeIssueBinding[] = [],
  knownIssueIds: Iterable<string> = persistedItems.map(item => item.id)
): Array<T | RuntimeMyWorkItem> {
  const issueIds = new Set(knownIssueIds)
  for (const item of persistedItems) issueIds.add(item.id)
  const boundRuntimeTasks = new Map(
    bindings.flatMap(binding =>
      binding.loop_item_id
        ? [
            [
              runtimeTaskKey({ deviceId: binding.device_id, taskId: binding.task_id }),
              binding.loop_item_id,
            ],
          ]
        : []
    )
  )
  return [
    ...persistedItems,
    ...runtimeItems.filter(item => {
      if (item.cloud_issue_id && issueIds.has(item.cloud_issue_id)) return false
      const boundIssueId = boundRuntimeTasks.get(runtimeTaskKey(item.runtime_address))
      return !boundIssueId || !issueIds.has(boundIssueId)
    }),
  ]
}

export function isRuntimeMyWorkItem(item: CloudLoopItem): item is RuntimeMyWorkItem {
  return 'runtime_address' in item
}
