// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import type { CollaborationIssue } from '../types'
import { createCollaborationTranslator } from '../i18n'
import {
  boardDropHint,
  savedBoardColumns,
  unmatchedCreateDefaults,
  type SavedBoardView,
} from './projectBoardViews'
import {
  filterStandardCloudBoardItems,
  matchesStandardCloudBoardColumn,
  resolveStandardCloudBoardMutation,
  type StandardCloudBoardItem,
} from './useStandardCloudBoardController'

const view: SavedBoardView = {
  id: 'stages',
  name: 'Stages',
  columns: [
    { id: 'backlog', type: 'unmatched', value: 'Backlog' },
    { id: 'design', type: 'tag', value: 'design' },
    { id: 'develop', type: 'tag', value: 'develop' },
  ],
}
const item: StandardCloudBoardItem = {
  id: 'one',
  cloud_project_id: 'project',
  parent_id: null,
  status: 'completed',
  tags: ['bug'],
  priority: 'high',
  sort_order: 0,
  version: 1,
  created_at: '2026-10-01',
  updated_at: '2026-10-01',
}
const columns = savedBoardColumns(view, [], [])
const matches = (candidate: StandardCloudBoardItem) =>
  matchesStandardCloudBoardColumn(candidate, columns[0], 'status', {})
const move = (candidate: StandardCloudBoardItem, source = columns[1], target = columns[0]) =>
  resolveStandardCloudBoardMutation({
    item: candidate,
    items: [candidate],
    groupBy: 'status',
    beforeItemId: null,
    sourceColumn: source,
    column: target,
  })

describe('Backlog projection', () => {
  it('includes new and business-tagged Issues, and excludes every matching stage', () => {
    expect(matches({ ...item, tags: [] })).toBe(true)
    expect(matches(item)).toBe(true)
    expect(matches({ ...item, tags: ['bug', 'design'] })).toBe(false)
    expect(matches({ ...item, tags: ['develop'] })).toBe(false)
    expect(matches({ ...item, tags: ['design', 'develop'] })).toBe(false)
  })

  it('removes all view stage tags while preserving other tags and completion status', () => {
    const mutation = move({ ...item, tags: ['design', 'bug', 'develop'] })!
    expect(mutation).toMatchObject({ kind: 'tag', tags: ['bug'] })
    expect(mutation.optimisticItems[0]).toMatchObject({
      status: 'completed',
      tags: ['bug'],
    })
    expect(matches(mutation.optimisticItems[0])).toBe(true)
    const forward = move(mutation.optimisticItems[0], columns[0], columns[2])!
    expect(forward).toMatchObject({ kind: 'tag', tags: ['bug', 'develop'] })
    expect(matches(forward.optimisticItems[0])).toBe(false)
  })

  it('matches status lanes too and refuses a return that would require choosing a different status', () => {
    const mixed = savedBoardColumns(
      {
        ...view,
        columns: [...view.columns, { id: 'done', type: 'status', value: 'completed' }],
      },
      [],
      []
    )
    expect(matchesStandardCloudBoardColumn(item, mixed[0], 'status', {})).toBe(false)
    expect(move({ ...item, tags: ['design'] }, mixed[1], mixed[0])).toBeNull()
    expect(move({ ...item, status: 'inbox', tags: ['design'] }, mixed[1], mixed[0])).toMatchObject({
      tags: [],
    })
  })

  it('does not treat hidden regular lanes as unmatched when searching or selecting a lane', () => {
    expect(
      filterStandardCloudBoardItems({
        column: columns[0],
        currentParentId: null,
        extensions: { getSearchText: issue => issue.id },
        items: [
          item,
          { ...item, id: 'two', tags: ['design'] },
          { ...item, id: 'child', parent_id: 'one' },
        ],
        state: {
          groupBy: 'status',
          groupFilter: 'backlog',
          query: '',
          getColumnSort: () => [],
        },
      }).map(issue => issue.id)
    ).toEqual(['one'])
  })

  it('uses current view lanes only and supports a single Backlog-only view', () => {
    const only = savedBoardColumns({ ...view, columns: [view.columns[0]] }, [], [])
    expect(
      matchesStandardCloudBoardColumn({ ...item, tags: ['design'] }, only[0], 'status', {})
    ).toBe(true)
  })

  it('rejects a return that would remove a required view filter tag', () => {
    const filtered = savedBoardColumns(
      { ...view, filter: { tags: ['design'], match: 'all' } },
      [],
      []
    )
    expect(move({ ...item, tags: ['design', 'bug'] }, filtered[1], filtered[0])).toBeNull()
    const any = savedBoardColumns(
      { ...view, filter: { tags: ['design', 'bug'], match: 'any' } },
      [],
      []
    )
    expect(move({ ...item, tags: ['design', 'bug'] }, any[1], any[0])).toMatchObject({
      tags: ['bug'],
    })
  })

  it('keeps manual ordering available inside Backlog', () => {
    const second = { ...item, id: 'two', sort_order: 1 }
    const mutation = resolveStandardCloudBoardMutation({
      item: second,
      items: [item, second],
      groupBy: 'status',
      beforeItemId: item.id,
      sourceColumn: columns[0],
      column: columns[0],
      manualSort: true,
    })!
    expect(mutation.kind).toBe('reorder')
    expect(mutation.position).toEqual({ beforeItemId: item.id })
  })
})

