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
  const { deviceId, taskId } = address
  const session = useMemo(
    () =>
      scope?.get({ deviceId, taskId }) ??
      createRuntimeConversationSession(runtime, { deviceId, taskId }),
    [scope, runtime, deviceId, taskId]
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
