import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { CollaborationIssue, SharedWorkspaceApi } from '@wegent/collaboration'

/** A Thread's displayed metadata revision is separate from its activity cursor. */
export function useThreadContentRead({
  api,
  accountScope,
  groupId,
  actorId,
  item,
  active,
  loaded,
  viewport,
  onRead,
}: {
  api: SharedWorkspaceApi
  accountScope?: string
  groupId: string
  actorId: string | number | undefined
  item: CollaborationIssue | null
  active: boolean
  loaded: boolean
  viewport: RefObject<HTMLElement | null>
  onRead(): void
}) {
  const actorKey = actorId == null ? undefined : String(actorId)
  const scope = useMemo(
    () => ({ api, accountScope, groupId, actorKey, itemId: item?.id }),
    [api, accountScope, groupId, actorKey, item?.id]
  )
  const revision = item?.content_revision
  const current = useRef({ scope, active, revision })
  useLayoutEffect(() => {
    current.current = { scope, active, revision }
  }, [scope, active, revision])
  const [failure, setFailure] = useState<{ scope: typeof scope; revision: number } | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const confirmed = useRef<{ scope: typeof scope; revision: number } | null>(null)
  const pending = useRef(
    new Set<{ scope: typeof scope; revision: number; promise: Promise<CollaborationIssue> }>()
  )
  const retry = useCallback(() => setRetryKey(key => key + 1), [])
  const failed = active && failure?.scope === scope && failure.revision === revision
  const read = useRef(onRead)
  useLayoutEffect(() => {
    read.current = onRead
  }, [onRead])

  useEffect(() => {
    const element = viewport.current
    if (
      !active ||
      !loaded ||
      !element ||
      !item?.is_unread ||
      !actorKey ||
      item.cloud_project_id !== groupId ||
      !Number.isSafeInteger(revision) ||
      revision == null ||
      revision < 0 ||
      !api.issues?.markRead
    )
      return
    let disposed = false
    let attempted = false
    let frame = 0
    const isCurrent = () =>
      !disposed &&
      current.current.scope === scope &&
      current.current.active &&
      current.current.revision === revision
    const attempt = () => {
      if (!isCurrent() || attempted || document.visibilityState === 'hidden') return
      const bounds = element.getBoundingClientRect()
      if (
        !element.isConnected ||
        bounds.width <= 0 ||
        bounds.height <= 0 ||
        bounds.bottom <= 0 ||
        bounds.right <= 0 ||
        bounds.top >= window.innerHeight ||
        bounds.left >= window.innerWidth ||
        element.closest('[aria-hidden="true"], [hidden]')
      )
        return
      if (confirmed.current?.scope === scope && confirmed.current.revision >= revision) return
      attempted = true
      // Explicit zero preserves every activity cursor, including historical pages.
      const request = [...pending.current].find(
        value => value.scope === scope && value.revision === revision
      ) ?? {
        scope,
        revision,
        promise: api.issues.markRead(item.id, 0, revision),
      }
      pending.current.add(request)
      void request.promise
        .then(() => {
          if (!isCurrent()) return
          confirmed.current = request
          setFailure(null)
          read.current()
        })
        .catch(() => {
          if (isCurrent()) setFailure(request)
        })
        .finally(() => {
          pending.current.delete(request)
        })
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(attempt)
    }
    schedule()
    element.addEventListener('scroll', schedule, { passive: true })
    document.addEventListener('visibilitychange', schedule)
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    observer?.observe(element)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer?.disconnect()
      element.removeEventListener('scroll', schedule)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [
    scope,
    active,
    loaded,
    item?.is_unread,
    item?.id,
    item?.cloud_project_id,
    actorKey,
    groupId,
    api,
    revision,
    retryKey,
    viewport,
  ])
  return { failed, retry }
}
