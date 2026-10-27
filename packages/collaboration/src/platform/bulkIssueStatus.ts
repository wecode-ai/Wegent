// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationIssue } from '../types'

export interface IssueStatusFailure {
  issueId: string
  message: string
}

/** Wait for every mutation so partial success never hides an outstanding failure. */
export async function bulkIssueStatus(
  issues: CollaborationIssue[],
  update: (issue: CollaborationIssue) => Promise<CollaborationIssue | null>,
  errorMessage: (error: unknown) => string
): Promise<IssueStatusFailure[]> {
  const results = await Promise.allSettled(issues.map(issue => update(issue)))
  return results.flatMap((result, index) =>
    result.status === 'fulfilled' && result.value !== null
      ? []
      : [
          {
            issueId: issues[index].id,
            message: errorMessage(result.status === 'rejected' ? result.reason : null),
          },
        ]
  )
}
