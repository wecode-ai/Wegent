// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'

import type { CollaborationIssue } from '../types'
import {
  confirmIssueRead,
  mergeIssueReadCursor,
  mergeIssueReadConfirmation,
  mergeIssueReadState,
  type IssueReadProjection,
} from './issueReadState'

const issue = {
  id: 'issue-1',
  content_revision: 3,
  activity_read_sequence: 10,
  is_unread: true,
} as CollaborationIssue

describe('confirmed Issue read state', () => {
  it('merges a read response without replacing newer content or host fields', () => {
    const current = {
      ...issue,
      version: 2,
      project_store: 'local' as const,
      title: 'New content',
    }
    const read = {
      ...current,
      version: 1,
      content_revision: 2,
      is_unread: false,
      activity_read_sequence: 20,
      title: 'Old content',
    }

    expect(mergeIssueReadConfirmation(current, read)).toEqual({
      ...current,
      activity_read_sequence: 20,
    })
    expect(
      mergeIssueReadConfirmation(current, {
        ...read,
        content_revision: 3,
      }),
    ).toEqual({ ...current, is_unread: false, activity_read_sequence: 20 })
  })

  it('merges content and activity cursors independently without moving either backwards', () => {
    const newerContent = confirmIssueRead({}, { ...issue, is_unread: false })
    const olderContent = confirmIssueRead(newerContent, {
      ...issue,
      content_revision: 2,
      activity_read_sequence: 20,
      is_unread: false,
    })

    expect(olderContent[issue.id]).toEqual({
      contentRevision: 3,
      activitySequence: 20,
    })
    expect(mergeIssueReadCursor(issue, olderContent[issue.id])).toMatchObject({
      is_unread: false,
      activity_read_sequence: 20,
    })
  })

  it('keeps newer content unread even when the activity cursor is much higher', () => {
    const reads = confirmIssueRead(
      {},
      {
        ...issue,
        content_revision: 2,
        activity_read_sequence: 200,
        is_unread: false,
      },
    )

    expect(mergeIssueReadCursor(issue, reads[issue.id])).toMatchObject({
      content_revision: 3,
      activity_read_sequence: 200,
      is_unread: true,
    })
  })

  it('does not infer read content from an unread response or a missing revision', () => {
    const reads = confirmIssueRead({}, issue)
    expect(reads[issue.id]).toEqual({
      contentRevision: 0,
      activitySequence: 10,
    })
    expect(mergeIssueReadCursor(issue, reads[issue.id]).is_unread).toBe(true)
    expect(
      mergeIssueReadCursor(
        { ...issue, content_revision: undefined },
        { contentRevision: 3, activitySequence: 10 },
      ).is_unread,
    ).toBe(true)
  })

  it('applies a read confirmation across detail, board, home and My Work projections', () => {
    const previous: IssueReadProjection = {
      confirmedIssueReads: {},
      selectedIssue: issue,
      issues: [issue],
      myWork: [issue],
      projectItems: { project: [issue] },
    }
    const confirmed = mergeIssueReadState(previous, previous, {
      ...issue,
      is_unread: false,
    })
    expect(confirmed.selectedIssue?.is_unread).toBe(false)
    expect(confirmed.issues[0].is_unread).toBe(false)
    expect(confirmed.myWork[0].is_unread).toBe(false)
    expect(confirmed.projectItems.project[0].is_unread).toBe(false)

    const stale = mergeIssueReadState(confirmed, {
      ...confirmed,
      selectedIssue: issue,
      issues: [issue],
      myWork: [issue],
      projectItems: { project: [issue] },
    })
    expect(stale.selectedIssue?.is_unread).toBe(false)
    expect(stale.issues[0].is_unread).toBe(false)
    expect(stale.myWork[0].is_unread).toBe(false)
    expect(stale.projectItems.project[0].is_unread).toBe(false)
  })
})
