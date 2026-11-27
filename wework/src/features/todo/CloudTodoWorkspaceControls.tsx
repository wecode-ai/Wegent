import { type ReactNode } from 'react'
import { Bot, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { columnDotClasses, columns } from './todoShared'
export function IssueResourceSection({
  icon,
  title,
  count,
  empty,
  children,
}: {
  icon: ReactNode
  title: string
  count: number
  empty: string
  children: ReactNode
}) {
  return (
    <section className="task-conversation-resource-section">
      <header className="task-conversation-resource-heading">
        <span className="text-text-muted">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="task-conversation-resource-count">{count}</span>
      </header>
      {count > 0 ? (
        <div className="space-y-0.5 px-2 pb-2">{children}</div>
      ) : (
        <p className="px-4 pb-3 text-xs text-text-muted">{empty}</p>
      )}
    </section>
  )
}
export function CloudTodoBoardSkeleton() {
  return (
    <div
      data-testid="cloud-todo-board-loading"
      aria-busy="true"
      className="flex h-full min-h-0 items-start gap-3.5 px-6"
    >
      {columns.map((column, columnIndex) => (
        <section
          key={column.status}
          className="flex max-h-full w-[292px] shrink-0 flex-col rounded-2xl bg-muted p-0.5"
        >
          <header className="flex items-center px-2.5 pb-2 pt-1.5">
            <span className={cn('mr-2 h-2 w-2 rounded-full', columnDotClasses[column.status])} />
            <span className="text-sm font-semibold">{column.label}</span>
          </header>
          <div className="animate-pulse space-y-2 px-2 pb-2 pt-2">
            {Array.from({ length: columnIndex % 2 === 0 ? 2 : 1 }, (_, cardIndex) => (
              <div
                key={cardIndex}
                className="rounded-xl border border-border bg-background px-3 py-3 shadow-sm"
              >
                <div className="h-3 w-24 rounded-md bg-text-primary/10" />
                <div className="mt-2.5 h-4 w-4/5 rounded-md bg-text-primary/10" />
                <div className="mt-2.5 flex items-center gap-2">
                  <div className="h-4 w-12 rounded-full bg-text-primary/10" />
                  <div className="ml-auto h-3 w-9 rounded-md bg-text-primary/10" />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
export function CloudTodoStartupAnimation({ label }: { label: string }) {
  return (
    <div
      data-testid="cloud-todo-startup-animation"
      aria-busy="true"
      aria-label={label}
      className="flex h-full min-h-0 items-center justify-center"
    >
      <div className="flex flex-col items-center gap-3 text-text-secondary">
        <div className="relative flex h-12 w-12 items-center justify-center">
          <div className="absolute inset-0 rounded-full border border-border" />
          <LoaderCircle className="h-12 w-12 animate-spin text-text-primary" strokeWidth={1.25} />
          <Bot className="absolute h-5 w-5 text-text-primary" />
        </div>
        <span className="text-sm">{label}</span>
      </div>
    </div>
  )
}
