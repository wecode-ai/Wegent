import { createContext, useContext } from 'react'
import type { ProjectChatMessage, RuntimeConversationClient } from '@wegent/chat-core'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import { resolveObservedActivityTurn } from './activityExecutionObservation'
import type { RuntimeConversationSnapshot } from '@wegent/chat-core/runtime-conversation-session'
import { createRuntimeConversationSession } from '@wegent/chat-core/runtime-conversation-session'
type Session = ReturnType<typeof createRuntimeConversationSession>

export function createScope(runtime: RuntimeConversationClient) {
  const sessions = new Map<string, Session>()
  const active = new Set<Session>()
  const activityTurnIds = new Map<string, string>()
  const observers = new Set<object>()
  const scope = {
    runtime,
    getActivityTurnId: (key: string) => activityTurnIds.get(key),
    observeActivity(key: string, message: ProjectChatMessage, singleExecution: boolean) {
      if (!message.runtimeAddress) return undefined
      const session = scope.get(message.runtimeAddress)
      const remember = (snapshot: RuntimeConversationSnapshot) => {
        const turn = resolveObservedActivityTurn(
          message,
          snapshot,
          activityTurnIds.get(key),
          singleExecution
        )
        if (turn?.id) activityTurnIds.set(key, turn.id)
      }
      return {
        getSnapshot: session.getSnapshot,
        subscribe(listener: () => void) {
          const stop = scope.observeSession(session, () => {
            remember(session.getSnapshot())
            listener()
          })
          remember(session.getSnapshot())
          return stop
        },
      }
    },
    get(address: RuntimeTaskAddress): Session {
      const key = JSON.stringify([
        address.deviceId,
        address.taskId,
        address.projectSession?.projectId ?? null,
        address.projectSession?.issueId ?? null,
      ])
      let session = sessions.get(key)
      if (!session) {
        session = createRuntimeConversationSession(runtime, address)
        sessions.set(key, session)
      }
      return session
    },
    observeSession(session: Session, listener: () => void, open = false) {
      const token = {}
      const firstObserver = !observers.size
      const previouslyActive = active.has(session)
      const stop = session.subscribe(listener)
      observers.add(token)
      if (firstObserver) active.forEach(visited => visited.start())
      if (open) {
        active.add(session)
        if (previouslyActive && !firstObserver) void session.reload()
        else session.start()
      }
      return () => {
        stop()
        observers.delete(token)
        if (observers.size) return
        // A commit may replace the last reader or replay subscriptions in StrictMode.
        // Dispose after that subscription transaction, without reconnecting live sessions.
        queueMicrotask(() => {
          if (!observers.size) active.forEach(visited => visited.stop())
        })
      }
    },
  }
  return scope
}

export const RuntimeConversationScopeContext = createContext<ReturnType<typeof createScope> | null>(
  null
)

export function useRuntimeConversationScope() {
  return useContext(RuntimeConversationScopeContext)
}
