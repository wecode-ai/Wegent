import { useState, type ReactNode } from 'react'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { IndependentIssuesContext } from './independentIssuesContext'
import { IndependentIssueDialog } from './IndependentIssueDialog'

export function IndependentIssuesProvider({
  api,
  collaborationApi,
  userId,
  selection,
  onSelect,
  onLogin,
  onOpenProjectIssue,
  children,
}: {
  collaborationApi?: SharedWorkspaceApi
  api: PersonalIssuesApi | null
  userId: number
  selection: string | null | undefined
  onSelect(selection: string | null | undefined): void
  onLogin(): void
  onOpenProjectIssue?(projectId: string, issueId: string): void
  children: ReactNode
}) {
  const [revision, setRevision] = useState(0)
  return (
    <IndependentIssuesContext.Provider
      value={{
        api,
        collaborationApi,
        userId,
        revision,
        create: () => (api ? onSelect(null) : onLogin()),
      }}
    >
      {children}
      {api && selection !== undefined ? (
        <IndependentIssueDialog
          key={selection ?? 'new'}
          api={api}
          collaborationApi={collaborationApi}
          userId={userId}
          issueId={selection}
          onClose={() => onSelect(undefined)}
          onOpenChildTask={issue => onSelect(issue.id)}
          onSaved={issue => {
            setRevision(value => value + 1)
            onSelect(issue?.id)
          }}
          onOpenProjectIssue={onOpenProjectIssue}
        />
      ) : null}
    </IndependentIssuesContext.Provider>
  )
}
