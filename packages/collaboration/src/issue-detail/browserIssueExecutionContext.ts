import { createContext, useContext } from 'react'
import type { useBrowserCommentExecution } from './useBrowserCommentExecution'

export const BrowserIssueExecutionContext = createContext<ReturnType<
  typeof useBrowserCommentExecution
> | null>(null)
export function useBrowserIssueExecution() {
  const execution = useContext(BrowserIssueExecutionContext)
  if (!execution) throw new Error('BrowserIssueExecution is required')
  return execution
}
