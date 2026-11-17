import { useEffect, useState, type ReactNode, type RefObject } from 'react'

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
  useEffect(() => {
    const root = scrollRef.current
    const anchor = titleRef.current
    if (!enabled || !root || !anchor || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => {
        const top = entry.rootBounds?.top ?? root.getBoundingClientRect().top
        setVisibleIssue(entry.boundingClientRect.bottom <= top ? issueId : null)
      },
      { root, threshold: 0 },
    )
    observer.observe(anchor)
    return () => observer.disconnect()
  }, [enabled, issueId, scrollRef, titleRef])

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
