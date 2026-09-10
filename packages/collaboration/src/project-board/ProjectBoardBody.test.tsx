// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Children, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { KanbanBoard } from '../kanban/KanbanBoard'
import {
  ProjectBoardBody,
  type ProjectBoardBodyProps,
  type ProjectBoardStatePort,
} from './ProjectBoardBody'

function descendants(node: ReactNode): ReactElement[] {
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as ReactElement
  return [element, ...Children.toArray(element.props.children).flatMap(child => descendants(child))]
}

function boardState(): ProjectBoardStatePort {
  return {
    externalGroupFilter: '',
    externalQuery: '',
    focusExecutionColumns: false,
    groupBy: 'status',
    groupFilter: '',
    query: '',
    quickCreateStatus: null,
    scrollRef: { current: null },
    selectGroupBy: vi.fn(),
    setExternalGroupFilter: vi.fn(),
    setExternalQuery: vi.fn(),
    setGroupFilter: vi.fn(),
    setQuery: vi.fn(),
    setQuickCreateStatus: vi.fn(),
    toggleFocusExecutionColumns: vi.fn(),
  }
}

function props(): ProjectBoardBodyProps<{ id: string }> {
  return {
    activeDragItemId: null,
    boardError: null,
    boardItemsLoading: false,
    breadcrumb: [],
    columns: [
      {
        dotClass: 'bg-zinc-400',
        groupValue: 'inbox',
        key: 'inbox',
        label: '收集箱',
        status: 'inbox',
      },
    ],
    currentParent: null,
    currentParentId: null,
    dnd: {
      DndContext: ({ children }) => children,
      DragOverlay: ({ children }) => children,
      useDroppable: () => ({ isOver: false, setNodeRef: vi.fn() }),
    },
    dndContextProps: {},
    externalGroupLabel: '记录',
    externalGroupValues: [],
    externalManagedLabel: '数据由钉钉托管 · AI 可直接管理',
    externalSearchPlaceholder: '搜索记录',
    focusLabels: { enter: '展开', exit: '退出', title: '专注视图' },
    getColumnDragHint: () => undefined,
    getColumnEmptyState: () => undefined,
    getColumnItems: () => [],
    getItemKey: item => item.id,
    groupFields: [{ id: 'status', name: '状态' }],
    isExternalBoard: false,
    isMyTasksBoard: false,
    layerCount: 0,
    onBreadcrumbSelect: vi.fn(),
    onSaveGlobalGroupBy: vi.fn(),
    renderAddIcon: () => null,
    renderChevronDown: () => null,
    renderChevronRight: () => null,
    renderDragOverlay: () => null,
    renderExternalGroupPicker: () => null,
    renderFocusIcon: () => null,
    renderGroupPicker: () => null,
    renderItem: () => null,
    renderSearchIcon: () => null,
    renderSkeleton: () => null,
    renderTooltip: (_label, child) => child,
    rootLabel: 'Issue',
    rootUnitLabel: '个 Issue',
    saveGlobalDisabled: false,
    saveGlobalLabel: '应用到全局',
    searchPlaceholder: '搜索 Issue',
    showQuickStart: false,
    showSaveGlobal: false,
    state: boardState(),
  }
}

describe('ProjectBoardBody', () => {
  it('owns the original toolbar, breadcrumb, scroll viewport and Kanban composition', () => {
    const tree = ProjectBoardBody(props())
    const nodes = descendants(tree)

    expect(nodes.find(node => node.props['data-testid'] === 'cloud-board-toolbar')).toBeDefined()
    expect(
      nodes.find(node => node.props['data-testid'] === 'cloud-todo-board-breadcrumb')
    ).toBeDefined()
    expect(nodes.find(node => node.props['data-testid'] === 'cloud-board-scroll')).toBeDefined()
    expect(nodes.find(node => node.type === KanbanBoard)).toBeDefined()
  })
})
