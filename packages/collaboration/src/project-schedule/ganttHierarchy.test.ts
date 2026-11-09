import { describe, expect, it } from 'vitest'
import type { CollaborationIssue } from '../types'
import { defaultScheduleViewOptions, parseScheduleDate } from './model'
import { ganttHierarchyRows } from './ganttHierarchy'

function issue(
  id: string,
  parent_id: string | null,
  overrides: Partial<CollaborationIssue> = {},
): CollaborationIssue {
  return {
    id,
    parent_id,
    title: id,
    status: 'inbox',
    priority: 'none',
    sequence_number: Number(id),
    tags: [],
    start_at: '2026-11-04',
    due_at: '2026-11-06',
    ...overrides,
  } as CollaborationIssue
}
const rows = (
  issues: CollaborationIssue[],
  collapsed = new Set<string>(),
  options = defaultScheduleViewOptions,
) =>
  ganttHierarchyRows(
    issues,
    options,
    parseScheduleDate('2026-11-02')!,
    parseScheduleDate('2026-11-15')!,
    collapsed,
  )

describe('Gantt hierarchy', () => {
  it('orders parents before nested children while sorting siblings by the chosen order', () => {
    const result = rows([
      issue('4', '1'),
      issue('3', '2'),
      issue('2', '1'),
      issue('1', null),
    ])
    expect(
      result.map((row) => [row.issue.id, row.depth, row.hasChildren]),
    ).toEqual([
      ['1', 0, true],
      ['2', 1, true],
      ['3', 2, false],
      ['4', 1, false],
    ])
    expect(result.map((row) => row.root.id)).toEqual(['1', '1', '1', '1'])
  })
  it('collapses whole subtrees and preserves nested collapse state', () => {
    const issues = [
      issue('1', null),
      issue('2', '1'),
      issue('3', '2'),
      issue('4', '1'),
    ]
    expect(
      rows(issues, new Set(['1', '2'])).map((row) => row.issue.id),
    ).toEqual(['1'])
    expect(rows(issues, new Set(['2'])).map((row) => row.issue.id)).toEqual([
      '1',
      '2',
      '4',
    ])
    expect(rows(issues).map((row) => row.issue.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ])
  })
  it('keeps undated and out-of-window ancestors without inventing draggable dates', () => {
    const result = rows([
      issue('1', null, { start_at: null, due_at: null }),
      issue('2', '1', { start_at: '2026-10-01', due_at: '2026-10-02' }),
      issue('3', '2'),
    ])
    expect(result.map((row) => row.issue.id)).toEqual(['1', '2', '3'])
    expect(result.map((row) => Boolean(row.range))).toEqual([
      false,
      false,
      true,
    ])
  })
  it('shows ancestors of a filtered child and excludes unrelated siblings', () => {
    const result = rows(
      [
        issue('1', null),
        issue('2', '1', { tags: ['selected'] }),
        issue('3', '1'),
      ],
      new Set(),
      { ...defaultScheduleViewOptions, tag: 'selected', groupBy: 'tag' },
    )
    expect(result.map((row) => row.issue.id)).toEqual(['1', '2'])
    expect(result.map((row) => row.root.id)).toEqual(['1', '1'])
    expect(result[0].range).toBeNull()
  })
  it('does not expose restricted ancestors and retains readable orphan children', () => {
    const result = rows([
      issue('1', null, { can_view_detail: false }),
      issue('2', '1'),
      issue('3', 'missing'),
    ])
    expect(result.map((row) => [row.issue.id, row.depth])).toEqual([
      ['2', 0],
      ['3', 0],
    ])
  })
  it('omits unrelated undated and out-of-window tasks', () => {
    expect(
      rows([
        issue('1', null, { start_at: null, due_at: null }),
        issue('2', null, { start_at: '2026-10-01', due_at: '2026-10-02' }),
      ]),
    ).toEqual([])
  })
})
