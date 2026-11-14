import {
  nestWorkbenchProcessingBlocks,
  projectWorkbenchSubagentActivity,
  type WorkbenchProcessingBlock,
} from '../../../packages/chat-core/src/workbench-message-reducer'
import type { ChatMessage, ChatSubagentBlock } from '@/types/runtime'

export function mobileSubagentId(block: ChatSubagentBlock): string {
  return block.agentThreadId ?? block.agentId ?? block.id
}

/** Match DesktopWorkbenchMain's overview: latest block per child identity, including descendants. */
export function collectMobileSubagents(messages: ChatMessage[]): ChatSubagentBlock[] {
  const conversations = new Map<string, ChatSubagentBlock>()
  const collect = (blocks: WorkbenchProcessingBlock<unknown>[]) => {
    for (const block of blocks) {
      if (block.type !== 'subagent') continue
      // Projected children preserve their runtime file-change contract.
      const agent = block as ChatSubagentBlock
      conversations.set(mobileSubagentId(agent), agent)
      collect(block.children ?? [])
    }
  }
  for (const message of messages) {
    const blocks = (message.blocks ?? []).flatMap<WorkbenchProcessingBlock<unknown>>(block => {
      if (block.type === 'thinking' || block.type === 'text' || block.type === 'plan')
        return [{ ...block, type: block.type }]
      if (block.type === 'tool' || block.type === 'file_changes' || block.type === 'subagent')
        return [block]
      return []
    })
    collect(nestWorkbenchProcessingBlocks(projectWorkbenchSubagentActivity(blocks)))
  }
  return [...conversations.values()]
}

export function mobileSubagentActive(block: ChatSubagentBlock): boolean {
  return block.status !== 'done' && block.status !== 'error'
}
