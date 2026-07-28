import type { RuntimeWorkListResponse } from '@/types/api'

export function debugRuntimeSidebarState(event: string, details: Record<string, unknown>): void {
  if (globalThis.localStorage?.getItem('wework:debug-runtime') !== '1') return

  console.info('[Wework] Runtime sidebar state', {
    event,
    ...details,
  })
}

export function warnRuntimeSidebarMismatch(details: Record<string, unknown>): void {
  console.warn('[Wework] Runtime sidebar selected task is hidden', details)
}

export function summarizeRuntimeWorkTaskIds(runtimeWork: RuntimeWorkListResponse | null) {
  if (!runtimeWork) return { projects: [], chats: [] }

  return {
    projects: runtimeWork.projects.map(projectWork => ({
      projectId: projectWork.project.id ?? null,
      projectKey: projectWork.project.key ?? null,
      taskIds: projectWork.deviceWorkspaces.flatMap(workspace =>
        workspace.tasks.map(task => task.taskId)
      ),
    })),
    chats: runtimeWork.chats.flatMap(workspace => workspace.tasks.map(task => task.taskId)),
  }
}
