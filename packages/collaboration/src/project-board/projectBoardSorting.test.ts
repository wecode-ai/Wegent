// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import {
  compareProjectBoardItems,
  readProjectBoardColumnSorts,
  type ProjectBoardSort,
} from './projectBoardSorting'

const items = [
  {
    id: 'a',
    priority: 'low',
    sort_order: 2,
    created_at: '2026-09-10T01:00:00+08:00',
    updated_at: '2026-09-11T02:00:00Z',
  },
  {
    id: 'b',
    priority: 'urgent',
    sort_order: 1,
    created_at: '2026-09-10T00:00:00',
    updated_at: '2026-09-11T01:00:00Z',
  },
  {
    id: 'c',
    priority: 'high',
    sort_order: 0,
    created_at: '2026-09-09T23:00:00Z',
    updated_at: '2026-09-11T03:00:00',
  },
]

describe('project board sort modes', () => {
  it.each<[ProjectBoardSort, string[]]>([
    [['priority-desc'], ['b', 'c', 'a']],
    [['priority-asc'], ['a', 'c', 'b']],
    [['created-desc'], ['b', 'c', 'a']],
    [['created-asc'], ['a', 'c', 'b']],
    [['updated-desc'], ['c', 'a', 'b']],
    [['updated-asc'], ['b', 'a', 'c']],
    [[], ['c', 'b', 'a']],
  ])('orders Issues by %s', (mode, expected) => {
    expect(
      [...items]
        .sort((left, right) => compareProjectBoardItems(left, right, mode))
        .map(item => item.id)
    ).toEqual(expected)
  })

  it('uses manual order when timestamps represent the same instant', () => {
    const left = { ...items[0], created_at: '2026-09-10T08:00:00+08:00' }
    const right = { ...items[1], created_at: '2026-09-10T00:00:00' }
    expect(compareProjectBoardItems(left, right, ['created-desc'])).toBeGreaterThan(0)
    expect(compareProjectBoardItems(left, right, ['created-asc'])).toBeGreaterThan(0)
  })

  it.each([null, 'invalid', 'null', '[]', '"manual"', '{"lane":"unknown"}'])(
    'rejects invalid saved preferences: %s',
    saved => {
      expect(readProjectBoardColumnSorts(saved)).toEqual({})
    }
  )

  it('retains valid ordered rules and rejects duplicate fields or invalid entries', () => {
    expect(
      readProjectBoardColumnSorts(
        JSON.stringify({
          pending: [],
          completed: ['priority-desc', 'created-asc', 'updated-desc'],
          duplicate: ['priority-desc', 'priority-asc'],
          invalid: ['unknown'],
          old: 'manual',
        })
      )
    ).toEqual({ pending: [], completed: ['priority-desc', 'created-asc', 'updated-desc'] })
  })

  it('uses every rule before manual order and respects rule precedence', () => {
    const tied = [
      { ...items[0], id: 'a', priority: 'high', sort_order: 0 },
      { ...items[1], id: 'b', priority: 'high', sort_order: 1 },
      { ...items[2], id: 'c', priority: 'urgent', sort_order: 2 },
    ]
    const order = (rules: ProjectBoardSort) =>
      [...tied]
        .sort((left, right) => compareProjectBoardItems(left, right, rules))
        .map(item => item.id)
    expect(order(['priority-desc', 'created-desc'])).toEqual(['c', 'b', 'a'])
    expect(order(['created-desc', 'priority-desc'])).toEqual(['b', 'c', 'a'])
    expect(order(['priority-desc', 'created-asc'])).toEqual(['c', 'a', 'b'])
    const left = { ...tied[0], sort_order: 2, created_at: tied[1].created_at }
    expect(
      compareProjectBoardItems(left, tied[1], ['priority-desc', 'created-desc', 'updated-desc'])
    ).toBeLessThan(0)
    expect(
      compareProjectBoardItems(left, { ...tied[1], updated_at: left.updated_at }, [
        'priority-desc',
        'created-desc',
        'updated-desc',
      ])
    ).toBeGreaterThan(0)
  })
})
