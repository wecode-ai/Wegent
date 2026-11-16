// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { act, Children, useState, type ReactElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ProjectBoardColumnSortPicker } from './ProjectBoardColumnSortPicker'
import { ProjectBoardGroupPicker } from './ProjectBoardGroupPicker'
import { createProjectBoardSortLabels } from './projectBoardSorting'
import { ProjectBoardCardContext } from './projectBoardCardContext'
import { createCollaborationTranslator } from '../i18n'
import { KanbanBoard } from '../kanban/KanbanBoard'
import {
  ProjectBoardBody,
  ProjectBoardScrollArea,
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
    getColumnSort: () => ['priority-desc'],
    quickCreateStatus: null,
    scrollRef: { current: null },
    selectGroupBy: vi.fn(),
    selectColumnSort: vi.fn(),
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
    renderDragOverlay: () => null,
    renderExternalGroupPicker: () => null,
    renderGroupPicker: () => null,
    renderItem: () => null,
    renderSkeleton: () => null,
    rootLabel: 'Issue',
    rootUnitLabel: '个 Issue',
    translate: createCollaborationTranslator('zh-CN'),
    saveGlobalDisabled: false,
    saveGlobalLabel: '应用到全局',
    searchPlaceholder: '搜索 Issue',
    showQuickStart: false,
    showSaveGlobal: false,
    state: boardState(),
  }
}

