import type { ProjectChatMessage } from '@wegent/chat-core'
import { resolveActivityExecutionTurn } from '@wegent/chat-core/activity-execution-turn'
import type { RuntimeConversationSnapshot } from '@wegent/chat-core/runtime-conversation-session'

/** Legacy identity is valid only after the entire single-run transcript has been verified. */
export function resolveObservedActivityTurn(
  message: ProjectChatMessage | undefined,
  snapshot: RuntimeConversationSnapshot | undefined,
  turnId: string | undefined,
  singleExecution: boolean
) {
  return resolveActivityExecutionTurn(
    message,
    snapshot?.turns ?? [],
    turnId,
    singleExecution &&
      Boolean(
        snapshot &&
        !snapshot.loading &&
        !snapshot.error &&
        !snapshot.hasMoreBefore &&
        snapshot.loadedTranscriptRanges.some(range => range.start === 0)
      )
  )
}
