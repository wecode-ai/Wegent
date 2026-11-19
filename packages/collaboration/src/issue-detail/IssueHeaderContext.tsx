import { useIntersectionEvent } from '../dom-events'
import { useCallback, useState, type ReactNode, type RefObject } from 'react'

/** Keep the work item identifiable once its editable title scrolls out of view. */
export function IssueHeaderContext({
  enabled = true,
  issueId,
  title,
  status,
  scrollRef,
  titleRef,
  children,
}: {
  enabled?: boolean
  issueId: string
  title: string
  status: ReactNode
  scrollRef: RefObject<HTMLDivElement | null>
  titleRef: RefObject<HTMLTextAreaElement | null>
  children: ReactNode
}) {
  const [visibleIssue, setVisibleIssue] = useState<string | null>(null)
  const updateContext = useCallback(
    ([entry]: IntersectionObserverEntry[]) => {
      const root = scrollRef.current
      if (!root) return
      const top = entry.rootBounds?.top ?? root.getBoundingClientRect().top
      setVisibleIssue(entry.boundingClientRect.bottom <= top ? issueId : null)
    },
    [issueId, scrollRef]
  )
  useIntersectionEvent(titleRef, updateContext, { enabled, root: scrollRef, threshold: 0 })

  return (
    <div className="min-w-0 flex-1">
      {enabled && visibleIssue === issueId ? (
        <div data-testid="issue-header-context" className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-text-primary">{title}</span>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-text-secondary">
            {status}
          </span>
        </div>
      ) : (
        children
      )}
    </div>
  )
}