describe('ProjectBoardBody', () => {
  it.each([false, true])('localizes group filters on English boards (external: %s)', external => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div')
    const root = createRoot(container)
    const options = props()
    const translate = createCollaborationTranslator('en')
    options.translate = translate
    options.isExternalBoard = external
    options.externalGroupLabel = 'Status'
    options.groupFields = [{ id: 'status', name: 'Status' }]
    options.columns = [
      { ...options.columns[0], label: 'Inbox' },
      {
        dotClass: 'bg-zinc-400',
        groupValue: 'in_progress',
        key: 'in_progress',
        label: 'In progress',
        status: 'in_progress',
      },
    ]
    options.focusLabels = {
      enter: translate('todo.focus_view_description'),
      exit: translate('todo.exit_focus_view_description'),
      title: translate('todo.focus_view'),
    }
    options.rootUnitLabel = translate('todo.board_issue_unit')
    try {
      act(() => root.render(<ProjectBoardBody {...options} />))
      const filter = container.querySelector<HTMLSelectElement>(
        external
          ? '[data-testid="dingtalk-board-assignee-filter"]'
          : '[data-testid="cloud-board-group-filter"]'
      )!
      expect(filter.options[0].textContent).toBe('All')
      expect(filter.closest('span, label')?.textContent).toContain('All Status')
      expect(filter.getAttribute('aria-label')).toBe('Filter group values')
      if (!external) {
        expect(
          container.querySelector('[data-testid="cloud-board-focus-running"]')?.textContent
        ).toBe('Focus view')
      }
      act(() => {
        filter.value = external ? '' : 'inbox'
        filter.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(
        external ? options.state.setExternalGroupFilter : options.state.setGroupFilter
      ).toHaveBeenCalledWith(external ? '' : 'inbox')
    } finally {
      act(() => root.unmount())
    }
  })

  it.each(['', 'removed-lane'])(
    'keeps filter names and icons independent from collapsible text (%s)',
    groupFilter => {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
      const container = document.createElement('div')
      const root = createRoot(container)
      const onChange = vi.fn()
      const options = props()
      options.state.groupFilter = groupFilter
      try {
        act(() =>
          root.render(
            <ProjectBoardBody
              {...options}
              renderGroupPicker={() => (
                <ProjectBoardGroupPicker
                  fields={[{ id: 'status', name: '状态' }]}
                  value="status"
                  onChange={onChange}
                  testIdPrefix="cloud-board-group"
                />
              )}
            />
          )
        )
        const group = container.querySelector('[data-testid="cloud-board-group-by"]')!
        expect(group.getAttribute('aria-label')).toBe('状态')
        expect(group.querySelector('.project-board-action-icon')).not.toBeNull()
        expect(group.querySelector('.project-board-action-label')?.textContent).toBe('状态')
        const filter = container.querySelector<HTMLSelectElement>(
          '[data-testid="cloud-board-group-filter"]'
        )!
        expect(filter.getAttribute('aria-label')).toBe('分组值筛选')
        expect(filter.value).toBe(groupFilter)
        expect(filter.closest('label')?.querySelector('.project-board-action-icon')).not.toBeNull()
        expect(
          filter.closest('label')?.querySelector('.project-board-action-label')?.textContent
        ).toBe(groupFilter || '全部状态')
        if (groupFilter) {
          act(() => {
            filter.value = ''
            filter.dispatchEvent(new Event('change', { bubbles: true }))
          })
          expect(options.state.setGroupFilter).toHaveBeenCalledWith('')
        }
        act(() => {
          filter.value = 'inbox'
          filter.dispatchEvent(new Event('change', { bubbles: true }))
        })
        expect(options.state.setGroupFilter).toHaveBeenCalledWith('inbox')
      } finally {
        act(() => root.unmount())
      }
    }
  )

  it('keeps fixed actions outside scrolling while sharing toolbar typography', () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      act(() =>
        root.render(
          <ProjectBoardBody
            {...props()}
            toolbarAction={<button data-testid="fixed-action">Chat</button>}
          />
        )
      )
      const scrolling = container.querySelector('[data-testid="cloud-board-toolbar"]')!
      const action = container.querySelector('[data-testid="fixed-action"]')!
      expect(scrolling.contains(action)).toBe(false)
      expect(action.closest('.project-board-toolbar')).toBe(
        scrolling.closest('.project-board-toolbar')
      )
      expect(action.closest('.project-board-toolbar')).not.toBeNull()
    } finally {
      act(() => root.unmount())
    }
  })

  it('distinguishes parents from standalone issues instead of calling every row an Issue', () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div'),
      root = createRoot(container)
    const options = props()
    options.parentRows = {
      rows: [
        {
          key: 'p',
          parentId: 'p',
          parent: { id: 'p' },
          items: new Map([['inbox', [{ id: 'child' }]]]),
          total: 1,
          completed: 0,
          running: 0,
        },
        {
          key: 'root',
          parentId: null,
          parent: null,
          items: new Map([['inbox', [{ id: 'standalone' }]]]),
          total: 1,
          completed: 0,
          running: 0,
        },
      ],
      translate: createCollaborationTranslator('zh-CN'),
      getParentKey: item => item.id,
      getParentTitle: item => item.id,
      onOpenParent: vi.fn(),
      onEnterParent: vi.fn(),
    }
    try {
      act(() => root.render(<ProjectBoardBody {...options} />))
      expect(container.textContent).toContain('1 个父事项 · 1 个独立事项')
      options.currentParentId = 'ancestor'
      options.currentParent = { id: 'ancestor', title: 'Ancestor' }
      options.parentRows.rows[1].parentId = 'ancestor'
      act(() => root.render(<ProjectBoardBody {...options} />))
      expect(container.textContent).toContain('1 个父事项 · 1 个直属子事项')
      expect(container.textContent).not.toContain('独立事项')
    } finally {
      act(() => root.unmount())
    }
  })
  it('opens column quick create and retains the create-first action in parent layout', () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div')
    const root = createRoot(container)
    const options = props()
    const createFirst = vi.fn()
    options.parentRows = {
      rows: [],
      translate: createCollaborationTranslator('zh-CN'),
      getParentKey: item => item.id,
      getParentTitle: item => item.id,
      onOpenParent: vi.fn(),
      onEnterParent: vi.fn(),
    }
    options.getColumnEmptyState = () => ({
      hint: 'Empty',
      action: {
        label: 'Create first',
        ariaLabel: 'Create first',
        onClick: createFirst,
      },
    })
    options.renderColumnHeaderActions = (_column, _items, state) => (
      <button data-testid="quick-add" onClick={() => state.setQuickCreateStatus('inbox')}>
        +
      </button>
    )
    options.renderColumnFooter = (_column, _items, state) =>
      state.quickCreateStatus === 'inbox' ? <input data-testid="quick-create-input" /> : null
    function Harness() {
      const [quickCreateStatus, setQuickCreateStatus] = useState<string | null>(null)
      return (
        <ProjectBoardBody
          {...options}
          state={{ ...options.state, quickCreateStatus, setQuickCreateStatus }}
        />
      )
    }
    try {
      act(() => root.render(<Harness />))
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[data-testid="cloud-todo-column-empty-add-inbox"]')!
          .click()
      )
      expect(createFirst).toHaveBeenCalledOnce()
      expect(container.querySelector('[data-testid="quick-create-input"]')).toBeNull()
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="quick-add"]')!.click())
      expect(container.querySelector('[data-testid="quick-create-input"]')).not.toBeNull()
    } finally {
      act(() => root.unmount())
    }
  })

  it('keeps card nodes mounted when successful drop feedback moves or clears', () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div')
    const root = createRoot(container)
    const options = props()
    options.renderItem = item => <button>{item.id}</button>
    const renderCards = () => {
      const board = descendants(ProjectBoardBody(options)).find(node => node.type === KanbanBoard)!
      act(() =>
        root.render(
          ['first', 'second'].map(id => (
            <div key={id}>{board.props.renderItem({ id }, options.columns[0])}</div>
          ))
        )
      )
    }
    try {
      renderCards()
      const cards = [...container.querySelectorAll('button')]
      for (const itemId of ['first', 'second', null]) {
        options.dropFeedback = itemId ? { itemId, columnKey: 'inbox', message: 'Moved' } : null
        renderCards()
        const current = [...container.querySelectorAll('button')]
        expect(current[0]).toBe(cards[0])
        expect(current[1]).toBe(cards[1])
        expect(
          container.querySelector('[data-testid="board-drop-highlight"]')?.textContent ?? null
        ).toBe(itemId)
      }
    } finally {
      act(() => root.unmount())
    }
  })

  it('scopes copies of the same Issue to their current group and column', () => {
    const options = props()
    options.state.groupBy = 'tag'
    const board = descendants(ProjectBoardBody(options)).find(node => node.type === KanbanBoard)!
    const item = { id: 'shared-issue' }
    const contexts = ['tag-backend', 'tag-shared'].map(columnKey => {
      const rendered = board.props.renderItem(item, {
        ...options.columns[0],
        key: columnKey,
      })
      expect(rendered.type).toBe(ProjectBoardCardContext.Provider)
      return rendered.props.value
    })
    expect(contexts).toEqual([
      { groupBy: 'tag', columnKey: 'tag-backend' },
      { groupBy: 'tag', columnKey: 'tag-shared' },
    ])
    options.state.groupBy = 'priority'
    expect(
      board.props.renderItem(item, {
        ...options.columns[0],
        key: 'priority-high',
      }).props.value
    ).toEqual({ groupBy: 'priority', columnKey: 'priority-high' })
  })

  it('renders sorting in each lane header and preserves existing header actions', () => {
    const options = props()
    options.sortLabels = createProjectBoardSortLabels(key => key)
    options.renderColumnHeaderActions = () => <button data-testid="existing-header-action" />
    const board = descendants(ProjectBoardBody(options)).find(node => node.type === KanbanBoard)!
    const header = board.props.renderColumnHeaderActions(options.columns[0], [])
    const picker = descendants(header).find(node => node.type === ProjectBoardColumnSortPicker)!
    expect(
      descendants(header).some(node => node.props['data-testid'] === 'existing-header-action')
    ).toBe(true)
    expect(picker.props.columnKey).toBe('inbox')
    expect(picker.props.value).toEqual(['priority-desc'])
    picker.props.onChange(['priority-desc', 'created-desc'])
    expect(options.state.selectColumnSort).toHaveBeenCalledWith('inbox', [
      'priority-desc',
      'created-desc',
    ])
    expect(options.state.selectGroupBy).not.toHaveBeenCalled()
    options.isExternalBoard = true
    const externalBoard = descendants(ProjectBoardBody(options)).find(
      node => node.type === KanbanBoard
    )!
    expect(
      descendants(externalBoard.props.renderColumnHeaderActions(options.columns[0], [])).some(
        node => node.type === ProjectBoardColumnSortPicker
      )
    ).toBe(false)
  })

  it('owns the original toolbar, breadcrumb, scroll viewport and Kanban composition', () => {
    const tree = ProjectBoardBody(props())
    const nodes = descendants(tree)

    expect(nodes.find(node => node.props['data-testid'] === 'cloud-board-toolbar')).toBeDefined()
    expect(
      nodes.find(node => node.props['data-testid'] === 'cloud-todo-board-breadcrumb')
    ).toBeDefined()
    expect(nodes.find(node => node.type === ProjectBoardScrollArea)).toBeDefined()
    expect(nodes.find(node => node.type === KanbanBoard)).toBeDefined()
  })

  it('owns the horizontal scroll viewport and visible scrollbar', () => {
    const tree = ProjectBoardScrollArea({
      children: <div>board</div>,
      viewportRef: { current: null },
    })
    const nodes = descendants(tree)

    expect(nodes.find(node => node.props['data-testid'] === 'cloud-board-scroll')).toBeDefined()
    expect(
      nodes.find(node => node.props['data-testid'] === 'cloud-board-scroll')?.props.className
    ).toContain('overflow-x-auto')
    expect(
      nodes.find(node => node.props['data-testid'] === 'cloud-board-scroll')?.props.className
    ).not.toContain('[&>div]')
  })
})

it('keeps project filters beside group filtering and before search and view actions', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() =>
      root.render(
        <ProjectBoardBody {...props()} filterAction={<select data-testid="milestone-filter" />} />
      )
    )
    const group = container.querySelector('[data-testid="cloud-board-group-filter"]')!
    const milestone = container.querySelector('[data-testid="milestone-filter"]')!
    const search = container.querySelector('[data-testid="cloud-board-search"]')!
    expect(group.compareDocumentPosition(milestone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      milestone.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  } finally {
    act(() => root.unmount())
  }
})
