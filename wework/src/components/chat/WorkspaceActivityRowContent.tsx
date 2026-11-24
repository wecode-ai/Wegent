import type { ReactNode } from 'react'

export const WORKSPACE_ACTIVITY_ROW_CLASS =
  'flex min-h-11 w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 md:min-h-10'

export function WorkspaceActivityRowContent({
  icon,
  title,
  status,
  detail,
}: {
  icon: ReactNode
  title: string
  status: string
  detail?: string | null
}) {
  return (
    <>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-text-primary" title={title}>
            {title}
          </span>
          <span className="max-w-[52%] shrink-0 text-right text-xs text-text-muted">{status}</span>
        </span>
        {detail && (
          <span className="block truncate text-sm leading-5 text-text-secondary" title={detail}>
            {detail}
          </span>
        )}
      </span>
    </>
  )
}
