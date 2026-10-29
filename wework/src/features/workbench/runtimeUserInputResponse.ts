import { applyRequestUserInputResponseToBlock } from '@wegent/chat-core/runtime-user-input'
import type { RequestUserInputResponse, RuntimeTaskAddress } from '@/types/api'
import type { RuntimeConversationTurn } from '@/types/workbench'
import {
  getRuntimeConversationTurns,
  reconcileRuntimeConversationSnapshot,
} from './runtimeConversationCache'
import { mergeRuntimeConversationTurns } from './runtimeConversationTurns'

/** Capture the transient question; commit only after the runtime accepts its answer. */
export function prepareRuntimeUserInputResponse(
  address: RuntimeTaskAddress,
  response: RequestUserInputResponse
): () => void {
  const answeredTurns = new Map(
    getRuntimeConversationTurns(address).flatMap(turn => {
      if (turn.id === null) return []
      const answeredIds = new Set<string>()
      const items = turn.items.map(item => {
        if (item.type !== 'block') return item
        const block = applyRequestUserInputResponseToBlock(item.block, response)
        if (block === item.block) return item
        answeredIds.add(item.id)
        return { ...item, block }
      })
      return answeredIds.size ? [[turn.id, { turn: { ...turn, items }, answeredIds }] as const] : []
    })
  )

  return () => {
    const turns = getRuntimeConversationTurns(address).map(turn => {
      if (turn.id === null) return turn
      const answered = answeredTurns.get(turn.id)
      if (!answered) return turn
      return restoreAcceptedInputTurn(turn, answered.turn, answered.answeredIds, response)
    })
    reconcileRuntimeConversationSnapshot(address, turns)
  }
}

function restoreAcceptedInputTurn(
  current: RuntimeConversationTurn,
  captured: RuntimeConversationTurn,
  answeredIds: ReadonlySet<string>,
  response: RequestUserInputResponse
): RuntimeConversationTurn {
  const currentById = new Map(current.items.map(item => [item.id, item]))
  const items = captured.items.flatMap<RuntimeConversationTurn['items'][number]>(item => {
    const existing = currentById.get(item.id)
    if (!existing) return answeredIds.has(item.id) ? [item] : []
    if (!answeredIds.has(item.id) || existing.type !== 'block') return [existing]
    return [{ ...existing, block: applyRequestUserInputResponseToBlock(existing.block, response) }]
  })
  return mergeRuntimeConversationTurns([current], [{ ...current, items }])[0]
}
