import type { WorkbenchMessage } from '../../../packages/chat-core/src/runtime-conversation'
import { normalizeTurnFileChanges } from '../../../packages/chat-core/src/turn-file-changes'
import type { ChatFileChangesSummary, ChatMessage, ChatProcessingBlock } from '@/types/runtime'
import { visibleRuntimeUserMessage } from '../../../packages/chat-core/src/runtime-user-message.js'

/** Native presentation adapts timestamps and file labels, never turn ownership or order. */
export function mobileMessagesFromWorkbench(messages: WorkbenchMessage[]): ChatMessage[] {
  return messages.map(message => {
    const { turnId, subtaskId, ...source } = message
    return {
      ...source,
      role: message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant',
      content:
        message.role === 'user' ? visibleRuntimeUserMessage(message.content) : message.content,
      status: message.status === 'done' ? 'completed' : message.status,
      runtimeStatus: message.runtimeStatus ?? undefined,
      ...(subtaskId != null && { subtaskId: String(subtaskId) }),
      ...(turnId != null && { turnId }),
      stoppedNotice: message.stoppedNotice === true,
      pendingDelivery: message.role === 'user' && message.status === 'pending',
      createdAt: numericTimestamp(message.createdAt),
      completedAt: message.completedAt == null ? undefined : numericTimestamp(message.completedAt),
      blocks: message.blocks?.map(block => ({
        ...block,
        ...(block.type === 'file_changes' && {
          fileChanges: mobileFileChanges(block.fileChanges)!,
        }),
      })) as ChatProcessingBlock[] | undefined,
      fileChanges: mobileFileChanges(message.fileChanges),
    }
  })
}

function mobileFileChanges(value: unknown): ChatFileChangesSummary | undefined {
  const source = normalizeTurnFileChanges(value)
  if (!source) return undefined
  return {
    source,
    fileCount: source.file_count,
    additions: source.additions,
    deletions: source.deletions,
    files: source.files.map(file => ({
      path: file.path,
      oldPath: file.old_path ?? undefined,
      changeType: file.change_type,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
    })),
  }
}

function numericTimestamp(value: string | number | undefined): number {
  if (typeof value === 'number') return value
  const parsed = value ? Date.parse(value) : 0
  return Number.isFinite(parsed) ? parsed : 0
}
