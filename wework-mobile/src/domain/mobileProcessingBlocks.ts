import { settleWorkbenchProcessingBlock } from '../../../packages/chat-core/src/workbench-message-reducer'
import type { ChatBlockStatus, ChatProcessingBlock, ChatSubagentBlock } from '@/types/runtime'

export function finalizeBlocks(
  blocks: ChatProcessingBlock[] | undefined,
  status: 'done' | 'error'
): ChatProcessingBlock[] | undefined {
  return blocks?.map(block =>
    block.type === 'subagent'
      ? (settleWorkbenchProcessingBlock(block, status) as ChatSubagentBlock)
      : isTerminalBlockStatus(block.status)
        ? block
        : { ...block, status, completedAt: block.completedAt ?? Date.now() }
  )
}

export function normalizeBlockStatus(status?: string): ChatBlockStatus {
  const normalized = status
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  if (normalized === 'generating_arguments') return 'generating_arguments'
  if (normalized === 'streaming') return 'streaming'
  if (['done', 'completed', 'complete', 'success', 'succeeded'].includes(normalized ?? ''))
    return 'done'
  if (['error', 'failed', 'failure'].includes(normalized ?? '')) return 'error'
  return 'pending'
}

export function isActiveStatus(status: ChatBlockStatus): boolean {
  return ['generating_arguments', 'pending', 'streaming'].includes(status)
}

export function isTerminalBlockStatus(status: ChatBlockStatus): boolean {
  return status === 'done' || status === 'error'
}
