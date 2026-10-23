// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useStandardCloudBoardController,
  type ProjectBoardColumn,
  type StandardCloudBoardItem,
} from '@wegent/collaboration/project-board'

const pending: ProjectBoardColumn = {
  dotClass: '',
  groupValue: 'pending',
  key: 'pending',
  label: 'Pending',
  status: 'pending',
}
const completed = { ...pending, groupValue: 'completed', key: 'completed', status: 'completed' }
const items: StandardCloudBoardItem[] = ['low', 'urgent', 'high'].map((priority, index) => ({
  id: String(index),
  parent_id: null,
  priority,
  sort_order: index,
  status: 'pending',
  created_at: `2026-09-${10 + index}T00:00:00Z`,
  updated_at: `2026-09-${12 - index}T00:00:00Z`,
  tags: [],
}))
const extensions = { getSearchText: (item: StandardCloudBoardItem) => item.id }

function setup(storageKey = 'test:board-sort:project-a') {
  const onMove = vi.fn()
  const options = {
    createColumns: () => [pending, completed],
    defaultGroupBy: 'status' as const,
    viewScope: 'project-a:default',
    focusStorageKey: null,
    personalGroupStorageKey: null,
    personalSortStorageKey: storageKey,
    extensions,
    items: [
      ...items,
      ...items.map(item => ({ ...item, id: `completed-${item.id}`, status: 'completed' })),
    ],
    onMove,
  }
  return {
    ...renderHook(props => useStandardCloudBoardController(props), { initialProps: options }),
    onMove,
    options,
  }
}

describe('project board sorting', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to priority and restores personal manual order after remounting', () => {
    const first = setup()
    expect(first.result.current.state.getColumnSort(pending.key)).toEqual(['priority-desc'])
    expect(
      first.result.current.getColumnItems(pending, first.result.current.state).map(item => item.id)
    ).toEqual(['1', '2', '0'])
    act(() => first.result.current.state.selectColumnSort(pending.key, []))
    expect(
      first.result.current.getColumnItems(pending, first.result.current.state).map(item => item.id)
    ).toEqual(['0', '1', '2'])
    expect(first.result.current.state.getColumnSort(completed.key)).toEqual(['priority-desc'])
    act(() => first.result.current.state.selectColumnSort(completed.key, ['created-desc']))
    expect(
      first.result.current
        .getColumnItems(completed, first.result.current.state)
        .map(item => item.id)
    ).toEqual(['completed-2', 'completed-1', 'completed-0'])
    expect(first.result.current.state.getColumnSort(pending.key)).toEqual([])
    first.unmount()
    const second = setup()
    expect(second.result.current.state.getColumnSort(pending.key)).toEqual([])
    expect(second.result.current.state.getColumnSort(completed.key)).toEqual(['created-desc'])
  })

  it('restores compound rules in order and compares ties using the next rule', () => {
    const first = setup()
    first.rerender({ ...first.options, items: items.map(item => ({ ...item, priority: 'high' })) })
    act(() =>
      first.result.current.state.selectColumnSort(pending.key, ['priority-desc', 'created-desc'])
    )
    expect(
      first.result.current.getColumnItems(pending, first.result.current.state).map(item => item.id)
    ).toEqual(['2', '1', '0'])
    expect(first.result.current.state.getColumnSort(completed.key)).toEqual(['priority-desc'])
    first.unmount()
    const second = setup()
    expect(second.result.current.state.getColumnSort(pending.key)).toEqual([
      'priority-desc',
      'created-desc',
    ])
  })

  it('isolates sorting by project and resets an invalid saved preference', () => {
    const { result, rerender, options } = setup()
    act(() => result.current.state.selectColumnSort(pending.key, []))
    rerender({ ...options, personalSortStorageKey: 'test:board-sort:project-b' })
    expect(result.current.state.getColumnSort(pending.key)).toEqual(['priority-desc'])
    rerender(options)
    expect(result.current.state.getColumnSort(pending.key)).toEqual([])
    localStorage.setItem('test:board-sort:project-b', 'invalid')
    rerender({ ...options, personalSortStorageKey: 'test:board-sort:project-b' })
    expect(result.current.state.getColumnSort(pending.key)).toEqual(['priority-desc'])
  })

  it('keeps preferences independent when the grouping changes', () => {
    const { result } = setup()
    act(() => result.current.state.selectColumnSort(pending.key, ['updated-desc']))
    act(() => result.current.state.selectGroupBy('tag'))
    expect(result.current.state.getColumnSort(pending.key)).toEqual(['priority-desc'])
    act(() => result.current.state.selectColumnSort(pending.key, ['priority-asc']))
    act(() => result.current.state.selectGroupBy('status'))
    expect(result.current.state.getColumnSort(pending.key)).toEqual(['updated-desc'])
  })

  it('keeps automatic order on same-column drops and allows moves to other columns', () => {
    const { result, onMove } = setup()
    act(() => result.current.moveItem('2', pending, '0'))
    expect(onMove).not.toHaveBeenCalled()
    act(() => result.current.moveItem('2', completed, null))
    expect(onMove).toHaveBeenCalledWith(
      items[2],
      completed,
      null,
      expect.objectContaining({
        kind: 'status',
        status: 'completed',
      })
    )
    onMove.mockClear()
    act(() => result.current.state.selectColumnSort(completed.key, []))
    act(() => result.current.moveItem('2', completed, 'completed-0'))
    expect(onMove).toHaveBeenCalledWith(
      items[2],
      completed,
      'completed-0',
      expect.objectContaining({
        position: { beforeItemId: 'completed-0' },
      })
    )
    expect(result.current.state.getColumnSort(pending.key)).toEqual(['priority-desc'])
    onMove.mockClear()
    act(() => result.current.state.selectColumnSort(pending.key, []))
    act(() => result.current.moveItem('2', pending, '0'))
    expect(onMove).toHaveBeenCalledWith(
      items[2],
      pending,
      '0',
      expect.objectContaining({
        kind: 'reorder',
        position: { beforeItemId: '0' },
      })
    )
  })

  it('announces a move only after persistence and keeps failed or canceled moves unhighlighted', async () => {
    const { result, onMove, options, rerender } = setup()
    onMove
      .mockRejectedValueOnce(new Error('Conflict'))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    await act(async () => result.current.moveItem('2', completed, null))
    expect(result.current.lastMove).toBeNull()
    expect(result.current.moveError).toBe('Conflict')
    rerender({ ...options, viewScope: 'project-b:default' })
    expect(result.current.moveError).toBeNull()
    rerender(options)
    await act(async () => result.current.moveItem('2', completed, null))
    expect(result.current.lastMove).toBeNull()
    await act(async () => result.current.moveItem('2', completed, null))
    expect(result.current.lastMove).toMatchObject({ itemId: '2', columnKey: 'completed' })
    expect(result.current.moveError).toBeNull()
  })
})
