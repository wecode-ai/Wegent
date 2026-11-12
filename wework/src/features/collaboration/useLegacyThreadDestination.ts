import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SharedWorkspaceApi } from '@wegent/collaboration'

/** Resolve retained IDs before loading the old project's page or resources. */
export function useLegacyThreadDestination({
  api,
  itemId,
  store,
  commentId,
  focusRequest,
  onNavigate,
}: {
  api: SharedWorkspaceApi | undefined
  itemId: string | null
  store: 'local' | 'cloud'
  commentId: string | null
  focusRequest: string | null
  onNavigate(search: string): void
}) {
  const [revision, setRevision] = useState(0)
  const request = useMemo(
    () => ({ api, itemId, store, commentId, focusRequest, revision }),
    [api, itemId, store, commentId, focusRequest, revision]
  )
  const latest = useRef({ request, onNavigate })
  useLayoutEffect(() => {
    latest.current = { request, onNavigate }
  }, [request, onNavigate])
  const [result, setResult] = useState<{ owner: object; failed: boolean } | null>(null)
  useEffect(() => {
    if (!api || !itemId) return
    let active = true
    void api.issues
      .get(itemId)
      .then(issue => {
        if (!active || latest.current.request !== request) return
        if (issue.group_id) {
          const params = new URLSearchParams({
            collaborationView: 'groups',
            groupStore: store,
            groupId: issue.group_id,
            threadId: issue.id,
            groupTab: 'chat',
          })
          if (commentId) params.set('commentId', commentId)
          if (focusRequest) params.set('focusRequest', focusRequest)
          latest.current.onNavigate(`?${params}`)
        }
        setResult({ owner: request, failed: false })
      })
      .catch(() => {
        if (active && latest.current.request === request)
          setResult({ owner: request, failed: true })
      })
    return () => {
      active = false
    }
  }, [api, itemId, store, commentId, focusRequest, request])
  const current = result?.owner === request ? result : null
  return {
    pending: Boolean(itemId && api && !current),
    failed: Boolean(itemId && (!api || current?.failed)),
    retry: () => setRevision(value => value + 1),
  }
}
