import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import {
  runtimeTaskSummaryTrackingExecutionStatus,
  runtimeTaskTrackingExecutionStatus,
  type RuntimeTaskTrackingExecutionStatus,
} from '@/features/workbench/runtimeTaskLifecycle/projection'
import type { RuntimeWorkListResponse } from '@/types/api'

export type RuntimeTaskConversationStatus = Exclude<RuntimeTaskTrackingExecutionStatus, 'archived'>

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
