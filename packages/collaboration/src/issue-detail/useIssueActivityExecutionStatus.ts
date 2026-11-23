import { useMemo, useState, useSyncExternalStore } from 'react'
import type { ProjectChatMessage } from '@wegent/chat-core'
import { activityExecutionDisplayStatus } from '@wegent/chat-core/activity-execution-turn'
import { useRuntimeConversationScope } from '../conversation/runtimeConversationScopeContext'
import type { RuntimeConversationSnapshot } from '@wegent/chat-core/runtime-conversation-session'
import { resolveObservedActivityTurn } from '../conversation/activityExecutionObservation'
import { reconcileExecutionStatus } from './executionStatus'

const subscribeEmpty = () => () => {}
const getEmpty = () => undefined

/** Observe the same conversation as the viewer without loading every historical run. */
export function useIssueActivityExecutionStatus(
  message: ProjectChatMessage | undefined,
  singleExecution = false,
  viewerSnapshot?: RuntimeConversationSnapshot,
  persistedStatus?: string | null
) {
  const scope = useRuntimeConversationScope()
  const key = JSON.stringify([
    message?.runtimeAddress?.deviceId,
    message?.runtimeAddress?.taskId,
    message?.runtimeAddress?.projectSession?.projectId,
    message?.runtimeAddress?.projectSession?.issueId,
    message?.messageId,
  ])
  const observation = useMemo(
    () =>
      scope && message?.runtimeAddress
        ? scope.observeActivity(key, message, singleExecution)
        : undefined,
    [scope, key, message, singleExecution]
  )
  const cached = useSyncExternalStore(
    observation?.subscribe ?? subscribeEmpty,
    observation?.getSnapshot ?? getEmpty,
    observation?.getSnapshot ?? getEmpty
  )
  const snapshot = viewerSnapshot ?? cached
  const [binding, setBinding] = useState<{
    key: string
    turnId: string
  } | null>(null)
  const turns = snapshot?.turns ?? []
  const turn = resolveObservedActivityTurn(
    message,
    snapshot,
    scope ? scope.getActivityTurnId(key) : binding?.key === key ? binding.turnId : undefined,
    singleExecution
  )
  if (!scope && turn?.id && (binding?.key !== key || binding.turnId !== turn.id)) {
    setBinding({ key, turnId: turn.id })
  }
  const observedStatus = activityExecutionDisplayStatus(
    message,
    turns,
    turn,
    snapshot?.running === false
  )
  return {
    turn,
    status: reconcileExecutionStatus(persistedStatus, observedStatus),
  }
}
