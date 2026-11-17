// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'

/** A host editor waits for its project; a confirmed guest uses the Issue editor. */
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
  const scope = useMemo(() => ({ api, projectId, issueId }), [api, projectId, issueId])
  const projectReadyRef = useRef(projectReady)
  projectReadyRef.current = projectReady
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{
    scope: typeof scope
    invited: boolean
    error: string | null
  } | null>(null)
  const current = result?.scope === scope ? result : null
  const invited = current?.invited === true
  useEffect(() => {
    if (!enabled || !projectId || !issueId || projectReady || invited) return
    let active = true
    void api.issues.get(issueId).then(
      issue => {
        if (active && !projectReadyRef.current) {
          setResult({ scope, invited: issue.invited_only === true, error: null })
        }
      },
      cause => {
        if (active)
          setResult({
            scope,
            invited: false,
            error: cause instanceof Error ? cause.message : failureLabel,
          })
      }
    )
    return () => {
      active = false
    }
  }, [api, projectId, issueId, projectReady, enabled, invited, scope, attempt, failureLabel])
  return {
    invited,
    error: current?.error ?? null,
    retry: () => {
      setResult(null)
      setAttempt(value => value + 1)
    },
  }
}
