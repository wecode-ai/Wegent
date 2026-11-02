import { createContext, useContext } from 'react'

export const NotificationEntityContext = createContext<{
  id: string
  projectId: string
  issueId: string
  store: 'local' | 'backend'
  rootCommentId?: string
} | null>(null)

export function useNotificationEntity() {
  return useContext(NotificationEntityContext)
}
