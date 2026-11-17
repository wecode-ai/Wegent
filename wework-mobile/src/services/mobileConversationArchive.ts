import type { RuntimeTaskAddress } from '@/types/runtime'
import type { RuntimeApi } from './runtimeApi'

/** PC and Mobile use task-bound archive cleanup; direct worktree deletion stays privileged. */
export async function archiveMobileConversation(
  api: Pick<RuntimeApi, 'archiveConversation'>,
  address: RuntimeTaskAddress
): Promise<{ cleanupError: string | null }> {
  const result = await api.archiveConversation({ ...address, cleanupWorktree: true })
  if (!result.accepted) throw new Error(result.error || '归档失败')
  return {
    cleanupError: result.cleanupError
      ? `会话已归档，但工作树清理失败：${result.cleanupError}`
      : null,
  }
}
