import { createContext, useContext, type ReactNode } from 'react'
import type { ProjectChatMessage } from '@wegent/chat-core'
import type { ThreadActionContext } from './threadActions'

interface ThreadActions {
  openExecution?(context: ThreadActionContext, message: ProjectChatMessage): Promise<void>
  renderThreadActions(context: ThreadActionContext): ReactNode
  onThreadActionContext(context: ThreadActionContext | null): void
}

export const ThreadActionsContext = createContext<ThreadActions | null>(null)

export function useGroupThreadActions() {
  return useContext(ThreadActionsContext)
}
