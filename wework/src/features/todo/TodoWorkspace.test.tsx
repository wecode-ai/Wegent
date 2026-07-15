import { render, screen, waitFor } from '@testing-library/react'
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

  afterEach(() => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
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
    expect(screen.getByTestId('todo-board-scroll')).toHaveClass('overflow-auto')
    expect(screen.getByTestId('todo-board-grid')).toHaveClass('min-w-[960px]', 'grid-cols-4')
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

  it('opens the V4-04 dialog from a board column and creates a persisted TODO draft', async () => {
    render(
      <TodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@wework.local' }}
        projects={projects}
        runtimeWork={runtimeWork}
        currentProjectId={7}
      />
    )

    await userEvent.click(screen.getByTestId('todo-column-add-review'))

    expect(screen.getByTestId('todo-create-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('todo-create-state')).toHaveValue('review')
    await userEvent.type(screen.getByTestId('todo-create-goal'), 'Keep login stable')
    await userEvent.type(
      screen.getByTestId('todo-create-markdown'),
      '## Fix login redirect\n\nPreserve the original route.'
    )
    await userEvent.click(screen.getByTestId('todo-create-submit'))

    await waitFor(() => expect(screen.queryByTestId('todo-create-dialog')).not.toBeInTheDocument())
    expect(screen.getByText('Fix login redirect')).toBeInTheDocument()
    expect(window.localStorage.getItem('wework:todo:drafts:1')).toContain('Keep login stable')
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

    await userEvent.click(screen.getByTestId('todo-create-button'))
    await userEvent.type(screen.getByTestId('todo-create-goal'), 'Ship a verified fix')
    await userEvent.type(screen.getByTestId('todo-create-markdown'), 'Investigate and fix the bug')
    await userEvent.selectOptions(screen.getByTestId('todo-create-executor'), 'ai')
    await userEvent.click(screen.getByTestId('todo-create-and-run'))

    await waitFor(() => expect(onRunTodo).toHaveBeenCalledTimes(1))
    expect(onRunTodo).toHaveBeenCalledWith(
      expect.objectContaining({
        project: expect.objectContaining({ id: 7 }),
        message: 'Investigate and fix the bug',
        goal: 'Ship a verified fix',
        attachments: [],
      })
    )
    await waitFor(() => expect(screen.queryByTestId('todo-create-dialog')).not.toBeInTheDocument())
  })
})
