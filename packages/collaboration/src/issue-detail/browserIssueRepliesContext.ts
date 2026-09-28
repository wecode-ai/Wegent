import { createContext, useContext } from 'react'
import type { useTaskReplyQueue } from '../execution/useTaskReplyQueue'

type ReplyQueue = ReturnType<typeof useTaskReplyQueue>
export const BrowserIssueRepliesContext = createContext<{
  queue: ReplyQueue
  error: string | null
  retry(): void
} | null>(null)
export const useBrowserIssueReplies = () => useContext(BrowserIssueRepliesContext)
