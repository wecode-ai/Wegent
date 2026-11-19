// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'

interface Observation {
  enabled: boolean
  projectReady: boolean
  failureLabel: string
}
function createInvitedIssueRoute(
  api: SharedWorkspaceApi,
  projectId: string | null,
  issueId: string | null
) {
  let snapshot = { invited: false, error: null as string | null }
  let owner: Observation | undefined
  let revision = 0
  const listeners = new Set<() => void>()
  const publish = (value: typeof snapshot) => {
    snapshot = value
    listeners.forEach(listener => listener())
  }
  const read = async () => {
    const current = owner
    if (!current?.enabled || current.projectReady || !projectId || !issueId || snapshot.invited)
      return
    const request = ++revision
    try {
      const issue = await api.issues.get(issueId)
      if (listeners.size && request === revision && !owner?.projectReady)
        publish({ invited: issue.invited_only === true, error: null })
    } catch (cause) {
      if (listeners.size && request === revision)
        publish({
          invited: false,
          error: cause instanceof Error ? cause.message : current.failureLabel,
        })
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(input: Observation, listener: () => void) {
      const changed =
        !owner ||
        owner.enabled !== input.enabled ||
        owner.projectReady !== input.projectReady ||
        owner.failureLabel !== input.failureLabel
      owner = input
      listeners.add(listener)
      if (changed) {
        revision++
        void read()
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (!listeners.size) {
            revision++
            owner = undefined
          }
        })
      }
    },
    retry() {
      publish({ invited: false, error: null })
      void read()
    },
  }
}
/** A host editor waits for its project; confirmed Issue guests retain their scoped editor. */
export function useInvitedIssueRoute({
  api,
  projectId,
  issueId,
  projectReady,
  enabled,
  failureLabel,
}: {
  api: SharedWorkspaceApi
  projectId: string | null
  issueId: string | null
  projectReady: boolean
  enabled: boolean
  failureLabel: string
}) {
  const source = useMemo(
    () => createInvitedIssueRoute(api, projectId, issueId),
    [api, projectId, issueId]
  )
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe({ projectReady, enabled, failureLabel }, listener),
    [source, projectReady, enabled, failureLabel]
  )
  const snapshot = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  return { ...snapshot, retry: source.retry }
}
