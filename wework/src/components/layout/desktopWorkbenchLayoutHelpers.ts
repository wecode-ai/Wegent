import type { RuntimeTaskAddress } from '@/types/api'

export function getPermanentWorktreeError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String(error.message).trim()
    if (message) return message
  }
  return fallback
}
export function isSameRuntimeTask(
  current: RuntimeTaskAddress | null | undefined,
  next: RuntimeTaskAddress
): boolean {
  if (current?.deviceId !== next.deviceId || current.taskId !== next.taskId) return false
  const resolvedFields = [
    ['runtime', current.runtime, next.runtime],
    ['threadId', current.threadId, next.threadId],
    ['workspacePath', current.workspacePath?.trim(), next.workspacePath?.trim()],
    ['workspaceKind', current.workspaceKind, next.workspaceKind],
    ['worktreeId', current.worktreeId, next.worktreeId],
  ] as const
  if (
    resolvedFields.some(([, currentValue, nextValue]) => nextValue && currentValue !== nextValue)
  ) {
    return false
  }
  if (
    next.projectSession &&
    (current.projectSession?.projectId !== next.projectSession.projectId ||
      current.projectSession?.issueId !== next.projectSession.issueId)
  ) {
    return false
  }
  if (
    next.issueExecution &&
    (current.issueExecution?.projectId !== next.issueExecution.projectId ||
      current.issueExecution?.issueId !== next.issueExecution.issueId)
  ) {
    return false
  }
  return !next.runtimeHandle || current.runtimeHandle === next.runtimeHandle
}
export interface DesktopWorkbenchLayoutProps {
  routeActive?: boolean
  surfaceKind?: 'task' | 'board'
}
export function routePathname(route: string): string {
  const searchIndex = route.indexOf('?')
  return searchIndex >= 0 ? route.slice(0, searchIndex) : route
}
