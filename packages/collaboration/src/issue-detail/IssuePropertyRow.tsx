import type { ReactNode } from 'react'

function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export function IssuePropertyRow({
  label,
  children,
  control,
  testId,
  clickable = Boolean(control),
  valueClassName,
  wrapValue = false,
}: {
  label: string
  children: ReactNode
  control?: ReactNode
  testId?: string
  clickable?: boolean
  valueClassName?: string
  wrapValue?: boolean
}) {
  return (
    <span
      data-testid={testId}
      className="task-detail-rail-prop relative flex min-w-0 items-center gap-2"
    >
      <span className="task-detail-rail-key w-[64px] shrink-0 text-xs font-medium leading-5 text-text-muted">
        {label}
      </span>
      <span
        className={cn(
          'task-detail-rail-value flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium leading-5 text-text-primary',
          wrapValue ? 'overflow-visible' : 'truncate',
          clickable && 'group relative',
          valueClassName
        )}
      >
        {clickable ? (
          <span className="pointer-events-none absolute -inset-x-1.5 -inset-y-[3px] rounded-md transition group-hover:bg-muted" />
        ) : null}
        <span
          className={cn(
            'task-detail-rail-value-content relative flex min-w-0 items-center gap-1.5',
            wrapValue ? 'w-full overflow-visible' : 'truncate'
          )}
        >
          {children}
        </span>
        {control}
      </span>
    </span>
  )
}
