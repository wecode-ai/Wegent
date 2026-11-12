import type { ProcessingBlock, RuntimeConversationTurn, WorkbenchMessage } from '@/types/workbench'
import { projectRuntimeConversationTurns } from '@wegent/chat-core/runtime-conversation-turns'
import { isRequestUserInputBlock } from '@wegent/chat-core/runtime-user-input'

function keepOutcomeBlock(block: ProcessingBlock): boolean {
  if (isRequestUserInputBlock(block)) return true
  if (block.type !== 'tool' || block.status !== 'done') return false
  const payload = block.renderPayload
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    'kind' in payload &&
    payload.kind === 'image_generation'
  )
}

function outcomeReplies(
  message: WorkbenchMessage,
  timestamps: ReadonlyMap<string, string>
): WorkbenchMessage[] {
  if (message.role !== 'assistant') return [message]
  const blocks = message.blocks?.filter(keepOutcomeBlock) ?? []
  const blocksById = new Map(blocks.map(block => [block.id, block]))
  const items = message.runtimeDisplayItems?.filter(item =>
    item.type === 'block' ? blocksById.has(item.id) : Boolean(item.content.trim())
  )
  const clean = {
    ...message,
    blocks,
    runtimeDisplayItems: items,
    streamingThinkingContent: undefined,
  }
  const text = message.runtimeDisplayItems?.flatMap(item =>
    item.type === 'assistant_text' ? [item.content] : []
  )
  if (!items?.length || !text?.length || text.join('\n\n') !== message.content) return [clean]
  return items.map((item, index) => ({
    ...clean,
    id: `runtime-outcome:${message.turnId ?? message.id}:${item.id}`,
    content: item.type === 'assistant_text' ? item.content : '',
    blocks: item.type === 'block' ? [blocksById.get(item.id)!] : [],
    runtimeDisplayItems: [item],
    createdAt: timestamps.get(item.id) ?? message.createdAt,
    ...(index < items.length - 1
      ? {
          status: 'done' as const,
          runtimeStatus: 'done' as const,
          error: undefined,
          errorType: undefined,
          stoppedNotice: undefined,
          fileChanges: undefined,
          references: undefined,
          memoryCitations: undefined,
        }
      : {}),
  }))
}

/** Change only the view: native history, approvals and input coordination stay intact. */
export function conversationOutcomePresentation(
  messages: WorkbenchMessage[],
  turns: RuntimeConversationTurn[]
) {
  const visibleTurns = turns.map(turn => {
    let hasReplySinceUser = false
    return {
      ...turn,
      streamingThinkingContent: undefined,
      items: turn.items
        .filter(item => {
          if (item.type === 'user_message') {
            hasReplySinceUser = false
            return true
          }
          if (item.type === 'assistant_text') {
            if (item.content.trim()) hasReplySinceUser = true
            return true
          }
          if (keepOutcomeBlock(item.block)) return true
          // Each user boundary owns its acknowledgement, even after dispatching tools.
          if (item.block.type !== 'text' || !item.block.content.trim() || hasReplySinceUser)
            return false
          hasReplySinceUser = true
          return true
        })
        .map(item =>
          item.type === 'block' && item.block.type === 'text'
            ? {
                id: item.id,
                type: 'assistant_text' as const,
                content: item.block.content,
                createdAt: new Date(item.block.createdAt).toISOString(),
              }
            : item
        ),
    }
  })
  const projectedMessages = turns.length ? projectRuntimeConversationTurns(visibleTurns) : messages
  const timestamps = new Map(
    visibleTurns.flatMap(turn =>
      turn.items.flatMap(item =>
        item.type === 'assistant_text' ? [[item.id, item.createdAt] as const] : []
      )
    )
  )
  // Native projection synthesizes guidance blocks, so apply the outcome view afterward.
  const visibleMessages = projectedMessages.flatMap(message => outcomeReplies(message, timestamps))
  return { messages: visibleMessages, turns: visibleTurns }
}
