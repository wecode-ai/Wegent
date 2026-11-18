// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { act, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import type { CollaborationStatus } from '../types'
import {
  baseBoardStatusGroupingFlag,
  isBaseBoardStatusGroupingEnabled,
} from './baseBoardStatusGrouping'
import { savedBoardColumns, type ProjectBoardViews } from './projectBoardViews'
import { useSavedBoardViews } from './useSavedBoardViews'
import {
  createStandardCloudBoardColumns,
  useStandardCloudBoardController,
  type StandardCloudBoardItem,
} from './useStandardCloudBoardController'

const statuses: CollaborationStatus[] = [
  { id: 'inbox', name: '收集箱', color: 'gray' },
  { id: 'pending', name: '待开始', color: 'gray' },
  { id: 'in_progress', name: '进行中', color: 'blue' },
  { id: 'in_review', name: '待确认', color: 'purple' },
  { id: 'completed', name: '已完成', color: 'green' },
]
const stages = ['需求提出', '共同评审', '开发准备', '开发实现', '质量验收', '发布上线']
const groupStorageKey = 'test:board:group'
const cleanups: (() => void)[] = []

function fixture() {
  const views: ProjectBoardViews = {
    schema_version: 1,
    default_view_id: 'workflow',
    views: [
      {
        id: 'workflow',
        name: '协作流程',
        columns: [
          { id: 'workflow-inbox', type: 'status', value: 'inbox' },
          ...stages.map((value, index) => ({ id: `stage-${index}`, type: 'tag' as const, value })),
        ],
      },
    ],
  }
  const items: StandardCloudBoardItem[] = [
    {
      id: 'issue-qa',
      parent_id: null,
      status: 'in_progress',
      tags: ['质量验收', 'business'],
      priority: 'high',
      sort_order: 0,
      created_at: '2026-11-16T00:00:00Z',
      updated_at: '2026-11-17T00:00:00Z',
    },
  ]
  return {
    boardConfig: { group_by: 'tag' as const, statuses },
    views,
    items,
    save: vi.fn(async () => {}),
    onMove: vi.fn(),
  }
}

function useFixtureBoard(data: ReturnType<typeof fixture>, config?: ProjectBoardViews) {
  const views = useSavedBoardViews({
    projectKey: 'project',
    config,
    revision: 1,
    translate: createCollaborationTranslator('zh-CN'),
    save: data.save,
  })
  const createColumns = (groupBy: 'status' | 'priority' | 'assignee' | 'tag') =>
    createStandardCloudBoardColumns({
      groupBy,
      statuses: data.boardConfig.statuses,
      tags: stages,
      items: data.items,
      labels: { noPriority: '无优先级', noTag: '无标签', priority: {}, unassigned: '未分配' },
    })
  const board = useStandardCloudBoardController({
    baseBoardStatusGrouping: isBaseBoardStatusGroupingEnabled(),
    defaultGroupBy: data.boardConfig.group_by,
    defaultColumnSorts: views.view?.sorts,
    viewScope: `project:${views.selectedId}`,
    focusStorageKey: null,
    personalGroupStorageKey: groupStorageKey,
    personalSortStorageKey: `test:board:sort:${views.selectedId}`,
    view: views.view,
    items: data.items,
    extensions: { getSearchText: item => item.id },
    tagLimitError: '标签过多',
    onMove: data.onMove,
    createColumns: groupBy =>
      views.view
        ? savedBoardColumns(views.view, data.boardConfig.statuses, createColumns('status'))
        : createColumns(groupBy),
  })
  return { views, board }
}

function mount(data: ReturnType<typeof fixture>, config?: ProjectBoardViews) {
  const container = document.createElement('div')
  const root = createRoot(container)
  let current!: ReturnType<typeof useFixtureBoard>
  function Harness() {
    const value = useFixtureBoard(data, config)
    useLayoutEffect(() => {
      current = value
    })
    return null
  }
  act(() => root.render(<Harness />))
  cleanups.push(() => act(() => root.unmount()))
  return () => current
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
})

afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach(cleanup => cleanup())
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('base board status grouping', () => {
  it('projects the same issue into status and stage lanes without changing project data or preferences', () => {
    const data = fixture()
    const original = structuredClone({
      config: data.boardConfig,
      views: data.views,
      items: data.items,
    })
    localStorage.setItem(groupStorageKey, 'tag')
    const current = mount(data, data.views)

    expect(current().views.selectedId).toBe('workflow')
    expect(current().board.columns.map(column => column.label)).toEqual(['收集箱', ...stages])
    const stageLane = current().board.columns.find(column => column.groupValue === '质量验收')!
    expect(
      current()
        .board.getColumnItems(stageLane, current().board.state)
        .map(item => item.id)
    ).toEqual(['issue-qa'])
    act(() => current().board.state.selectColumnSort(stageLane.key, ['created-asc']))

    act(() => current().views.select('default'))
    expect(current().views.view).toBeNull()
    expect(current().board.state.groupBy).toBe('status')
    expect(current().board.columns.map(column => column.groupValue)).toEqual(
      statuses.map(status => status.id)
    )
    const activeLane = current().board.columns.find(column => column.groupValue === 'in_progress')!
    expect(
      current()
        .board.getColumnItems(activeLane, current().board.state)
        .map(item => item.id)
    ).toEqual(['issue-qa'])
    expect(current().board.state.getColumnSort(activeLane.key)).toEqual(['priority-desc'])
    act(() => current().board.state.selectColumnSort(activeLane.key, ['updated-asc']))
    act(() => current().board.state.selectGroupBy('priority'))
    expect(current().board.state.groupBy).toBe('status')

    act(() => current().views.select('workflow'))
    expect(current().board.state.getColumnSort(stageLane.key)).toEqual(['created-asc'])
    expect(current().board.columns.map(column => column.label)).toEqual(['收集箱', ...stages])
    act(() => current().views.select('default'))
    expect(current().board.state.getColumnSort(activeLane.key)).toEqual(['updated-asc'])
    expect(data.save).not.toHaveBeenCalled()
    expect(data.onMove).not.toHaveBeenCalled()
    expect({ config: data.boardConfig, views: data.views, items: data.items }).toEqual(original)
    expect(localStorage.getItem(groupStorageKey)).toBe('tag')
  })

  it('uses configured status order even when no saved views exist', () => {
    const data = fixture()
    data.boardConfig.statuses = [statuses[2], statuses[0], statuses[4], statuses[1], statuses[3]]
    localStorage.setItem(groupStorageKey, 'priority')
    const current = mount(data)

    expect(current().views.view).toBeNull()
    expect(current().board.state.groupBy).toBe('status')
    expect(current().board.columns.map(column => column.groupValue)).toEqual([
      'in_progress',
      'inbox',
      'completed',
      'pending',
      'in_review',
    ])
    expect(data.save).not.toHaveBeenCalled()
    expect(localStorage.getItem(groupStorageKey)).toBe('priority')
  })

  it.each(['tag', 'priority'] as const)(
    'restores cached %s grouping when the flag is disabled',
    groupBy => {
      localStorage.setItem(baseBoardStatusGroupingFlag, 'false')
      localStorage.setItem(groupStorageKey, groupBy)
      const data = fixture()
      const current = mount(data)

      expect(isBaseBoardStatusGroupingEnabled()).toBe(false)
      expect(current().board.state.groupBy).toBe(groupBy)
      expect(current().board.columns.map(column => column.key)).toContain(
        groupBy === 'tag' ? 'tag-business' : 'priority-urgent'
      )
      act(() => current().board.state.selectGroupBy('assignee'))
      expect(current().board.state.groupBy).toBe('assignee')
      expect(localStorage.getItem(groupStorageKey)).toBe('assignee')
      expect(data.boardConfig.group_by).toBe('tag')
      expect(data.save).not.toHaveBeenCalled()
    }
  )

  it('uses the saved project grouping during rollback when no personal grouping exists', () => {
    localStorage.setItem(baseBoardStatusGroupingFlag, 'false')
    const current = mount(fixture())
    expect(current().board.state.groupBy).toBe('tag')
  })
})
