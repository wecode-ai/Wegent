import { useState, type ReactNode } from 'react'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { IndependentIssuesContext } from './independentIssuesContext'
import { IndependentIssueDialog } from './IndependentIssueDialog'

export function IndependentIssuesProvider({
  api,
  userId,
  selection,
  onSelect,
  onLogin,
  onOpenProjectIssue,
  children,
}: {
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
        userId,
        revision,
        create: () => (api ? onSelect(null) : onLogin()),
        open: onSelect,
      }}
    >
      {children}
      {api && selection !== undefined ? (
        <IndependentIssueDialog
          key={selection ?? 'new'}
          api={api}
          userId={userId}
          issueId={selection}
          onClose={() => onSelect(undefined)}
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
