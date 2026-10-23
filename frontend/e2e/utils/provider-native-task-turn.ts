type TaskRecord = Record<string, unknown>

function isRecord(value: unknown): value is TaskRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function completed(status: unknown): boolean {
  return typeof status === 'string' && status.toUpperCase().startsWith('COMPLETED')
}

export function hasCompletedProviderNativeTurn(task: unknown, prompt: string): boolean {
  if (!isRecord(task) || !completed(task.status) || !Array.isArray(task.subtasks)) return false
  const subtasks = task.subtasks.filter(isRecord)
  const user = [...subtasks]
    .reverse()
    .find(subtask => subtask.role === 'USER' && subtask.prompt === prompt)
  if (!user || !Number.isSafeInteger(user.message_id) || Number(user.message_id) <= 0) return false
  return subtasks.some(
    subtask =>
      subtask.role === 'ASSISTANT' &&
      subtask.parent_id === user.message_id &&
      completed(subtask.status)
  )
}
