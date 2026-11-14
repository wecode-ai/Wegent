import type {
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/runtime'

export function conversationPinTarget(work: RuntimeWorkListResponse, address: RuntimeTaskAddress) {
  const groups = [
    ...work.projects.map(group => ({
      deviceId: group.project.stateDeviceId,
      workspaces: group.deviceWorkspaces,
    })),
    { deviceId: null, workspaces: work.chats },
  ]
  for (const group of groups) {
    for (const workspace of group.workspaces) {
      if (workspace.deviceId !== address.deviceId) continue
      const task = workspace.tasks.find(item => item.taskId === address.taskId)
      if (!task) continue
      const threadId = runtimeTaskThreadId(task)
      return threadId
        ? { deviceId: group.deviceId || workspace.deviceId, threadId, pinned: task.pinned === true }
        : null
    }
  }
  return null
}

// Match PC workbenchRuntimeHelpers.getRuntimeTaskThreadId, including pending tasks.
function runtimeTaskThreadId(task: RuntimeTaskSummary): string | null {
  const explicit = task.threadId?.trim()
  if (explicit) return explicit
  const handle = [task.runtimeHandle?.threadId, task.runtimeHandle?.thread_id].find(
    value => typeof value === 'string' && value.trim()
  )
  if (typeof handle === 'string') return handle.trim()
  return task.runtime === 'codex' && !task.optimistic ? task.taskId.trim() || null : null
}
