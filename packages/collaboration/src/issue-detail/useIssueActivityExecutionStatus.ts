import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ProjectChatMessage } from '@wegent/chat-core'
import {
  activityExecutionDisplayStatus,
  resolveActivityExecutionTurn,
} from '@wegent/chat-core/activity-execution-turn'
import { useRuntimeConversationScope } from '../conversation/runtimeConversationScopeContext'
import type { RuntimeConversationSnapshot } from '@wegent/chat-core/runtime-conversation-session'

const subscribeEmpty = () => () => {}
const getEmpty = () => undefined

/** Observe the same conversation as the viewer without loading every historical run. */
export function useIssueActivityExecutionStatus(
  message: ProjectChatMessage | undefined,
  singleExecution = false,
  viewerSnapshot?: RuntimeConversationSnapshot
) {
  const scope = useRuntimeConversationScope()
  const session = message?.runtimeAddress ? scope?.get(message.runtimeAddress) : undefined
  const cached = useSyncExternalStore(
    session?.subscribe ?? subscribeEmpty,
    session?.getSnapshot ?? getEmpty,
    session?.getSnapshot ?? getEmpty
  )
  const snapshot = viewerSnapshot ?? cached
  const key = JSON.stringify([
    message?.runtimeAddress?.deviceId,
    message?.runtimeAddress?.taskId,
    message?.messageId,
  ])
  const [binding, setBinding] = useState<{
    key: string
    turnId: string
  } | null>(null)
  const turns = snapshot?.turns ?? []
  const turn = resolveActivityExecutionTurn(
    message,
    turns,
    scope ? scope.getActivityTurnId(key) : binding?.key === key ? binding.turnId : undefined,
    singleExecution &&
      Boolean(
        snapshot &&
        !snapshot.loading &&
        !snapshot.error &&
        !snapshot.hasMoreBefore &&
        snapshot.loadedTranscriptRanges.some(range => range.start === 0)
      )
  )
  if (turn?.id && (binding?.key !== key || binding.turnId !== turn.id)) {
    setBinding({ key, turnId: turn.id })
  }
  useEffect(() => {
    if (turn?.id) {
      scope?.identifyActivityTurn(key, turn.id)
    }
  }, [scope, key, turn?.id])
  return {
    turn,
    status: activityExecutionDisplayStatus(message, turns, turn, snapshot?.running === false),
  }
}
