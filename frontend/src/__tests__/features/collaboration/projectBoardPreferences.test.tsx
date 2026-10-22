// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'
import { useProjectBoardState } from '@wegent/collaboration/project-board'

const base = 'collaboration-board-column-sort:v2:0:local-project'
const laneKey = (lane: string) => `${base}:${JSON.stringify(['status', lane])}`
const options = (key = base) => ({
  defaultGroupBy: 'status' as const,
  focusStorageKey: null,
  personalGroupStorageKey: null,
  personalSortStorageKey: key,
})

describe('independent board lane preferences', () => {
  beforeEach(() => localStorage.clear())

  it('keeps edits from two mounted boards and restores both after reopening', () => {
    const first = renderHook(() => useProjectBoardState(options()))
    const second = renderHook(() => useProjectBoardState(options()))
    act(() => first.result.current.selectColumnSort('pending', []))
    expect(second.result.current.getColumnSort('pending')).toEqual([])
    act(() => second.result.current.selectColumnSort('completed', ['created-asc']))
    expect(first.result.current.getColumnSort('pending')).toEqual([])
    expect(first.result.current.getColumnSort('completed')).toEqual(['created-asc'])
    first.unmount()
    second.unmount()
    const reopened = renderHook(() => useProjectBoardState(options()))
    expect(reopened.result.current.getColumnSort('pending')).toEqual([])
    expect(reopened.result.current.getColumnSort('completed')).toEqual(['created-asc'])
  })

  it('reads other tabs and does not overwrite their lane when saving another lane', () => {
    const board = renderHook(() => useProjectBoardState(options()))
    act(() => {
      localStorage.setItem(laneKey('pending'), JSON.stringify(['updated-asc']))
      window.dispatchEvent(new StorageEvent('storage', { key: laneKey('pending') }))
    })
    expect(board.result.current.getColumnSort('pending')).toEqual(['updated-asc'])
    act(() => board.result.current.selectColumnSort('completed', []))
    expect(JSON.parse(localStorage.getItem(laneKey('pending'))!)).toEqual(['updated-asc'])
    act(() => {
      localStorage.removeItem(laneKey('pending'))
      window.dispatchEvent(new StorageEvent('storage', { key: laneKey('pending') }))
    })
    expect(board.result.current.getColumnSort('pending')).toEqual(['priority-desc'])
  })

  it('migrates the old map once and preserves a more recent lane entry', () => {
    localStorage.setItem(
      base,
      JSON.stringify({
        '["status","pending"]': [],
        '["status","completed"]': ['created-desc'],
      })
    )
    localStorage.setItem(laneKey('pending'), JSON.stringify(['updated-desc']))
    const board = renderHook(() => useProjectBoardState(options()))
    expect(board.result.current.getColumnSort('pending')).toEqual(['updated-desc'])
    expect(board.result.current.getColumnSort('completed')).toEqual(['created-desc'])
    expect(localStorage.getItem(base)).toBeNull()
  })

  it('isolates both user and project when the mounted board changes identity', () => {
    const board = renderHook(({ key }) => useProjectBoardState(options(key)), {
      initialProps: { key: base },
    })
    act(() => board.result.current.selectColumnSort('pending', []))
    board.rerender({ key: 'collaboration-board-column-sort:v2:7:local-project' })
    expect(board.result.current.getColumnSort('pending')).toEqual(['priority-desc'])
    act(() => board.result.current.selectColumnSort('pending', ['created-asc']))
    board.rerender({ key: 'collaboration-board-column-sort:v2:7:other-project' })
    expect(board.result.current.getColumnSort('pending')).toEqual(['priority-desc'])
    board.rerender({ key: base })
    expect(board.result.current.getColumnSort('pending')).toEqual([])
  })
})
