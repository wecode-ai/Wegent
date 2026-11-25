import type { ReactNode } from 'react'

export function IssueListTitle({
  title,
  issueId,
  reference,
  fullReference,
  leading,
}: {
  title: string
  issueId: string
  reference?: string
  fullReference?: string
  leading?: ReactNode
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {leading}
      <span
        data-testid={`cloud-todo-card-title-${issueId}`}
        className="collaboration-issue-title line-clamp-2 min-w-0 break-words whitespace-normal text-base font-medium leading-5 text-text-primary"
      >
        {title}
      </span>
      {reference ? (
        <span
          data-testid={`cloud-todo-card-reference-${issueId}`}
          className="collaboration-issue-key max-w-[50%] min-w-0 shrink-0 truncate text-sm text-text-secondary"
          title={fullReference}
        >
          {reference}
        </span>
      ) : null}
    </span>
  )
}
