// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  CollaborationApp,
  type CollaborationHostAdapter,
  type CollaborationIssue,
  type CollaborationProject,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'

const statuses = [
  { id: 'inbox', name: '收集箱', color: 'gray' as const },
  { id: 'pending', name: '待开始', color: 'blue' as const },
  { id: 'in_progress', name: '进行中', color: 'orange' as const },
  { id: 'in_review', name: '待确认', color: 'purple' as const },
  { id: 'completed', name: '已完成', color: 'green' as const },
]

type GroupBy = 'status' | 'priority' | 'assignee' | 'tag'

function project(groupBy: GroupBy = 'status'): CollaborationProject {
  return {
    id: 'project-1',
    public_id: 'WEB',
    project_key: 'WEB',
    name: 'Web 协作项目',
    description: '共享项目壳与看板',
    project_store: 'backend',
    task_provider: 'native',
    provider_config: {},
    current_user_id: 1,
    access_role: 'Owner',
    board_config: {
      group_by: groupBy,
      processing_start_status_id: 'in_progress',
      statuses,
    },
    card_display: {
      show_assignee: true,
      show_priority: true,
      show_tags: true,
      show_date: true,
    },
    created_by_user_id: 1,
    status: 'active',
    tags: ['后端'],
    version: 1,
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
  }
}

function issue(): CollaborationIssue {
  return {
    id: 'issue-1',
    cloud_project_id: 'project-1',
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: 1,
    assignee_name: '协作者',
    title: '共享看板任务',
    description: '只能由共享看板渲染',
    status: 'pending',
    priority: 'high',
    due_at: null,
    tags: ['共享'],
    sort_order: 0,
    version: 1,
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
    completed_at: null,
    can_edit: true,
    is_unread: true,
  }
}

function personalBoardFixture(overrides: Partial<CollaborationProject> = {}) {
  const currentProject = { ...project(), access_role: 'Developer' as const, ...overrides }
  const updateProject = jest.fn().mockRejectedValue({ status: 403 })
  const notify = jest.fn()
  const items = [
    { ...issue(), cloud_project_id: currentProject.id },
    {
      ...issue(),
      id: 'issue-2',
      cloud_project_id: currentProject.id,
      sequence_number: 2,
      title: '另一位协作者的任务',
      assignee_user_id: 2,
      assignee_name: '第二位协作者',
    },
  ]
  const api = {
    projects: {
      get: jest.fn().mockResolvedValue(currentProject),
      update: updateProject,
      listExecutionEnvironments: jest.fn().mockResolvedValue([]),
    },
    issues: {
      getBoardSnapshot: jest.fn().mockResolvedValue({
        items,
        members: [
          { id: 1, user_id: 1, user_name: '协作者', email: null, role: 'Developer' },
          { id: 2, user_id: 2, user_name: '第二位协作者', email: null, role: 'Developer' },
        ],
        agents: [],
        taskBindings: [],
      }),
    },
  } as unknown as SharedWorkspaceApi
  const host: CollaborationHostAdapter = {
    capabilities: { automation: true, dingtalkAitable: false },
    location: { projectId: currentProject.id, issueId: null, view: 'board' },
    navigate: jest.fn(),
    notify,
  }
  return { api, host, updateProject, notify }
}

function selectBoardGroup(groupBy: GroupBy) {
  fireEvent.click(screen.getByTestId('cloud-board-group-by'))
  fireEvent.click(screen.getByTestId(`cloud-board-group-option-${groupBy}`))
}

class BoardPointerEvent extends MouseEvent {
  readonly isPrimary = true
  readonly pointerId = 1
}

