import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { ProjectWithTasks, RuntimeWorkListResponse } from '@/types/api'
import { TodoWorkspace } from './TodoWorkspace'

const projects: ProjectWithTasks[] = [
  { id: 7, name: 'Wework' },
  { id: 9, name: 'Agent Runtime' },
]

const runtimeWork: RuntimeWorkListResponse = {
  projects: [
    {
      project: { id: 7, key: 'wework', name: 'Wework' },
      deviceWorkspaces: [
        {
          id: 21,
          projectId: 7,
          deviceId: 'local',
          deviceName: 'This Mac',
          available: true,
          workspacePath: '/tmp/wework',
          tasks: [
            {
              taskId: 'running-task',
              workspacePath: '/tmp/wework',
              title: 'Synchronize runtime state',
              runtime: 'codex',
              running: true,
            },
            {
              taskId: 'review-task',
              workspacePath: '/tmp/wework',
              title: 'Confirm generated patch',
              runtime: 'codex',
              status: 'waiting_for_approval',
            },
            {
              taskId: 'completed-task',
              workspacePath: '/tmp/wework',
              title: 'Prepare project metadata',
              runtime: 'codex',
              running: false,
            },
          ],
        },
      ],
    },
    {
      project: { id: 9, key: 'runtime', name: 'Agent Runtime' },
      deviceWorkspaces: [],
    },
  ],
  chats: [],
  totalTasks: 3,
}

