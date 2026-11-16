import { createContext, useContext } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'

export const NotificationEntityContext = createContext<{
  id: string
  projectId: string
  issueId: string
  store: 'local' | 'backend'
  rootCommentId?: string
  address?: RuntimeTaskAddress
  sourceMessageIds?: string[]
  onFocusedMessage?: (messageId: string) => void
} | null>(null)

export function useNotificationEntity() {
  return useContext(NotificationEntityContext)
}
