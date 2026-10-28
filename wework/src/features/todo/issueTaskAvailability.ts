import type { StandInExecutorApi } from '@/api/standIn'

interface IssueTaskBindingAddress {
  taskUserId: number
  deviceId: string
  taskId: string
}

export async function requireIssueTaskAvailable<Binding extends IssueTaskBindingAddress>(
  binding: Binding | undefined,
  userId: string | number,
  reader: Pick<StandInExecutorApi, 'readTask'> | undefined,
  translate: (key: string) => string
): Promise<Binding> {
  if (!binding || String(binding.taskUserId) !== String(userId) || !reader) {
    throw new Error(translate('todo.linked_task_unavailable'))
  }
  const result = await reader.readTask(binding.deviceId, binding.taskId)
  if (!result.success) {
    throw new Error(
      result.code === 'task_archived'
        ? translate('todo.linked_task_archived')
        : result.error || translate('todo.linked_task_unavailable')
    )
  }
  return binding
}
