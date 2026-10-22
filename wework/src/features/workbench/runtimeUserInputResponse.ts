import {
  applyRequestUserInputResponseToBlock,
  isAnsweredRequestUserInputBlock,
} from '@wegent/chat-core/runtime-user-input'
import type { RequestUserInputResponse, RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  getRuntimeConversationTurns,
  reconcileRuntimeConversationSnapshot,
} from './runtimeConversationCache'
import { mergeRuntimeConversationTurns } from './runtimeConversationTurns'

/** Capture transient questions before sending; commit only after the executor accepts. */
export function prepareRuntimeUserInputResponse(
  address: RuntimeTaskAddress,
  response: RequestUserInputResponse
): () => WorkbenchMessage[] {
  const answeredTurns = new Map(
    getRuntimeConversationTurns(address).flatMap(turn => {
      let answered = false
      const items = turn.items.map(item => {
        if (item.type !== 'block') return item
        const block = applyRequestUserInputResponseToBlock(item.block, response)
        if (block === item.block) return item
        answered = true
        return { ...item, block }
      })
      return answered ? [[turn.id, { ...turn, items }] as const] : []
    })
  )
  return () => {
    // Completion history may omit the question before the send acknowledgement arrives.
    const turns = getRuntimeConversationTurns(address).map(turn => {
      const answeredTurn = answeredTurns.get(turn.id)
      if (!answeredTurn) return turn
      const currentItemIds = new Set(turn.items.map(item => item.id))
      const merged = mergeRuntimeConversationTurns([answeredTurn], [turn])[0]
      return {
        ...merged,
        items: merged.items.filter(
          item =>
            currentItemIds.has(item.id) ||
            (item.type === 'block' && isAnsweredRequestUserInputBlock(item.block))
        ),
      }
    })
    return reconcileRuntimeConversationSnapshot(address, turns)
  }
}
