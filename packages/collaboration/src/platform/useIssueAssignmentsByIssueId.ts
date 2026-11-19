// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useSyncExternalStore } from 'react'

import type { SharedWorkspaceAssignmentsApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationIssue } from '../types'
import { createIssueAssignmentsCatalog } from './issueAssignmentsResource'

export function useIssueAssignmentsByIssueId({
  assignmentsApi,
  issues,
  enabled = true,
}: {
  assignmentsApi: SharedWorkspaceAssignmentsApi | undefined
  issues: CollaborationIssue[]
  enabled?: boolean
}) {
  const catalog = useMemo(() => createIssueAssignmentsCatalog(assignmentsApi), [assignmentsApi])
  const selection = useMemo(
    () => catalog.select(enabled ? issues.map(issue => issue.id) : []),
    [catalog, enabled, issues]
  )
  const assignmentsByIssueId = useSyncExternalStore(
    selection.subscribe,
    selection.getSnapshot,
    selection.getSnapshot
  )
  return { assignmentsByIssueId, replaceIssueAssignments: selection.replace }
}