async function dragCardTo(card: HTMLElement, target: HTMLElement) {
  const originalPointerEvent = window.PointerEvent
  window.PointerEvent = BoardPointerEvent as unknown as typeof PointerEvent
  const rect = jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const x = target.contains(this) ? 400 : 0
      return {
        x,
        y: 0,
        left: x,
        top: 0,
        right: x + 280,
        bottom: 200,
        width: 280,
        height: 200,
        toJSON() {},
      }
    })
  try {
    const handle = card.querySelector<HTMLElement>('[data-testid^="cloud-todo-card-"]')!
    fireEvent.pointerDown(handle, { clientX: 20, clientY: 20, button: 0 })
    fireEvent.pointerMove(document, { clientX: 30, clientY: 20 })
    expect(await screen.findByTestId('project-board-drag-overlay')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-unread-issue-1')).not.toBeInTheDocument()
    fireEvent.pointerMove(document, { clientX: 420, clientY: 20 })
    await act(async () => {
      fireEvent.pointerUp(document, { clientX: 420, clientY: 20 })
      // dnd-kit suppresses the click after a drop for 50ms.
      await new Promise(resolve => window.setTimeout(resolve, 50))
    })
    await waitFor(() =>
      expect(screen.queryByTestId('project-board-drag-overlay')).not.toBeInTheDocument()
    )
  } finally {
    rect.mockRestore()
    window.PointerEvent = originalPointerEvent
  }
}

