import type { ReactNode } from 'react'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import { useBrowserCommentExecution } from './useBrowserCommentExecution'
import { BrowserIssueExecutionContext } from './browserIssueExecutionContext'

export function BrowserIssueExecution({
  runtime,
  children,
}: {
  runtime: SharedWorkspaceRuntimeApi
  children: ReactNode
}) {
  const execution = useBrowserCommentExecution(runtime)
  return (
    <BrowserIssueExecutionContext.Provider value={execution}>
      {children}
    </BrowserIssueExecutionContext.Provider>
  )
}