const statuses = [
  { id: 'inbox', name: 'Inbox', color: 'gray' as const },
  { id: 'completed', name: 'Done', color: 'gray' as const },
]
it('explains filter-blocked Backlog drops in both languages', () => {
  const filtered = savedBoardColumns(
    { ...view, filter: { tags: ['design'] } },
    [],
    []
  )
  for (const locale of ['en', 'zh-CN'] as const) {
    const hint = boardDropHint(
      { ...item, tags: ['design'] },
      filtered[0],
      filtered[1],
      'status',
      createCollaborationTranslator(locale)
    )
    expect(hint).toBe(
      locale === 'en'
        ? 'Removing stage tags would break this view’s filters. Move not allowed.'
        : '移除阶段标签后将不满足当前视图筛选，无法移入'
    )
  }
})
describe('Backlog creation defaults', () => {
  it('isolates saved drafts when a lane claims a saved tag or filters change', () => {
    const original = unmatchedCreateDefaults(view, statuses)!
    const changed = unmatchedCreateDefaults(
      { ...view, columns: [...view.columns, { id: 'bugs', type: 'tag', value: 'bug' }] },
      statuses
    )!
    expect(changed.tags).toEqual(original.tags)
    expect(changed.draftScope).not.toBe(original.draftScope)
    const filtered = { ...view, filter: { tags: ['bug'], match: 'any' as const } }
    const before = unmatchedCreateDefaults(filtered, statuses)!
    const after = unmatchedCreateDefaults(
      { ...filtered, filter: { tags: ['bug', 'priority'], match: 'any' } },
      statuses
    )!
    expect(after.tags).toEqual(before.tags)
    expect(after.draftScope).not.toBe(before.draftScope)
    expect(unmatchedCreateDefaults({ ...view, name: 'Planning' }, statuses)!.draftScope).toBe(
      original.draftScope
    )
  })
  it('keeps the board parent and separates child and root drafts', () => {
    const parent: CollaborationIssue = {
      ...item,
      sequence_number: 1,
      created_by_user_id: 1,
      assignee_user_id: null,
      title: 'Parent',
      description: '',
      priority: 'high',
      due_at: null,
      completed_at: null,
      sort_order: 0,
    }
    const child = unmatchedCreateDefaults(view, statuses, parent)!
    expect(child.parent).toBe(parent)
    expect(child.draftScope).not.toBe(unmatchedCreateDefaults(view, statuses)!.draftScope)
  })
  it('keeps the normal initial status and satisfies all filters without stage tags', () => {
    expect(
      unmatchedCreateDefaults({ ...view, filter: { tags: ['bug'], match: 'all' } }, statuses)
    ).toMatchObject({ status: 'inbox', tags: ['bug'] })
    expect(
      unmatchedCreateDefaults(
        { ...view, columns: [...view.columns, { id: 'new', type: 'status', value: 'inbox' }] },
        statuses
      )
    ).toBeNull()
  })
  it('selects a non-stage tag for any filters and rejects impossible all filters', () => {
    const tags = Array.from({ length: 21 }, (_, index) => `business-${index}`)
    expect(unmatchedCreateDefaults({ ...view, filter: { tags } }, statuses)).toBeNull()
    expect(
      unmatchedCreateDefaults({ ...view, filter: { tags: tags.slice(0, 20) } }, statuses)
    ).toMatchObject({ tags: tags.slice(0, 20) })
    expect(
      unmatchedCreateDefaults(
        { ...view, filter: { tags: ['design', 'bug'], match: 'any' } },
        statuses
      )
    ).toMatchObject({ tags: ['bug'] })
    expect(
      unmatchedCreateDefaults({ ...view, filter: { tags: ['design'], match: 'all' } }, statuses)
    ).toBeNull()
    expect(
      unmatchedCreateDefaults({ ...view, filter: { tags: ['design'], match: 'any' } }, statuses)
    ).toBeNull()
    expect(unmatchedCreateDefaults(view, [])).toBeNull()
  })
})
