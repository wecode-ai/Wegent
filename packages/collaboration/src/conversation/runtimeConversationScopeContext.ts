import { createContext, useContext } from 'react'
import type { RuntimeConversationClient } from '@wegent/chat-core'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import { createRuntimeConversationSession } from '@wegent/chat-core/runtime-conversation-session'
type Session = ReturnType<typeof createRuntimeConversationSession>

export function createScope(runtime: RuntimeConversationClient) {
  const sessions = new Map<string, Session>()
  const active = new Set<Session>()
  const activityTurnIds = new Map<string, string>()
  return {
    runtime,
    getActivityTurnId: (key: string) => activityTurnIds.get(key),
    identifyActivityTurn: (key: string, turnId: string) => activityTurnIds.set(key, turnId),
    get(address: RuntimeTaskAddress) {
      const key = JSON.stringify([address.deviceId, address.taskId, address.projectSession ?? null])
      let session = sessions.get(key)
      if (!session) {
        session = createRuntimeConversationSession(runtime, address)
        sessions.set(key, session)
      }
      return session
    },
    activate(session: Session) {
      if (active.has(session)) {
        void session.reload()
        return
      }
      active.add(session)
      session.start()
    },
    start() {
      active.forEach(session => session.start())
    },
    stop() {
      active.forEach(session => session.stop())
    },
  }
}

export const RuntimeConversationScopeContext = createContext<ReturnType<typeof createScope> | null>(
  null
)

export function useRuntimeConversationScope() {
  return useContext(RuntimeConversationScopeContext)
}
