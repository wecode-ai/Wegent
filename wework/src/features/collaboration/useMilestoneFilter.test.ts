// @vitest-environment jsdom
import { Activity, createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useStandardCloudBoardController } from '../../../../packages/collaboration/src/project-board/useStandardCloudBoardController'
import { useMilestoneFilter } from '../../../../packages/collaboration/src/milestones/useMilestoneFilter'
import type { CollaborationIssue } from '../../../../packages/collaboration/src/types'

const issue = (id: string, parent_id: string | null, milestone_id: string | null) =>
  ({ id, parent_id, milestone_id, status: 'pending' }) as CollaborationIssue
const issues = [
  issue('parent', null, 'm'),
  issue('same', 'parent', 'm'),
  issue('other', 'parent', null),
  issue('nested', 'other', null),
]

function setup(data = issues) {
  return renderHook(({ projectId, view }) => useMilestoneFilter(projectId, view, data), {
    initialProps: { projectId: 'p', view: 'board' },
  })
}

describe('milestone filter drilldown', () => {
  it('retains temporary drilldown across Activity restoration but clears it on real scope changes', () => {
    let mode: 'visible' | 'hidden' = 'visible'
    const { result, rerender } = renderHook(
      ({ projectId, view }) => useMilestoneFilter(projectId, view, issues),
      {
        initialProps: { projectId: 'p', view: 'board' },
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(Activity, { mode }, children),
      }
    )
    act(() => result.current.select('m'))
    act(() => result.current.openChildren(issues[0]))
    expect(result.current.filteredIssues).toHaveLength(4)
    mode = 'hidden'
    rerender({ projectId: 'p', view: 'board' })
    mode = 'visible'
    rerender({ projectId: 'p', view: 'board' })
    expect(result.current.value).toBe('all')
    expect(result.current.filteredIssues).toHaveLength(4)
    rerender({ projectId: 'p', view: 'table' })
    rerender({ projectId: 'p', view: 'board' })
    expect(result.current.value).toBe('m')
    act(() => result.current.openChildren(issues[0]))
    rerender({ projectId: 'q', view: 'board' })
    rerender({ projectId: 'p', view: 'board' })
    expect(result.current.value).toBe('m')
  })

  it('temporarily includes counted children and restores selection at the root in the same event', () => {
    const { result } = setup()
    act(() => result.current.select('m'))
    act(() => {
      result.current.openChildren(issues[0])
      result.current.changeParent('parent')
    })
    expect(result.current.value).toBe('all')
    expect(result.current.filteredIssues).toHaveLength(4)
    act(() => result.current.changeParent('other'))
    expect(result.current.value).toBe('all')
    act(() => result.current.changeParent(null))
    expect(result.current.value).toBe('m')
  })

  it('keeps selection when every counted child matches, ignoring inaccessible and archived children', () => {
    const { result } = setup([
      issues[0],
      issues[1],
      { ...issues[2], can_view_detail: false },
      { ...issues[3], parent_id: 'parent', archived_at: 'date' },
    ])
    act(() => result.current.select('m'))
    act(() => result.current.openChildren(issues[0]))
    expect(result.current.value).toBe('m')
  })

  it('respects explicit selection during drilldown, including no milestone', () => {
    const { result } = setup()
    act(() => result.current.select('m'))
    act(() => result.current.openChildren(issues[0]))
    act(() => result.current.select(null))
    act(() => result.current.changeParent(null))
    expect(result.current.value).toBeNull()
    act(() => result.current.openChildren(issues[0]))
    expect(result.current.value).toBe('all')
    act(() => result.current.changeParent(null))
    expect(result.current.value).toBeNull()
  })

  it('preserves the base selection in tables and clears temporary scope on project or view change', () => {
    const { result, rerender } = setup()
    act(() => result.current.select('m'))
    act(() => result.current.openChildren(issues[0]))
    rerender({ projectId: 'p', view: 'table' })
    expect(result.current.value).toBe('m')
    rerender({ projectId: 'p', view: 'board' })
    expect(result.current.value).toBe('m')
    act(() => result.current.openChildren(issues[0]))
    rerender({ projectId: 'q', view: 'board' })
    expect(result.current.value).toBe('all')
    rerender({ projectId: 'p', view: 'board' })
    expect(result.current.value).toBe('m')
    act(() => result.current.clear())
    expect(result.current.value).toBe('all')
  })
})

it('keeps navigation context when a filter excludes the current parent', () => {
  const parent = {
    ...issues[0],
    priority: 'medium',
    tags: [],
    sort_order: 0,
    created_at: '',
    updated_at: '',
  }
  const child = { ...parent, ...issues[2] }
  const onCurrentParentIdChange = vi.fn()
  const { result } = renderHook(() =>
    useStandardCloudBoardController({
      items: [child],
      hierarchyItems: [parent, child],
      currentParentId: parent.id,
      onCurrentParentIdChange,
      createColumns: () => [],
      extensions: { getSearchText: item => item.id },
      tagLimitError: 'tag limit',
      onMove: vi.fn(),
    })
  )
  expect(result.current.currentParent).toEqual(parent)
  expect(result.current.breadcrumb).toEqual([parent])
  act(() => result.current.setCurrentParentId(null))
  expect(onCurrentParentIdChange).toHaveBeenCalledWith(null)
})
