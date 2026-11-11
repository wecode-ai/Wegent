// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'

import { groupBoardIssues, projectStatuses } from './board'
import { collaborationMessages, createCollaborationTranslator } from './i18n'
import type { CollaborationIssue, CollaborationProject } from './types'

function issue(
  id: string,
  status: string,
  overrides: Partial<CollaborationIssue> = {}
): CollaborationIssue {
  return {
    id,
    cloud_project_id: 'project-1',
    sequence_number: Number(id.replace(/\D/g, '')) || 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    title: id,
    description: '',
    status,
    priority: 'none',
    due_at: null,
    tags: [],
    sort_order: 0,
    version: 1,
    created_at: '',
    updated_at: '',
    completed_at: null,
    ...overrides,
  }
}

const project = {
  project_key: 'COL',
  board_config: {
    group_by: 'status',
    processing_start_status_id: 'doing',
    statuses: [
      { id: 'todo', name: 'Todo', color: 'gray' },
      { id: 'doing', name: 'Doing', color: 'blue' },
    ],
  },
} as CollaborationProject

describe('groupBoardIssues', () => {
  it('uses the persisted project grouping', () => {
    const grouped = groupBoardIssues(
      {
        ...project,
        board_config: { ...project.board_config!, group_by: 'assignee' },
      },
      [
        issue('1', 'todo', { assignee_name: 'Ada' }),
        issue('2', 'doing', { assignee_name: 'Ada' }),
        issue('3', 'doing'),
      ],
      project.board_config!.statuses,
      'Unassigned',
      'No tag'
    )

    expect(grouped.map(group => [group.label, group.issues.length])).toEqual([
      ['Ada', 2],
      ['Unassigned', 1],
    ])
  })
})

describe('projectStatuses', () => {
  it('retains empty source columns when a project also aggregates Threads', () => {
    const custom = {
      ...project,
      board_config: {
        ...project.board_config!,
        statuses: [{ id: 'source_empty', name: 'Source empty', color: 'gray' as const }],
      },
    }
    const statuses = projectStatuses(
      custom,
      collaborationMessages.en,
      createCollaborationTranslator('en'),
      [issue('thread-1', 'pending', { group_id: 'group-1' })]
    )
    expect(statuses.find(status => status.id === 'source_empty')?.name).toBe('Source empty')
    expect(statuses.some(status => status.id === 'in_review')).toBe(true)
  })
  it('keeps shared Thread statuses visible across project and group configurations without rewriting history', () => {
    const threads = [
      issue('thread-1', 'in_review', { group_id: 'group-1' }),
      issue('thread-2', 'legacy_review', { group_id: 'group-2' }),
    ]
    for (const context of [project, { ...project, resource_type: 'chat_group' as const }]) {
      const statuses = projectStatuses(
        context,
        collaborationMessages.en,
        createCollaborationTranslator('en'),
        threads
      )
      expect(statuses.slice(0, 5).map(status => status.id)).toEqual([
        'inbox',
        'pending',
        'in_progress',
        'in_review',
        'completed',
      ])
      const grouped = groupBoardIssues(context, threads, statuses, 'Unassigned', 'No tag')
      expect(grouped.flatMap(group => group.issues).map(item => item.id)).toEqual([
        'thread-1',
        'thread-2',
      ])
      expect(threads[1]!.status).toBe('legacy_review')
    }
  })
  it('uses the same default statuses for boards and automation when board settings are absent', () => {
    const statuses = projectStatuses(
      { ...project, board_config: undefined },
      collaborationMessages.en,
      createCollaborationTranslator('en')
    )
    expect(statuses.map(status => [status.id, status.name])).toEqual([
      ['inbox', 'Inbox'],
      ['pending', 'To do'],
      ['in_progress', 'In progress'],
      ['in_review', 'In review'],
      ['completed', 'Completed'],
    ])
  })

  it('preserves the project custom statuses and their display names', () => {
    expect(
      projectStatuses(project, collaborationMessages.en, createCollaborationTranslator('en'))
    ).toEqual(project.board_config!.statuses)
  })
})
