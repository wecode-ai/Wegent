import type { CloudLoopItem, LoopItemTaskBinding } from '@/api/deliveries'
import type { RuntimeTaskStatusReplayRequest, RuntimeTaskStatusReplayResponse } from '@/types/api'

export const STALE_RUNTIME_TASK_MS = 30 * 60 * 1000
const RECOVERY_LEASE_MS = 60 * 1000
const recoveryLeases = new Map<string, number>()

interface RuntimeStatusReplayApi {
  replayRuntimeTaskStatuses: (
    request: RuntimeTaskStatusReplayRequest
  ) => Promise<RuntimeTaskStatusReplayResponse>
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function workflowTaskStatus(item: CloudLoopItem, binding: LoopItemTaskBinding): string | undefined {
  const node = item.workflow?.nodes.find(candidate => candidate.id === binding.workflow_node_id)
  return node?.task_statuses?.[`${binding.device_id}:${binding.task_id}`]
}

export function staleRuntimeTaskBatches(
  items: CloudLoopItem[],
  bindings: LoopItemTaskBinding[],
  now = Date.now()
): RuntimeTaskStatusReplayRequest[] {
  const itemsById = new Map(items.map(item => [item.id, item]))
  const tasksByDevice = new Map<string, Set<string>>()

  for (const binding of bindings) {
    const deviceId = binding.device_id.trim()
    const taskId = binding.task_id.trim()
    if (!binding.loop_item_id || !binding.workflow_node_id || !deviceId || !taskId) continue
    const item = itemsById.get(binding.loop_item_id)
    const node = item?.workflow?.nodes.find(candidate => candidate.id === binding.workflow_node_id)
    if (!item || !node || ['completed', 'forced_completed'].includes(node.status)) continue
    const taskStatus = workflowTaskStatus(item, binding)
    if (['succeeded', 'archived', 'failed', 'cancelled'].includes(taskStatus ?? '')) continue
    const lastObservation =
      taskStatus === 'running' ? timestamp(item.updated_at) : timestamp(binding.linked_at)
    if (lastObservation === null || now - lastObservation < STALE_RUNTIME_TASK_MS) continue
    const taskIds = tasksByDevice.get(deviceId) ?? new Set<string>()
    taskIds.add(taskId)
    tasksByDevice.set(deviceId, taskIds)
  }

  return Array.from(tasksByDevice, ([deviceId, taskIds]) => ({
    deviceId,
    taskIds: Array.from(taskIds),
  }))
}

export async function requestBoardTaskStatusRecovery({
  api,
  projectKey,
  items,
  bindings,
  now = Date.now(),
}: {
  api: RuntimeStatusReplayApi
  projectKey: string
  items: CloudLoopItem[]
  bindings: LoopItemTaskBinding[]
  now?: number
}): Promise<void> {
  const requests = staleRuntimeTaskBatches(items, bindings, now).filter(request => {
    const leaseKey = `${projectKey}\0${request.deviceId}`
    if ((recoveryLeases.get(leaseKey) ?? 0) > now) return false
    recoveryLeases.set(leaseKey, now + RECOVERY_LEASE_MS)
    return true
  })
  await Promise.allSettled(
    requests.map(async request => {
      console.info('[IssueTaskRecovery] replay_requested', {
        projectKey,
        deviceId: request.deviceId,
        taskIds: request.taskIds,
      })
      const result = await api.replayRuntimeTaskStatuses(request)
      console.info('[IssueTaskRecovery] replay_finished', {
        projectKey,
        deviceId: request.deviceId,
        replayedTaskIds: result.replayedTaskIds,
        missingTaskIds: result.missingTaskIds,
      })
      return result
    })
  )
}

export function resetTaskStatusRecoveryLeasesForTests(): void {
  recoveryLeases.clear()
}
