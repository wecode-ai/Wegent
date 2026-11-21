import { useMemo, useRef, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'
import { ISSUE_ASSIGNMENTS_CHANGED } from './issueAssignmentEvents'
import { useCloudIssueApis } from './useCloudIssueApis'

export function useIssueAssignmentCount(cloud: CloudConnectionContextValue, enabled: boolean) {
  const personal = useCloudIssueApis(cloud)?.personal
  const resource = useMemo(
    () =>
      enabled && personal
        ? createAsyncResource(
            'issue-assignment-count',
            signal => personal.assignmentCount(signal),
            { delayMs: 180 }
          )
        : null,
    [enabled, personal]
  )
  const lastFocusRefresh = useRef(0)
  useDOMEvent('window', ISSUE_ASSIGNMENTS_CHANGED, () => void resource?.reload(), {
    enabled: Boolean(resource),
  })
  useDOMEvent(
    'window',
    'focus',
    () => {
      if (!resource || Date.now() - lastFocusRefresh.current < 30_000) return
      lastFocusRefresh.current = Date.now()
      void resource.reload()
    },
    { enabled: Boolean(resource) }
  )
  const snapshot = useSyncExternalStore(
    resource?.subscribe ?? subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  return snapshot.data?.count ?? null
}
