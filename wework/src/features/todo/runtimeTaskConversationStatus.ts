import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import {
  runtimeTaskSummaryTrackingExecutionStatus,
  runtimeTaskTrackingExecutionStatus,
  isRuntimeTaskExecutionRunning,
  type RuntimeTaskTrackingExecutionStatus,
} from '@/features/workbench/runtimeTaskLifecycle/projection'
import type { RuntimeWorkListResponse } from '@/types/api'
import type { SharedIssueDetailTaskExecutionState } from '@wegent/collaboration'

export type RuntimeTaskConversationStatus = Exclude<RuntimeTaskTrackingExecutionStatus, 'archived'>

export function issueTaskExecutionStates(
  bindings: readonly { id: string | number; deviceId: string; taskId: string }[],
  runtimeStatuses: ReadonlyMap<string, RuntimeTaskConversationStatus>
): Readonly<Record<string, SharedIssueDetailTaskExecutionState>> {
  return Object.fromEntries(
    bindings.flatMap(binding => {
      const status = runtimeStatuses.get(runtimeConversationKey(binding))
      return status ? [[String(binding.id), { status }]] : []
    })
  )
}

export function runtimeTasksRunningByAddress(
  runtimeWork?: RuntimeWorkListResponse | null,
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
): ReadonlyMap<string, boolean> {
  const running = new Map<string, boolean>()
  const workspaces = [
    ...(runtimeWork?.projects ?? []).flatMap(item => item.deviceWorkspaces),
    ...(runtimeWork?.chats ?? []),
  ]
  for (const workspace of workspaces) {
    for (const task of workspace.tasks) {
      running.set(
        runtimeConversationKey({ deviceId: workspace.deviceId, taskId: task.taskId }),
        isRuntimeTaskExecutionRunning(task)
      )
    }
  }
  for (const lifecycle of runtimeTaskLifecycle?.tasks.values() ?? []) {
    running.set(
      runtimeConversationKey(lifecycle.address),
      lifecycle.execution.running || lifecycle.turn.active
    )
  }
  return running
}

function conversationStatus(
  status: RuntimeTaskTrackingExecutionStatus | null
): RuntimeTaskConversationStatus | null {
  if (status === 'archived') return 'succeeded'
  return status
}

export function runtimeTaskConversationStatusesByAddress(
  runtimeWork?: RuntimeWorkListResponse | null,
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
): ReadonlyMap<string, RuntimeTaskConversationStatus> {
  const statuses = new Map<string, RuntimeTaskConversationStatus>()
  const workspaces = [
    ...(runtimeWork?.projects ?? []).flatMap(project => project.deviceWorkspaces),
    ...(runtimeWork?.chats ?? []),
  ]

  for (const workspace of workspaces) {
    for (const task of workspace.tasks) {
      const status = conversationStatus(runtimeTaskSummaryTrackingExecutionStatus(task))
      if (!status) continue
      statuses.set(
        runtimeConversationKey({ deviceId: workspace.deviceId, taskId: task.taskId }),
        status
      )
    }
  }

  for (const lifecycle of runtimeTaskLifecycle?.tasks.values() ?? []) {
    const status = conversationStatus(runtimeTaskTrackingExecutionStatus(lifecycle))
    const key = runtimeConversationKey(lifecycle.address)
    if (status) statuses.set(key, status)
    else statuses.delete(key)
  }

  return statuses
}
