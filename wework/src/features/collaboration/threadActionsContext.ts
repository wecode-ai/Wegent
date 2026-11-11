import { createContext, useContext, type ReactNode } from 'react'
import type { ThreadActionContext } from './threadActions'

interface ThreadActions {
  renderThreadActions(context: ThreadActionContext): ReactNode
  onThreadActionContext(context: ThreadActionContext | null): void
}

export const ThreadActionsContext = createContext<ThreadActions | null>(null)

export function useGroupThreadActions() {
  return useContext(ThreadActionsContext)
}
