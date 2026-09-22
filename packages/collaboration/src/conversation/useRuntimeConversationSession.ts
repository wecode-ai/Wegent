import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import type { RuntimeConversationClient } from '@wegent/chat-core'
import { createRuntimeConversationSession } from '@wegent/chat-core/runtime-conversation-session'
import { useRuntimeConversationScope } from './runtimeConversationScopeContext'

export function useRuntimeConversationSession(
  runtime: RuntimeConversationClient,
  address: RuntimeTaskAddress
) {
  const context = useRuntimeConversationScope()
  const scope = context?.runtime === runtime ? context : null
  const { deviceId, taskId, projectSession } = address
  const projectId = projectSession?.projectId
  const issueId = projectSession?.issueId
  const session = useMemo(
    () =>
      scope?.get({
        deviceId,
        taskId,
        ...(projectId && issueId ? { projectSession: { projectId, issueId } } : {}),
      }) ??
      createRuntimeConversationSession(runtime, {
        deviceId,
        taskId,
        ...(projectId && issueId ? { projectSession: { projectId, issueId } } : {}),
      }),
    [scope, runtime, deviceId, taskId, projectId, issueId]
  )
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  useEffect(() => {
    if (scope) {
      scope.activate(session)
      return
    }
    session.start()
    return session.stop
  }, [scope, session])
  return { session, state }
}