describe('CollaborationApp shared project board', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: {
        configurable: true,
        value() {
          this.open = true
        },
      },
      close: {
        configurable: true,
        value() {
          this.open = false
        },
      },
    })
  })
  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
  })

  it('edits the selected mixed view from board settings without changing the default workflow', async () => {
    const currentProject: CollaborationProject = {
      ...project(),
      tags: ['bug'],
      board_views: {
        schema_version: 1,
        views: [
          {
            id: 'mixed',
            name: '测试视图',
            columns: [
              { id: 'inbox', type: 'status', value: 'inbox' },
              { id: 'test', type: 'tag', value: '测试' },
              { id: 'bug', type: 'tag', value: 'bug' },
            ],
            filter: { tags: ['需求'] },
          },
        ],
      },
    }
    const update = jest.fn().mockImplementation(async (_id, values) => ({
      ...currentProject,
      board_views: values.boardViews,
      version: 2,
    }))
    const api = {
      projects: {
        get: jest.fn().mockResolvedValue(currentProject),
        update,
        listExecutionEnvironments: jest.fn().mockResolvedValue([]),
      },
      issues: {
        getBoardSnapshot: jest
          .fn()
          .mockResolvedValue({ items: [issue()], members: [], taskBindings: [] }),
      },
      members: { list: jest.fn().mockResolvedValue([]) },
      agents: { list: jest.fn().mockResolvedValue([]) },
    } as unknown as SharedWorkspaceApi
    const host: CollaborationHostAdapter = {
      capabilities: { automation: true, dingtalkAitable: false },
      location: { projectId: currentProject.id, issueId: null, view: 'board' },
      navigate: jest.fn(),
    }
    const { rerender } = render(
      <CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />
    )
    fireEvent.click(await screen.findByTestId('board-view-picker'))
    fireEvent.click(screen.getByTestId('board-view-mixed'))
    fireEvent.click(screen.getByTestId('board-view-picker'))
    fireEvent.click(screen.getByTestId('board-view-edit'))
    expect(screen.getByTestId('board-view-name')).toHaveValue('测试视图')
    expect(screen.getByTestId('board-view-lane-value-1')).toHaveTextContent('测试')
    expect(screen.queryByTestId('project-board-settings-dialog')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('board-view-name'), { target: { value: '已修改视图' } })
    fireEvent.click(screen.getByTestId('board-view-save'))
    await waitFor(() => expect(screen.queryByTestId('board-view-editor')).not.toBeInTheDocument())
    expect(update).toHaveBeenCalledWith(currentProject.id, {
      version: 1,
      cardDisplay: currentProject.card_display,
      boardViews: {
        ...currentProject.board_views,
        views: [
          {
            ...currentProject.board_views!.views[0],
            name: '已修改视图',
            filter: { tags: ['需求'], match: 'all' },
          },
        ],
      },
    })
    fireEvent.click(screen.getByTestId('board-view-picker'))
    fireEvent.click(screen.getByTestId('board-view-default'))
    fireEvent.click(screen.getByTestId('board-view-picker'))
    fireEvent.click(screen.getByTestId('board-view-edit'))
    expect(await screen.findByTestId('board-view-editor')).toBeVisible()
    expect(screen.getByTestId('cloud-board-status-in_progress')).toHaveTextContent('进行中')
    fireEvent.click(screen.getByTestId('board-view-close'))
    rerender(
      <CollaborationApp
        api={api}
        host={{ ...host, location: { ...host.location, view: 'manage' } }}
        locale="zh-CN"
        pollIntervalMs={0}
      />
    )
    fireEvent.click(await screen.findByTestId('cloud-project-manage-tags-toggle'))
    for (const tag of ['bug', '测试', '需求', '共享']) {
      expect(await screen.findByTestId(`cloud-project-tag-${tag}`)).toBeVisible()
    }
  })

  it('shows an actionable runner denial and leaves the card in its persisted lane', async () => {
    const current = {
      ...issue(),
      status: 'inbox',
      assignee_user_id: null,
      assignee_agent_id: 'agent-1',
    }
    const update = jest.fn().mockRejectedValue(
      Object.assign(new Error('No execution environment is authorized for this selection'), {
        errorCode: 'RUNNER_ENVIRONMENT_UNAVAILABLE',
      })
    )
    const api = {
      projects: {
        get: jest.fn().mockResolvedValue(project()),
        listExecutionEnvironments: jest.fn().mockResolvedValue([]),
      },
      issues: {
        getBoardSnapshot: jest
          .fn()
          .mockResolvedValue({ items: [current], members: [], taskBindings: [] }),
        update,
      },
      members: { list: jest.fn().mockResolvedValue([]) },
      agents: { list: jest.fn().mockResolvedValue([]) },
    } as unknown as SharedWorkspaceApi
    const host: CollaborationHostAdapter = {
      capabilities: { automation: true, dingtalkAitable: false },
      location: { projectId: 'project-1', issueId: null, view: 'board' },
      navigate: jest.fn(),
    }
    render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)
    const card = await screen.findByTestId('collaboration-issue-issue-1')
    await dragCardTo(card, screen.getByTestId('cloud-todo-column-dropzone-in_progress'))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        '机器人没有符合配置且获项目授权的执行环境'
      )
    )
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith(current.id, {
      version: 1,
      status: 'in_progress',
      position: { beforeItemId: null },
    })
    expect(card.closest('[data-testid="cloud-todo-column-inbox"]')).not.toBeNull()
    expect(screen.queryByTestId('board-drop-feedback')).not.toBeInTheDocument()
  })

  it.each(['Developer', 'Viewer'] as const)(
    'lets a %s filter their assigned issues without changing the project',
    async role => {
      const { api, host, updateProject, notify } = personalBoardFixture({ access_role: role })
      render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)
      expect(await screen.findByTestId('collaboration-issue-issue-1')).toBeInTheDocument()

      selectBoardGroup('assignee')

      expect(updateProject).not.toHaveBeenCalled()
      expect(notify).not.toHaveBeenCalled()
      expect(screen.queryByText('保存失败，请重试')).not.toBeInTheDocument()
      fireEvent.change(screen.getByTestId('cloud-board-group-filter'), {
        target: { value: 'assignee-1' },
      })
      expect(screen.getByTestId('collaboration-issue-issue-1')).toBeInTheDocument()
      expect(screen.queryByTestId('collaboration-issue-issue-2')).not.toBeInTheDocument()
      fireEvent.change(screen.getByTestId('cloud-board-group-filter'), {
        target: { value: '' },
      })
      expect(screen.getByTestId('collaboration-issue-issue-2')).toBeInTheDocument()
    }
  )

  it('restores personal grouping after reopening without changing the shared default', async () => {
    const { api, host, updateProject } = personalBoardFixture()
    const board = render(
      <CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />
    )
    await screen.findByTestId('collaboration-issue-issue-1')
    selectBoardGroup('assignee')
    board.unmount()

    render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)

    expect(await screen.findByTestId('cloud-todo-column-assignee-1')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-column-assignee-2')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-column-pending')).not.toBeInTheDocument()
    expect(updateProject).not.toHaveBeenCalled()
    expect((await api.projects.get('project-1')).board_config?.group_by).toBe('status')
  })

  it.each([
    { label: 'user', overrides: { current_user_id: 2 } },
    { label: 'project', overrides: { id: 'project-2' } },
    { label: 'project store', overrides: { project_store: 'local' as const } },
  ])('keeps personal grouping isolated by $label', async ({ overrides }) => {
    const original = personalBoardFixture()
    const board = render(
      <CollaborationApp api={original.api} host={original.host} locale="zh-CN" pollIntervalMs={0} />
    )
    await screen.findByTestId('collaboration-issue-issue-1')
    selectBoardGroup('assignee')
    board.unmount()
    const other = personalBoardFixture(overrides)

    render(<CollaborationApp api={other.api} host={other.host} locale="zh-CN" pollIntervalMs={0} />)

    expect(await screen.findByTestId('cloud-todo-column-pending')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-column-assignee-1')).not.toBeInTheDocument()
    expect(original.updateProject).not.toHaveBeenCalled()
    expect(other.updateProject).not.toHaveBeenCalled()
  })

  it('preserves personal grouping when an owner saves shared card settings', async () => {
    const { api, host, updateProject } = personalBoardFixture({ access_role: 'Owner' })
    api.members = {
      list: jest.fn().mockResolvedValue([]),
      searchUsers: jest.fn().mockResolvedValue([]),
      add: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    }
    api.agents = {
      list: jest.fn().mockResolvedValue([]),
    } as unknown as SharedWorkspaceApi['agents']
    updateProject.mockImplementation(async (_id, values) => ({
      ...project('priority'),
      board_views: values.boardViews,
      card_display: { ...project().card_display!, show_priority: false },
      version: 2,
    }))
    render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)
    await screen.findByTestId('collaboration-issue-issue-1')
    selectBoardGroup('assignee')
    expect(updateProject).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('board-view-picker'))
    fireEvent.click(screen.getByTestId('board-view-edit'))
    fireEvent.click(await screen.findByTestId('cloud-board-display-menu'))
    fireEvent.click(screen.getByTestId('cloud-board-display-priority'))
    expect(updateProject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('board-view-save'))

    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith(
        'project-1',
        expect.objectContaining({
          version: 1,
          cardDisplay: expect.objectContaining({ show_priority: false }),
        })
      )
    )
    await waitFor(() => expect(screen.queryByTestId('board-view-editor')).not.toBeInTheDocument())
    expect(screen.getByTestId('cloud-todo-column-assignee-1')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-column-priority-high')).not.toBeInTheDocument()
    expect(updateProject).toHaveBeenCalledTimes(1)
  })

  it('keeps lane rules isolated when accounts switch in the same browser', async () => {
    const legacyKey = 'collaboration-board-column-sort:v2:project-1'
    localStorage.setItem(legacyKey, JSON.stringify({ '["status","pending"]': [] }))
    const mountAccount = async (userId: number | undefined) => {
      const api = {
        projects: {
          get: jest.fn().mockResolvedValue({ ...project(), current_user_id: userId }),
          listExecutionEnvironments: jest.fn().mockResolvedValue([]),
        },
        issues: {
          getBoardSnapshot: jest.fn().mockResolvedValue({
            items: [issue()],
            members: [],
            taskBindings: [],
          }),
        },
        members: { list: jest.fn().mockResolvedValue([]) },
        agents: { list: jest.fn().mockResolvedValue([]) },
      } as unknown as SharedWorkspaceApi
      const host: CollaborationHostAdapter = {
        capabilities: { automation: true, dingtalkAitable: false },
        location: { projectId: 'project-1', issueId: null, view: 'board' },
        navigate: jest.fn(),
      }
      const view = render(
        <CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />
      )
      const sort = await screen.findByTestId('cloud-board-sort-by-pending')
      return { ...view, sort }
    }

    const first = await mountAccount(1)
    expect(first.sort).toHaveAttribute('data-sort-rules', 'priority-desc')
    fireEvent.click(first.sort)
    fireEvent.click(screen.getByTestId('cloud-board-sort-by-pending-manual'))
    first.unmount()

    const second = await mountAccount(2)
    expect(second.sort).toHaveAttribute('data-sort-rules', 'priority-desc')
    fireEvent.click(second.sort)
    fireEvent.click(screen.getByTestId('cloud-board-sort-by-pending-add'))
    second.unmount()

    const firstRestored = await mountAccount(1)
    expect(firstRestored.sort).toHaveAttribute('data-sort-rules', 'manual')
    firstRestored.unmount()
    const secondRestored = await mountAccount(2)
    expect(secondRestored.sort).toHaveAttribute('data-sort-rules', 'priority-desc,created-desc')
    secondRestored.unmount()

    const localAccount = await mountAccount(0)
    fireEvent.click(localAccount.sort)
    fireEvent.click(screen.getByTestId('cloud-board-sort-by-pending-manual'))
    localAccount.unmount()
    const localRestored = await mountAccount(0)
    expect(localRestored.sort).toHaveAttribute('data-sort-rules', 'manual')
    localRestored.unmount()

    const unknownAccount = await mountAccount(undefined)
    expect(unknownAccount.sort).toHaveAttribute('data-sort-rules', 'priority-desc')
    fireEvent.click(unknownAccount.sort)
    fireEvent.click(screen.getByTestId('cloud-board-sort-by-pending-manual'))
    expect(Object.keys(localStorage).sort()).toEqual([
      'collaboration-board-column-sort:v2:0:project-1:["status","pending"]',
      'collaboration-board-column-sort:v2:1:project-1:["status","pending"]',
      'collaboration-board-column-sort:v2:2:project-1:["status","pending"]',
      legacyKey,
    ])
  })

  it('keeps saved views available on empty projects and shows their configured columns', async () => {
    const currentProject = {
      ...project('priority'),
      board_views: {
        schema_version: 1,
        views: [
          {
            id: 'mixed',
            name: 'Empty mixed view',
            columns: [
              { id: 'done', type: 'status' as const, value: 'completed' },
              { id: 'tag', type: 'tag' as const, value: '后端' },
            ],
          },
        ],
      },
    }
    const update = jest.fn()
    const api = {
      projects: {
        get: jest.fn().mockResolvedValue(currentProject),
        update,
        listExecutionEnvironments: jest.fn().mockResolvedValue([]),
      },
      issues: {
        getBoardSnapshot: jest.fn().mockResolvedValue({ items: [], members: [], taskBindings: [] }),
      },
      members: { list: jest.fn().mockResolvedValue([]) },
      agents: { list: jest.fn().mockResolvedValue([]) },
    } as unknown as SharedWorkspaceApi
    const host: CollaborationHostAdapter = {
      capabilities: { automation: true, dingtalkAitable: false },
      location: { projectId: currentProject.id, issueId: null, view: 'board' },
      navigate: jest.fn(),
    }
    render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)
    expect(await screen.findByTestId('collaboration-empty-project')).toBeVisible()
    fireEvent.click(screen.getByTestId('board-view-picker'))
    expect(screen.getByTestId('board-view-new')).toBeVisible()
    fireEvent.click(screen.getByTestId('board-view-mixed'))
    expect(screen.queryByTestId('collaboration-empty-project')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-column-done')).toHaveTextContent('已完成')
    expect(screen.getByTestId('cloud-todo-column-tag')).toHaveTextContent('后端')
    expect(screen.queryByTestId('cloud-todo-column-priority-high')).not.toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'renders the shared board without unread indicators (runtime=%s)',
    async withRuntime => {
      const currentProject = project()
      const updateProject = jest.fn().mockResolvedValue(project('priority'))
      const updateIssue = jest
        .fn()
        .mockResolvedValue({ ...issue(), status: 'completed', version: 2 })
      const reorderIssue = jest
        .fn()
        .mockResolvedValue([{ ...issue(), status: 'completed', version: 2 }])
      const api = {
        runtime: withRuntime ? { work: {} } : undefined,
        projects: {
          get: jest.fn().mockResolvedValue(currentProject),
          update: updateProject,
          listExecutionEnvironments: jest.fn().mockResolvedValue([]),
        },
        issues: {
          getBoardSnapshot: jest.fn().mockResolvedValue({
            items: [
              { ...issue(), id: 'normal', title: '普通任务', priority: 'none', sort_order: -1 },
              issue(),
              { ...issue(), id: 'urgent', title: '紧急任务', priority: 'urgent', sort_order: 1 },
            ],
            members: [],
            taskBindings: [],
          }),
          update: updateIssue,
          reorder: reorderIssue,
        },
        members: {
          list: jest.fn().mockResolvedValue([]),
          searchUsers: jest.fn().mockResolvedValue([]),
          add: jest.fn(),
          update: jest.fn(),
          remove: jest.fn(),
        },
        agents: {
          list: jest.fn().mockResolvedValue([]),
        },
      } as unknown as SharedWorkspaceApi
      const host: CollaborationHostAdapter = {
        capabilities: {
          automation: true,
          dingtalkAitable: false,
        },
        location: {
          projectId: currentProject.id,
          issueId: null,
          view: 'board',
        },
        navigate: jest.fn(),
      }

      render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)

      expect(await screen.findByTestId('cloud-project-header')).toBeInTheDocument()
      expect(screen.getByTestId('cloud-project-header-title')).toHaveTextContent('Web 协作项目')
      expect(screen.getByTestId('collaboration-board')).toHaveClass(
        'flex',
        'min-h-0',
        'min-w-0',
        'flex-1',
        'flex-col'
      )
      expect(screen.getByTestId('cloud-board-toolbar')).toBeInTheDocument()
      const sort = screen.getByTestId('cloud-board-sort-by-pending')
      const cardOrder = () =>
        Array.from(
          screen
            .getByTestId('cloud-todo-column-pending')
            .querySelectorAll('article[data-testid^="collaboration-issue-"]')
        ).map(card => card.getAttribute('data-testid'))
      expect(sort).toHaveAccessibleName('待开始 · 排序方式')
      expect(sort).toHaveAttribute('data-sort-rules', 'priority-desc')
      expect(cardOrder()).toEqual([
        'collaboration-issue-urgent',
        'collaboration-issue-issue-1',
        'collaboration-issue-normal',
      ])
      fireEvent.click(sort)
      fireEvent.click(screen.getByTestId('cloud-board-sort-by-pending-manual'))
      fireEvent.click(sort)
      expect(cardOrder()).toEqual([
        'collaboration-issue-normal',
        'collaboration-issue-issue-1',
        'collaboration-issue-urgent',
      ])
      expect(
        JSON.parse(
          localStorage.getItem(
            'collaboration-board-column-sort:v2:1:project-1:["status","pending"]'
          )!
        )
      ).toEqual([])
      const completedSort = screen.getByTestId('cloud-board-sort-by-completed')
      expect(completedSort).toHaveAttribute('data-sort-rules', 'priority-desc')
      fireEvent.click(completedSort)
      fireEvent.click(screen.getByTestId('cloud-board-sort-by-completed-add'))
      fireEvent.click(completedSort)
      expect(completedSort).toHaveAttribute('data-sort-rules', 'priority-desc,created-desc')
      expect(sort).toHaveAttribute('data-sort-rules', 'manual')
      fireEvent.click(sort)
      fireEvent.click(screen.getByTestId('cloud-board-sort-by-pending-add'))
      fireEvent.click(sort)
      expect(updateProject).not.toHaveBeenCalled()
      expect(updateIssue).not.toHaveBeenCalled()
      expect(screen.queryByTestId('collaboration-board-settings')).not.toBeInTheDocument()
      expect(screen.getByTestId('cloud-board-view-actions')).toContainElement(
        screen.getByTestId('board-view-picker')
      )
      expect(screen.getByTestId('cloud-board-view-actions')).toContainElement(
        screen.getByTestId('cloud-board-focus-running')
      )
      for (const status of statuses) {
        expect(screen.getByTestId(`cloud-todo-column-${status.id}`)).toBeInTheDocument()
      }
      expect(screen.getByTestId('collaboration-issue-issue-1')).toHaveTextContent('共享看板任务')
      expect(screen.queryByTestId('cloud-todo-card-unread-issue-1')).not.toBeInTheDocument()
      expect(screen.getByTestId('collaboration-issue-issue-1')).not.toHaveClass('bg-focus/10')

      await dragCardTo(
        screen.getByTestId('collaboration-issue-issue-1'),
        screen.getByTestId('cloud-todo-column-dropzone-completed')
      )
      await waitFor(() =>
        expect(updateIssue).toHaveBeenCalledWith('issue-1', {
          version: 1,
          status: 'completed',
          position: { beforeItemId: null },
        })
      )
      expect(reorderIssue).not.toHaveBeenCalled()
      expect(api.issues.getBoardSnapshot).toHaveBeenCalledTimes(2)

      fireEvent.click(screen.getByTestId('board-view-picker'))
      fireEvent.click(screen.getByTestId('board-view-edit'))
      expect(await screen.findByTestId('board-view-editor')).toHaveAccessibleName('看板设置')
      fireEvent.click(screen.getByTestId('board-view-close'))
      await waitFor(() => expect(screen.queryByTestId('board-view-editor')).not.toBeInTheDocument())

      fireEvent.change(screen.getByTestId('cloud-board-search'), {
        target: { value: '不存在的任务' },
      })
      expect(screen.queryByTestId('collaboration-issue-issue-1')).not.toBeInTheDocument()

      fireEvent.click(screen.getByTestId('cloud-board-group-by'))
      fireEvent.click(screen.getByTestId('cloud-board-group-option-priority'))
      expect(screen.getByTestId('cloud-todo-column-priority-high')).toBeInTheDocument()
      expect(updateProject).not.toHaveBeenCalled()
    }
  )

  it.each([
    {
      groupBy: 'priority' as const,
      target: 'cloud-todo-column-dropzone-priority-urgent',
      configure: (api: { update: jest.Mock; assign: jest.Mock; reorder: jest.Mock }) => ({
        assert: () =>
          expect(api.update).toHaveBeenCalledWith('issue-1', {
            version: 1,
            priority: 'urgent',
            position: { beforeItemId: null },
          }),
      }),
    },
    {
      groupBy: 'assignee' as const,
      target: 'cloud-todo-column-dropzone-assignee-2',
      configure: (api: { update: jest.Mock; assign: jest.Mock; reorder: jest.Mock }) => ({
        assert: () =>
          expect(api.assign).toHaveBeenCalledWith('project-1', 'issue-1', {
            version: 1,
            assigneeType: 'user',
            assigneeId: '2',
            notifyAssignee: true,
            position: { beforeItemId: null },
          }),
      }),
    },
    {
      groupBy: 'tag' as const,
      target: 'cloud-todo-column-dropzone-tag-后端',
      configure: (api: { update: jest.Mock; assign: jest.Mock; reorder: jest.Mock }) => ({
        assert: () =>
          expect(api.update).toHaveBeenCalledWith('issue-1', {
            version: 1,
            tags: ['后端'],
            position: { beforeItemId: null },
          }),
      }),
    },
  ])('persists $groupBy drops through the shared mutation model', async scenario => {
    const currentProject = project(scenario.groupBy)
    const update = jest.fn().mockImplementation(async (_id, input) => ({
      ...issue(),
      priority: input.priority ?? issue().priority,
      tags: input.tags ?? issue().tags,
    }))
    const assign = jest.fn().mockResolvedValue({
      ...issue(),
      assignee_user_id: 2,
      assignee_name: '第二位协作者',
    })
    const reorder = jest.fn()
    const api = {
      projects: {
        get: jest.fn().mockResolvedValue(currentProject),
        listExecutionEnvironments: jest.fn().mockResolvedValue([]),
      },
      issues: {
        getBoardSnapshot: jest.fn().mockResolvedValue({
          items: [issue()],
          members: [
            {
              id: 2,
              user_id: 2,
              user_name: '第二位协作者',
              email: null,
              role: 'Member',
            },
          ],
          agents: [],
          taskBindings: [],
        }),
        update,
        assign,
        reorder,
      },
    } as unknown as SharedWorkspaceApi
    const host: CollaborationHostAdapter = {
      capabilities: {
        automation: true,
        dingtalkAitable: false,
      },
      location: {
        projectId: currentProject.id,
        issueId: null,
        view: 'board',
      },
      navigate: jest.fn(),
    }

    render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)

    const card = await screen.findByTestId('collaboration-issue-issue-1')
    await dragCardTo(card, screen.getByTestId(scenario.target))

    const assertion = scenario.configure({ update, assign, reorder })
    await waitFor(assertion.assert)
  })

  it.each(['priority', 'assignee', 'tag'] as const)(
    'saves manual %s ordering without mutating Issue fields',
    async groupBy => {
      const currentProject = project(groupBy)
      const first = issue()
      const second = { ...first, id: 'second', status: 'completed', sort_order: 1 }
      const update = jest.fn().mockImplementation(async () => reordered[0])
      const assign = jest.fn()
      const reordered = [
        { ...second, sort_order: 0, version: 2 },
        { ...first, sort_order: 1, version: 2 },
      ]
      const reorder = jest.fn().mockResolvedValue(reordered)
      const api = {
        projects: {
          get: jest.fn().mockResolvedValue(currentProject),
          listExecutionEnvironments: jest.fn().mockResolvedValue([]),
        },
        issues: {
          getBoardSnapshot: jest.fn().mockImplementation(async () => ({
            items: update.mock.calls.length ? reordered : [first, second],
            members: [],
            agents: [],
            taskBindings: [],
          })),
          update,
          assign,
          reorder,
        },
      } as unknown as SharedWorkspaceApi
      const host: CollaborationHostAdapter = {
        capabilities: { automation: true, dingtalkAitable: false },
        location: { projectId: currentProject.id, issueId: null, view: 'board' },
        navigate: jest.fn(),
      }
      render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)
      const lane =
        groupBy === 'priority'
          ? 'priority-high'
          : groupBy === 'assignee'
            ? 'assignee-1'
            : 'tag-共享'
      const sort = await screen.findByTestId(`cloud-board-sort-by-${lane}`)
      fireEvent.click(sort)
      fireEvent.click(screen.getByTestId(`cloud-board-sort-by-${lane}-manual`))
      fireEvent.click(sort)
      await dragCardTo(
        screen.getByTestId('collaboration-issue-second'),
        screen.getByTestId('collaboration-issue-issue-1')
      )
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith('second', {
          version: second.version,
          position: { beforeItemId: first.id },
        })
      )
      expect(reorder).not.toHaveBeenCalled()
      expect(assign).not.toHaveBeenCalled()
      await waitFor(() =>
        expect(
          screen.getByTestId(`cloud-todo-column-${lane}`).querySelector('article')
        ).toHaveAttribute('data-testid', 'collaboration-issue-second')
      )
    }
  )

  it('loads and renders all paged GitHub board statuses through the shared API', async () => {
    const externalProject = {
      ...project(),
      task_provider: 'github' as const,
    }
    const pendingIssue = {
      ...issue(),
      id: 'github-pending-1',
      status: 'pending',
      title: 'GitHub 第一页 Issue',
    }
    const nextPendingIssue = {
      ...issue(),
      id: 'github-pending-2',
      status: 'pending',
      title: 'GitHub 第二页 Issue',
    }
    const completedIssue = {
      ...issue(),
      id: 'github-completed-1',
      status: 'completed',
      title: 'GitHub 已完成 Issue',
    }
    const listPage = jest.fn(
      async (_projectId: string, input: { status: string; cursor?: string | null }) => {
        if (input.status === 'pending' && !input.cursor) {
          return {
            items: [pendingIssue],
            nextCursor: 'pending-page-2',
            taskBindings: [],
          }
        }
        if (input.status === 'pending' && input.cursor === 'pending-page-2') {
          return {
            items: [nextPendingIssue],
            nextCursor: null,
            taskBindings: [],
          }
        }
        if (input.status === 'completed') {
          return {
            items: [completedIssue],
            nextCursor: null,
            taskBindings: [],
          }
        }
        return { items: [], nextCursor: null, taskBindings: [] }
      }
    )
    const api = {
      projects: {
        list: jest.fn().mockResolvedValue([externalProject]),
        get: jest.fn().mockResolvedValue(externalProject),
        listExecutionEnvironments: jest.fn().mockResolvedValue([]),
      },
      issues: {
        listPage,
        getBoardSnapshot: jest.fn(),
      },
      members: {
        list: jest.fn().mockResolvedValue([]),
      },
      agents: {
        list: jest.fn().mockResolvedValue([]),
      },
    } as unknown as SharedWorkspaceApi
    const host: CollaborationHostAdapter = {
      capabilities: {
        automation: true,
        dingtalkAitable: false,
      },
      location: {
        projectId: externalProject.id,
        issueId: null,
        view: 'board',
      },
      navigate: jest.fn(),
    }

    render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)

    expect(await screen.findByText('GitHub 第一页 Issue')).toBeInTheDocument()
    expect(screen.getByText('GitHub 第二页 Issue')).toBeInTheDocument()
    expect(screen.getByText('GitHub 已完成 Issue')).toBeInTheDocument()
    expect(listPage).toHaveBeenCalledTimes(6)
    expect(listPage).toHaveBeenCalledWith(externalProject.id, {
      status: 'inbox',
      parentId: null,
      cursor: null,
      limit: 100,
    })
    expect(listPage).toHaveBeenCalledWith(externalProject.id, {
      status: 'pending',
      parentId: null,
      cursor: 'pending-page-2',
      limit: 100,
    })
    expect(screen.queryByTestId('cloud-board-sort-by-pending')).not.toBeInTheDocument()
    expect(api.issues.getBoardSnapshot).not.toHaveBeenCalled()
  })
})
