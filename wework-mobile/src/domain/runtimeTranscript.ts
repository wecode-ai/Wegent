import { projectRuntimePaneTranscript } from '../../../packages/chat-core/src/runtime-transcript-page'
import type { RuntimeTranscriptResponse as CoreTranscript } from '../../../packages/chat-core/src/runtime'
import type { RuntimeTranscriptResponse } from '@/types/runtime'
import { projectRuntimeConversationTurns } from '../../../packages/chat-core/src/runtime-turns'
import type { RuntimeConversationTurn } from '../../../packages/chat-core/src/runtime-conversation'
import { commandExecutionPayload } from '../../../packages/chat-core/src/command-execution'
import {
  isTerminalProcessingBlockStatus,
  isTerminalTurnStatus,
} from '../../../packages/chat-core/src/runtime-turn-merge'
import {
  isCommandToolName,
  isNodeReplToolName,
} from '../../../packages/collaboration/src/conversation/blocks/toolBlockKinds'

/** Use the PC cloud-device projection before adapting native presentation. */
export function projectMobileRuntimeTranscript(
  response: CoreTranscript & { taskId: string }
): RuntimeTranscriptResponse {
  if (!Array.isArray(response.turns)) {
    throw new Error('Runtime transcript response is missing canonical turns')
  }
  const page = projectRuntimePaneTranscript(response)
  return {
    ...response,
    turns: page.turns,
    supersededTurnIds: page.supersededTurnIds,
    messages: projectRuntimeConversationTurns(page.turns).map(message => ({
      ...message,
      blocks: message.blocks?.map(block => ({ ...block })),
      runtimeItems: message.runtimeDisplayItems?.filter(item => item.type === 'assistant_text'),
    })),
  }
}

/** Latest history includes both native items and executor overlays for still-running commands. */
export function reconcileCachedRuntimeCommands(
  beforeRead: RuntimeConversationTurn[],
  snapshot: RuntimeConversationTurn[],
  hydrated: RuntimeConversationTurn[],
  hasEarlierPage: boolean
): RuntimeConversationTurn[] {
  if (!beforeRead.length) return hydrated
  const byId = new Map(beforeRead.map(turn => [turn.id, turn]))
  const settled = new Map<string, RuntimeConversationTurn>()
  // Backwards pagination can cut through the first native turn. Overlays
  // without positioned items do not establish that a turn was read in full.
  let passedPageBoundary = !hasEarlierPage
  for (const turn of snapshot) {
    if (!turn.id || turn.itemMerge) continue
    const hasNativeItems = turn.items.some(item => item.position !== undefined)
    if (
      passedPageBoundary &&
      (!hasEarlierPage || hasNativeItems) &&
      isTerminalTurnStatus(turn.status)
    ) {
      settled.set(turn.id, turn)
    }
    if (hasNativeItems) passedPageBoundary = true
  }
  return hydrated.map(turn => {
    const authority = turn.id ? settled.get(turn.id) : undefined
    const cached = byId.get(turn.id)
    if (!authority || !cached) return turn
    const persistedIds = new Set(authority.items.map(item => item.id))
    const staleBlocks = new Set(
      cached.items.flatMap(item => {
        if (item.type !== 'block' || item.block.type !== 'tool' || persistedIds.has(item.id))
          return []
        const { status, toolName } = item.block
        if (isTerminalProcessingBlockStatus(status)) return []
        return commandExecutionPayload(item.block) ||
          isCommandToolName(toolName) ||
          isNodeReplToolName(toolName)
          ? [item.block]
          : []
      })
    )
    if (!staleBlocks.size) return turn
    // A block created or updated during this read does not have the old reference.
    const items = turn.items.filter(
      item => item.type !== 'block' || item.block.type !== 'tool' || !staleBlocks.has(item.block)
    )
    return items.length === turn.items.length ? turn : { ...turn, items }
  })
}
