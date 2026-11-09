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

/** Change only the view: native history, approvals and input coordination stay intact. */
export function conversationOutcomePresentation(
  messages: WorkbenchMessage[],
  turns: RuntimeConversationTurn[]
) {
  const visibleTurns = turns.map(turn => ({
    ...turn,
    streamingThinkingContent: undefined,
    items: turn.items
      .filter((item, index) => {
        if (item.type !== 'block') return true
        if (keepOutcomeBlock(item.block)) return true
        // Keep the opening acknowledgement, not the later execution commentary.
        return (
          item.block.type === 'text' &&
          !turn.items
            .slice(0, index)
            .some(
              previous =>
                previous.type === 'assistant_text' ||
                (previous.type === 'block' && previous.block.type !== 'thinking')
            )
        )
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
  }))
  const visibleMessages = turns.length
    ? projectRuntimeConversationTurns(visibleTurns)
    : messages.map(message => ({
        ...message,
        blocks: message.blocks?.filter(keepOutcomeBlock),
        runtimeDisplayItems: message.runtimeDisplayItems?.filter(
          item =>
            item.type !== 'block' ||
            message.blocks?.some(block => block.id === item.id && keepOutcomeBlock(block))
        ),
        streamingThinkingContent: undefined,
      }))
  return { messages: visibleMessages, turns: visibleTurns }
}
