import { allWorkspaces } from '@/domain/work'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/runtime'
import type { RuntimeApi } from './runtimeApi'

/** Match PC archiveRuntimeConversations: archive first, then preserve the worktree snapshot. */
export async function archiveMobileConversation(
  api: Pick<RuntimeApi, 'archiveConversation' | 'deleteWorktree'>,
  work: RuntimeWorkListResponse,
  address: RuntimeTaskAddress
): Promise<{ cleanupError: string | null }> {
  const target = archivedWorktree(work, address)
  const result = await api.archiveConversation(address)
  if (!result.accepted) throw new Error(result.error || '归档失败')
  if (!target) return { cleanupError: null }
  try {
    const cleanup = await api.deleteWorktree({ ...target, preserveSnapshot: true })
    if (!cleanup.success) throw new Error(cleanup.worktree.lastError || '工作树清理失败')
    return { cleanupError: null }
  } catch (cause) {
    return {
      cleanupError: `会话已归档，但工作树清理失败：${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}

function archivedWorktree(work: RuntimeWorkListResponse, address: RuntimeTaskAddress) {
  for (const workspace of allWorkspaces(work)) {
    if (workspace.deviceId !== address.deviceId) continue
    const task = workspace.tasks.find(item => item.taskId === address.taskId)
    if (
      !task ||
      !(
        workspace.workspaceKind === 'worktree' ||
        workspace.worktreeId ||
        task.workspaceKind === 'worktree' ||
        task.worktreeId
      )
    )
      continue
    const path = task.workspacePath?.trim() || workspace.workspacePath.trim()
    if (!path || (address.workspacePath?.trim() && path !== address.workspacePath.trim())) continue
    return { deviceId: workspace.deviceId, path }
  }
  return null
}
