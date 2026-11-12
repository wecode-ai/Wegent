import { Milestone } from 'lucide-react'

export function IssueCardMilestone({
  itemId,
  title,
  label,
  inline = false,
}: {
  itemId: string
  title: string
  label: string
  inline?: boolean
}) {
  return (
    <span
      data-testid={`cloud-todo-card-milestone-${itemId}`}
      title={`${label}: ${title}`}
      className={`${inline ? "max-w-48" : "mt-2 max-w-full"} flex min-w-0 items-center gap-1.5 text-xs text-text-secondary`}
    >
      <Milestone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">{label}: </span>
      <span className="min-w-0 truncate">{title}</span>
    </span>
  )
}
