import type { CloudLoopItem } from '@/api/deliveries'
import type { ProjectTaskRuntimeApi } from '@/features/workbench/projectTaskTracking'
import type { RuntimeTaskAddress } from '@/types/api'

export class TaskOriginRecoveryError extends AggregateError {}

/** Separate stores cannot replace each other's links inside their binding transaction. */
export async function replaceTaskOrigin({
  previous,
  target,
  task,
  title,
  link,
  current,
  recoveryFailed,
}: {
  previous: { api: ProjectTaskRuntimeApi; item: CloudLoopItem } | null
  target: ProjectTaskRuntimeApi
  task: RuntimeTaskAddress
  title: string
  link(): Promise<CloudLoopItem>
  current(): boolean
  recoveryFailed: string
}): Promise<CloudLoopItem | null> {
  if (!current()) return null
  // The existing server transaction handles replacements within the same store.
  if (!previous || previous.api === target) return link()
  await previous.api.unbindTask(previous.item.id, task)
  if (!current()) return null
  try {
    return await link()
  } catch (cause) {
    if (current()) {
      try {
        // Restore only this user's exact previous link, retaining the task's model and workspace.
        await previous.api.bindTask(previous.item.id, task, title)
      } catch (recoveryCause) {
        throw new TaskOriginRecoveryError([cause, recoveryCause], recoveryFailed)
      }
    }
    throw cause
  }
}
