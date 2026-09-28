// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { createCollaborationIssueCardModel, resolveIssueCardAssignee } from './model'

const labels = {
  assignee: 'Assignee',
  createdAt: 'Created',
  priority: {
    none: 'Normal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    urgent: 'Urgent',
  },
  unassigned: 'Unassigned',
} as const

describe('collaboration issue card model', () => {
  it('resolves user, team and agent assignees through one precedence rule', () => {
    expect(
      resolveIssueCardAssignee({
        id: 'ISSUE-1',
        title: 'Issue',
        priority: 'none',
        assignee_name: 'Ada',
        assignee_team_name: 'Platform',
      })
    ).toEqual({ assigneeKind: 'user', assigneeName: 'Ada' })
    expect(
      resolveIssueCardAssignee({
        id: 'ISSUE-1',
        title: 'Issue',
        priority: 'none',
        assignee_team_name: 'Platform',
      })
    ).toEqual({ assigneeKind: 'team', assigneeName: 'Platform' })
    expect(
      resolveIssueCardAssignee(
        {
          id: 'ISSUE-1',
          title: 'Issue',
          priority: 'none',
          assignee_agent_id: 'agent-1',
        },
        { 'agent-1': 'Codex' }
      )
    ).toEqual({ assigneeKind: 'agent', assigneeName: 'Codex' })
  })

  it('builds shared reference, priority, tags, unread and creation-date display data', () => {
    expect(
      createCollaborationIssueCardModel({
        item: {
          id: 'ISSUE-1',
          title: 'Share the board card',
          priority: 'high',
          created_at: '2026-09-12T03:00:00Z',
          tags: ['frontend'],
          is_unread: true,
        },
        labels,
        reference: 'WEG-1',
      })
    ).toMatchObject({
      date: { value: '2026-09-12' },
      priorityLabel: 'High',
      reference: 'WEG-1',
      tags: ['frontend'],
      title: 'Share the board card',
      unread: true,
    })
  })

  it('uses creation time even when updates and deadlines have different dates', () => {
    expect(
      createCollaborationIssueCardModel({
        item: {
          id: 'ISSUE-1',
          title: 'No deadline',
          priority: 'none',
          created_at: '2026-09-14T00:00:00Z',
          updated_at: '2026-09-21T00:00:00Z',
          due_at: '2026-09-23T00:00:00Z',
        },
        reference: 'WEG-1',
        labels,
        now: new Date(2026, 8, 21),
      }).date
    ).toEqual({ value: '2026-09-14', label: '09-14' })
  })

  it('does not substitute another timestamp when creation time is absent', () => {
    expect(
      createCollaborationIssueCardModel({
        item: {
          id: 'ISSUE-1',
          title: 'No date',
          priority: 'none',
          updated_at: '2026-09-21',
          due_at: '2026-09-23',
        },
        reference: 'WEG-1',
        labels,
      }).date
    ).toBeNull()
  })

  it('keeps complete references and creation dates while shortening their card labels', () => {
    const build = (created_at: string) =>
      createCollaborationIssueCardModel({
        item: {
          id: 'ISSUE-16',
          title: 'Issue',
          priority: 'none',
          created_at,
          updated_at: '2026-09-20T00:00:00Z',
        },
        reference: 'PRJ3EB7D2-16',
        labels,
        now: new Date(2026, 8, 21),
      })
    expect(build('2026-09-21T00:00:00Z')).toMatchObject({
      reference: 'PRJ3EB7D2-16',
      shortReference: '#16',
      date: { value: '2026-09-21', label: '09-21' },
    })
    expect(build('2026-09-23').date?.label).toBe('09-23')
    expect(build('2027-09-23').date?.label).toBe('2027-09-23')
  })
})
