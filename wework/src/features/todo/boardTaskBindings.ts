import type { LoopItemTaskBinding } from '@/api/deliveries'
import type { RuntimeDeviceWorkspace, RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'
import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import { runtimeTaskChangeRequestTarget } from '@/features/workbench/changeRequestMonitor'
import type { CloudTodoBoardTaskBinding } from './CloudTodoBoardCard'

/** Project bindings into the board without maintaining another copy of goal data. */
export function createBoardTaskBindings({
  bindings,
  runtimeTasks,
  running,
  addressForBinding,
}: {
  bindings: Record<string, LoopItemTaskBinding[]>
  runtimeTasks: ReadonlyMap<string, { workspace: RuntimeDeviceWorkspace; task: RuntimeTaskSummary }>
  running: ReadonlyMap<string, boolean>
  addressForBinding(binding: LoopItemTaskBinding): RuntimeTaskAddress
}): Record<string, CloudTodoBoardTaskBinding[]> {
  return Object.fromEntries(
    Object.entries(bindings).map(([itemId, entries]) => [
      itemId,
      entries.map(binding => {
        const key = runtimeConversationKey({ deviceId: binding.device_id, taskId: binding.task_id })
        const task = runtimeTasks.get(key)
        return {
          id: binding.id,
          device_id: binding.device_id,
          task_id: binding.task_id,
          task_title: binding.task_title,
          modelSelection: binding.modelSelection,
          executionContext: binding.executionContext,
          runtimeAddress: addressForBinding(binding),
          runtimeTask: task?.task,
          running: running.get(key) ?? false,
          changeRequestTarget: task
            ? runtimeTaskChangeRequestTarget(task.workspace, task.task)
            : null,
        }
      }),
    ])
  )
}
