// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationIssue } from '../types'

export interface ConfirmedIssueRead {
  contentRevision: number
  activitySequence: number
}

function updatedReadCursor(
  confirmed: ConfirmedIssueRead | undefined,
  confirmation: CollaborationIssue,
): ConfirmedIssueRead | undefined {
  const contentRevision = Math.max(
    confirmed?.contentRevision ?? 0,
    confirmation.is_unread === false ? (confirmation.content_revision ?? 0) : 0,
  )
  const activitySequence = Math.max(
    confirmed?.activitySequence ?? 0,
    confirmation.activity_read_sequence ?? 0,
  )
  return contentRevision > (confirmed?.contentRevision ?? 0) ||
    activitySequence > (confirmed?.activitySequence ?? 0)
    ? { contentRevision, activitySequence }
    : confirmed
}

export function confirmIssueRead(
  reads: Record<string, ConfirmedIssueRead>,
  confirmation: CollaborationIssue,
): Record<string, ConfirmedIssueRead> {
  const confirmed = reads[confirmation.id]
  const updated = updatedReadCursor(confirmed, confirmation)
  return updated && updated !== confirmed
    ? { ...reads, [confirmation.id]: updated }
    : reads
}

export function newestIssue<I extends CollaborationIssue>(
  current: I | null | undefined,
  incoming: I,
): I {
  return current?.id === incoming.id &&
    (current.version > incoming.version ||
      (current.version === incoming.version &&
        (current.content_revision ?? 0) > (incoming.content_revision ?? 0)))
    ? current
    : incoming
}

export function mergeIssueReadConfirmation<I extends CollaborationIssue>(
  current: I | null | undefined,
  confirmation: I,
  confirmed?: ConfirmedIssueRead,
): I {
  return mergeIssueReadCursor(
    newestIssue(current, confirmation),
    updatedReadCursor(confirmed, confirmation),
  )
}

export function mergeIssueReadCursor<I extends CollaborationIssue>(
  issue: I,
  confirmed?: ConfirmedIssueRead,
): I {
  if (!confirmed) return issue
  const isUnread =
    issue.content_revision !== undefined &&
    issue.content_revision <= confirmed.contentRevision
      ? false
      : issue.is_unread
  const activitySequence = Math.max(
    issue.activity_read_sequence ?? 0,
    confirmed.activitySequence,
  )
  if (
    isUnread === issue.is_unread &&
    activitySequence <= (issue.activity_read_sequence ?? 0)
  )
    return issue
  return {
    ...issue,
    is_unread: isUnread,
    ...(activitySequence > 0
      ? { activity_read_sequence: activitySequence }
      : {}),
  }
}

export interface IssueReadProjection {
  confirmedIssueReads: Record<string, ConfirmedIssueRead>
  selectedIssue: CollaborationIssue | null
  issues: CollaborationIssue[]
  myWork: CollaborationIssue[]
  projectItems: Record<string, CollaborationIssue[]>
}

export function mergeIssueReadState<T extends IssueReadProjection>(
  previous: T,
  next: T,
  confirmation?: CollaborationIssue,
): T {
  const confirmedIssueReads = confirmation
    ? confirmIssueRead(next.confirmedIssueReads, confirmation)
    : next.confirmedIssueReads
  const cursorChanged = confirmedIssueReads !== previous.confirmedIssueReads
  const mergeIssue = <I extends CollaborationIssue>(issue: I): I =>
    mergeIssueReadCursor(issue, confirmedIssueReads[issue.id])
  const mergeList = <I extends CollaborationIssue>(
    before: I[],
    items: I[],
  ): I[] => (!cursorChanged && before === items ? items : items.map(mergeIssue))
  return {
    ...next,
    confirmedIssueReads,
    selectedIssue:
      !cursorChanged && previous.selectedIssue === next.selectedIssue
        ? next.selectedIssue
        : next.selectedIssue
          ? mergeIssue(next.selectedIssue)
          : null,
    issues: mergeList(previous.issues, next.issues),
    myWork: mergeList(previous.myWork, next.myWork),
    projectItems:
      !cursorChanged && previous.projectItems === next.projectItems
        ? next.projectItems
        : Object.fromEntries(
            Object.entries(next.projectItems).map(([projectId, items]) => [
              projectId,
              mergeList(previous.projectItems[projectId] ?? [], items),
            ]),
          ),
  }
}