describe('TodoWorkspace V4-01', () => {
  beforeEach(() => window.localStorage.clear())

  async function quickCreate(title: string, state = 'inbox') {
    await userEvent.click(screen.getByTestId(`todo-column-add-${state}`))
    const input = screen.getByTestId(`todo-quick-create-${state}`)
    await userEvent.type(input, `${title}{enter}`)
    expect(await screen.findByText(title)).toBeInTheDocument()
  }

  afterEach(() => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('provides a local project when no backend project exists', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={[]}
        runtimeWork={{ projects: [], chats: [], totalTasks: 0 }}
      />
    )

    expect(screen.getAllByText('本地事项').length).toBeGreaterThan(0)
    await quickCreate('Offline item')
    expect(window.localStorage.getItem('wework:todo:work-items:1')).toContain('Offline item')
  })

  it('renders the four Pencil V4 kanban columns and maps runtime states', () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    expect(screen.getByTestId('todo-column-backlog')).toBeInTheDocument()
    expect(screen.getByTestId('todo-column-started')).toHaveTextContent('1')
    expect(screen.getByTestId('todo-column-review')).toHaveTextContent('1')
    expect(screen.getByTestId('todo-column-completed')).toHaveTextContent('1')
    expect(screen.getByTestId('todo-board-scroll')).toHaveClass('overflow-auto', 'bg-[#F7F8F9]')
    expect(screen.getByTestId('todo-board-grid')).toHaveClass('min-w-[1100px]', 'flex')
    expect(screen.getByText('Synchronize runtime state')).toBeInTheDocument()
  })

  it('switches projects from the TODO application sidebar', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await userEvent.click(screen.getByTestId('todo-sidebar-project-9'))

    expect(screen.getAllByText('Agent Runtime').length).toBeGreaterThan(0)
    expect(screen.queryByText('Synchronize runtime state')).not.toBeInTheDocument()
  })

  it('switches between project overview and work items without losing project context', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await userEvent.click(screen.getByTestId('todo-sidebar-overview'))

    expect(screen.getByTestId('todo-overview')).toBeInTheDocument()
    expect(screen.getByTestId('todo-main-header')).toHaveTextContent('总览')
    expect(screen.queryByTestId('todo-board-grid')).not.toBeInTheDocument()
    expect(screen.getByTestId('todo-overview-metric-started')).toHaveTextContent('1')
    expect(screen.getByTestId('todo-overview-metric-review')).toHaveTextContent('1')
    expect(screen.getByTestId('todo-overview-metric-completed')).toHaveTextContent('1')

    await userEvent.click(screen.getByTestId('todo-overview-open-work-items'))

    expect(screen.getByTestId('todo-board-grid')).toBeInTheDocument()
    expect(screen.getByTestId('todo-sidebar-work-items')).toHaveClass('bg-[#E8F8F5]')
  })

  it('expands and collapses the current project navigation', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    expect(screen.getByTestId('todo-sidebar-project-7')).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(screen.getByTestId('todo-sidebar-project-7'))

    expect(screen.getByTestId('todo-sidebar-project-7')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('todo-sidebar-work-items')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('todo-sidebar-project-7'))
    expect(screen.getByTestId('todo-sidebar-overview')).toBeInTheDocument()
  })

  it('keeps the collapsed TODO sidebar control clear of macOS traffic lights', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await userEvent.click(screen.getByTestId('collapse-sidebar-button'))

    expect(screen.getByTestId('todo-workspace')).toHaveClass('w-full', 'flex-1')
    expect(screen.getByTestId('todo-sidebar-chrome-controls')).toHaveClass('h-[38px]')
    expect(screen.getByTestId('todo-main-header')).toHaveClass('h-[38px]', 'pl-0', 'pr-[3px]')
    expect(screen.getByTestId('todo-sidebar-create')).toHaveClass('h-8')
    expect(screen.getByTestId('todo-main-header-left-controls')).toHaveClass(
      'h-full',
      'gap-1',
      'pl-[92px]',
      'pr-2'
    )
    expect(screen.getByTestId('todo-main-header-left-controls')).toContainElement(
      screen.getByTestId('todo-expand-sidebar')
    )
    expect(screen.getByTestId('todo-expand-sidebar')).toHaveClass('h-8', 'w-8', 'rounded-lg')
    expect(screen.getByTestId('todo-main-header-left-controls')).toContainElement(
      screen.getByTestId('todo-collapsed-app-wework')
    )
    expect(screen.getByTestId('todo-main-header-left-controls')).toContainElement(
      screen.getByTestId('todo-collapsed-app-current')
    )
    expect(screen.getByTestId('todo-main-header-left-controls')).toContainElement(
      screen.getByTestId('todo-collapsed-app-apps')
    )
  })

  it('opens the V4-02 project switcher and filters projects', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await userEvent.click(screen.getByTestId('todo-project-switcher'))

    expect(screen.getByTestId('todo-project-switcher-menu')).toBeInTheDocument()
    await userEvent.type(screen.getByTestId('todo-project-search-input'), 'Agent')
    expect(screen.queryByTestId('todo-project-menu-item-7')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('todo-project-menu-item-9'))
    expect(screen.queryByTestId('todo-project-switcher-menu')).not.toBeInTheDocument()
    expect(screen.getAllByText('Agent Runtime').length).toBeGreaterThan(0)
  })

  it('opens the V4-03 detail panel and returns to the original task', async () => {
    const onOpenRuntimeTask = vi.fn()
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
        onOpenRuntimeTask={onOpenRuntimeTask}
      />
    )

    await userEvent.click(screen.getByTestId('todo-card-completed-task'))
    expect(screen.getByTestId('todo-detail-panel')).toBeInTheDocument()
    expect(screen.getAllByText('Prepare project metadata')).toHaveLength(2)

    await userEvent.click(screen.getByTestId('todo-detail-open-execution'))
    expect(onOpenRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'local', taskId: 'completed-task' })
    )

    await userEvent.click(screen.getByTestId('todo-detail-close'))
    expect(screen.queryByTestId('todo-detail-panel')).not.toBeInTheDocument()
  })

  it('creates a persisted TODO inline from a board column', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await quickCreate('Fix login redirect', 'review')
    expect(screen.getByTestId('todo-sidebar-work-items')).toHaveTextContent('4')
    expect(window.localStorage.getItem('wework:todo:work-items:1')).toContain('Fix login redirect')
  })

  it('opens inline creation from the global create action', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await userEvent.click(screen.getByTestId('todo-create-button'))
    expect(screen.getByTestId('todo-quick-create-inbox')).toHaveFocus()
    await userEvent.type(screen.getByTestId('todo-quick-create-inbox'), 'Mouse-created item')
    await userEvent.click(screen.getByTestId('todo-quick-create-submit-inbox'))
    expect(await screen.findByText('Mouse-created item')).toBeInTheDocument()
  })
  it('creates and runs a TODO through the existing Wework runtime flow', async () => {
    const onRunTodo = vi.fn(async () => ({
      deviceId: 'local',
      taskId: 'created-task',
      workspacePath: '/tmp/wework',
    }))
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
        onRunTodo={onRunTodo}
      />
    )

    await quickCreate('Investigate and fix the bug')
    await userEvent.click(screen.getByText('Investigate and fix the bug'))
    await userEvent.selectOptions(screen.getByTestId('todo-detail-assignee-select'), 'ai')
    await userEvent.click(screen.getByTestId('todo-detail-run'))

    await waitFor(() => expect(onRunTodo).toHaveBeenCalledTimes(1))
    expect(onRunTodo).toHaveBeenCalledWith(
      expect.objectContaining({
        project: expect.objectContaining({ id: 7 }),
        message: 'Investigate and fix the bug',
        goal: undefined,
        attachments: [],
        collaborationMode: 'plan',
      })
    )
    await waitFor(() => {
      const stored = window.localStorage.getItem('wework:todo:work-items:1')
      expect(stored).toContain('created-task')
      expect(stored).toContain('已关联 AI 执行会话')
    })
  })

  it('switches between the board and list layouts', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await userEvent.click(screen.getByTestId('todo-view-list'))
    expect(screen.getByTestId('todo-list-view')).toBeInTheDocument()
    expect(screen.queryByTestId('todo-board-grid')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('todo-view-board'))
    expect(screen.getByTestId('todo-board-grid')).toBeInTheDocument()
  })

  it('filters work items and clears the active conditions', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await userEvent.click(screen.getByTestId('todo-filter-button'))
    await userEvent.selectOptions(screen.getByTestId('todo-filter-state'), 'review')

    expect(screen.getByTestId('todo-column-review')).toBeInTheDocument()
    expect(screen.queryByTestId('todo-column-started')).not.toBeInTheDocument()
    expect(screen.getByTestId('todo-filter-button')).toHaveTextContent('1')

    await userEvent.click(screen.getByTestId('todo-filter-clear'))
    expect(screen.getByTestId('todo-column-started')).toBeInTheDocument()
  })

  it('persists display settings and supports collapsing a board column', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await userEvent.click(screen.getByTestId('todo-display-button'))
    await userEvent.click(screen.getByTestId('todo-display-priority'))
    await userEvent.click(screen.getByTestId('todo-display-order-updated'))

    expect(screen.getByTestId('todo-display-priority')).toHaveAttribute('aria-checked', 'false')
    await waitFor(() =>
      expect(window.localStorage.getItem('wework:todo:view:1:7')).toContain('"order":"updated"')
    )

    await userEvent.click(screen.getByTestId('todo-column-more-started'))
    await userEvent.click(screen.getByTestId('todo-column-menu-collapse-started'))
    expect(screen.getByTestId('todo-column-expand-started')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('todo-column-expand-started'))
    expect(screen.getByTestId('todo-column-more-started')).toBeInTheDocument()
  })

  it('searches the current project and opens the matching TODO detail', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
        onOpenRuntimeTask={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('todo-sidebar-search'))
    await userEvent.type(screen.getByTestId('todo-search-input'), 'metadata')
    await userEvent.click(screen.getByTestId('todo-search-result-completed-task'))

    expect(screen.getByTestId('todo-detail-panel')).toBeInTheDocument()
    expect(screen.getAllByText('Prepare project metadata')).toHaveLength(2)
  })

  it('keeps an unassigned draft visible and explains why it cannot run', async () => {
    const onRunTodo = vi.fn()
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
        onRunTodo={onRunTodo}
      />
    )

    await quickCreate('Unassigned draft')
    await userEvent.click(screen.getByText('Unassigned draft'))
    await userEvent.click(screen.getByTestId('todo-detail-run'))

    expect(await screen.findByTestId('todo-detail-run-error')).toHaveTextContent(
      '请先选择员工或 AI 智能体作为执行者'
    )
    expect(screen.getByTestId('todo-detail-panel')).toBeInTheDocument()
    expect(onRunTodo).not.toHaveBeenCalled()
  })

  it('toggles the detail layout and exposes working draft actions', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await quickCreate('Disposable draft')
    await userEvent.click(screen.getByText('Disposable draft'))

    await userEvent.click(screen.getByTestId('todo-detail-preview-mode'))
    expect(screen.getByTestId('todo-detail-panel')).toHaveClass('left-0', 'w-full')

    await userEvent.click(screen.getByTestId('todo-detail-more'))
    expect(screen.getByTestId('todo-detail-more-menu')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('todo-detail-menu-delete'))
    expect(screen.queryByText('Disposable draft')).not.toBeInTheDocument()
  })

  it('configures a reusable project flow and assigns each role independently', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await userEvent.click(screen.getByTestId('todo-sidebar-workflow-settings'))
    await userEvent.click(screen.getByTestId('todo-workflow-template-software'))
    await userEvent.clear(screen.getByTestId('todo-workflow-name-discovery'))
    await userEvent.type(screen.getByTestId('todo-workflow-name-discovery'), '产品澄清')
    await userEvent.type(screen.getByTestId('todo-workflow-assignee-name-discovery'), '王产品')
    await userEvent.type(screen.getByTestId('todo-workflow-assignee-name-implementation'), 'Codex')
    await userEvent.click(screen.getByTestId('todo-workflow-save'))

    expect(window.localStorage.getItem('wework:todo:workflow:7')).toContain('产品澄清')
    expect(window.localStorage.getItem('wework:todo:workflow:7')).toContain('王产品')
    await quickCreate('新版登录流程上线')
    await userEvent.click(screen.getByText('新版登录流程上线'))
    expect(screen.getByTestId('todo-detail-workflow')).toHaveTextContent('产品澄清')
    expect(screen.getByTestId('todo-detail-workflow')).toHaveTextContent('实现')
    expect(window.localStorage.getItem('wework:todo:work-items:1')).toContain('Codex')
  })

  it('explains an empty workflow and lets an existing item apply the configured project flow', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await quickCreate('既有事项')
    await userEvent.click(screen.getByText('既有事项'))
    expect(screen.getByTestId('todo-detail-workflow')).toHaveTextContent(
      '当前项目还没有设置事项流程'
    )

    await userEvent.click(screen.getByTestId('todo-configure-workflow'))
    await userEvent.click(screen.getByTestId('todo-workflow-template-software'))
    await userEvent.click(screen.getByTestId('todo-workflow-save'))
    expect(screen.getByTestId('todo-detail-workflow')).toHaveTextContent(
      '这个事项还没有应用项目流程'
    )

    await userEvent.click(screen.getByTestId('todo-apply-workflow'))
    expect(screen.getByTestId('todo-detail-workflow')).toHaveTextContent('既有事项 · 需求')
    expect(screen.getByTestId('todo-detail-workflow')).toHaveTextContent('既有事项 · 实现')
  })

  it('adds an execution task below a complete item without adding another board card', async () => {
    window.localStorage.setItem(
      'wework:todo:workflow:7',
      JSON.stringify({
        version: 1,
        statuses: [
          { key: 'inbox', name: '收集箱' },
          { key: 'backlog', name: '待开始' },
          { key: 'started', name: '进行中' },
          { key: 'review', name: '待确认' },
          { key: 'completed', name: '已完成' },
        ],
        workTypes: [
          {
            key: 'discovery',
            name: '需求',
            dependsOn: [],
            defaultAssignee: { type: 'human', name: '王产品' },
          },
          {
            key: 'implementation',
            name: '实现',
            dependsOn: ['discovery'],
            defaultAssignee: { type: 'ai', name: 'Codex' },
          },
        ],
      })
    )
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await quickCreate('新版登录流程上线')
    await userEvent.click(screen.getByText('新版登录流程上线'))
    expect(screen.getByTestId('todo-detail-workflow')).toHaveTextContent('新版登录流程上线 · 实现')
    expect(screen.getAllByTestId(/todo-card-/)).toHaveLength(4)
    expect(window.localStorage.getItem('wework:todo:work-items:1')).toContain('"parentId"')

    await userEvent.click(screen.getByText('新版登录流程上线 · 实现'))
    await userEvent.selectOptions(screen.getByTestId('todo-detail-state-select'), 'started')
    await userEvent.selectOptions(screen.getByTestId('todo-detail-assignee-select'), 'ai')
    await userEvent.type(screen.getByTestId('todo-detail-blocker-input'), '等待 API 定稿')
    fireEvent.blur(screen.getByTestId('todo-detail-blocker-input'))

    await waitFor(() => {
      const stored = window.localStorage.getItem('wework:todo:work-items:1')
      expect(stored).toContain('等待 API 定稿')
      expect(stored).toContain('"state":"backlog"')
      expect(stored).toContain('"type":"ai"')
    })
    expect(screen.getByTestId('todo-detail-dependency-warning')).toHaveTextContent('需求')
  })

  it('groups human work and supports explicit completion confirmation', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await quickCreate('确认发布范围')
    await userEvent.click(screen.getByText('确认发布范围'))
    await userEvent.selectOptions(screen.getByTestId('todo-detail-assignee-select'), 'human')
    await userEvent.click(screen.getByTestId('todo-detail-close'))

    await userEvent.click(screen.getByTestId('todo-scope-mine'))
    expect(screen.getByTestId('todo-my-work')).toHaveTextContent('确认发布范围')
    await userEvent.click(screen.getByText('确认发布范围'))
    await userEvent.selectOptions(screen.getByTestId('todo-detail-state-select'), 'review')
    await userEvent.click(screen.getByTestId('todo-detail-confirm'))

    await waitFor(() => {
      expect(window.localStorage.getItem('wework:todo:work-items:1')).toContain('事项已确认完成')
    })
  })
})
