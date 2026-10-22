// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ProjectDeleteDialog } from '@/features/projects/components/ProjectDeleteDialog'
import { ProjectSection } from '@/features/projects/components/ProjectSection'
import TaskMenu from '@/features/tasks/components/sidebar/TaskMenu'
import type { ProjectTask, ProjectWithTasks } from '@/types/api'

const pushMock = jest.fn()
const replaceMock = jest.fn()
const addTaskToProjectMock = jest.fn()
const removeTaskFromProjectMock = jest.fn()
const refreshProjectsMock = jest.fn()
const refreshTasksMock = jest.fn()
const deleteProjectMock = jest.fn()
const toggleProjectExpandedMock = jest.fn()
const setProjectSectionCollapsedMock = jest.fn()
const setSelectedProjectTaskIdMock = jest.fn()
const setSelectedTaskMock = jest.fn()
const loadProjectTasksMock = jest.fn()
let selectedProjectTaskMock: ProjectTask | null = null
let projectTaskPagesMock: Record<
  number,
  { loading: boolean; loaded: boolean; hasMore: boolean; error?: string }
> = {}
let isWorkspaceEnabledMock = true

const pathlessProject: ProjectWithTasks = {
  id: 1,
  user_id: 7,
  name: 'pathless-project',
  description: '',
  color: null,
  sort_order: 1,
  is_expanded: true,
  task_count: 1,
  config: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  tasks: [
    {
      task_id: 101,
      task_title: 'pathless task',
      task_status: 'COMPLETED',
      device_id: 'device-2',
      is_group_chat: false,
      project_id: 1,
    },
  ],
}

const workspaceProject: ProjectWithTasks = {
  id: 2,
  user_id: 7,
  name: 'workspace-project',
  description: '',
  color: null,
  sort_order: 2,
  is_expanded: true,
  task_count: 1,
  config: {
    mode: 'workspace',
    execution: {
      targetType: 'local',
      deviceId: 'device-1',
    },
    workspace: {
      source: 'local_path',
      localPath: '/Users/example/workspace-project',
    },
  },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  tasks: [
    {
      task_id: 202,
      task_title: 'workspace task',
      task_status: 'COMPLETED',
      is_group_chat: false,
      project_id: 2,
    },
  ],
}

const projects = [pathlessProject, workspaceProject]
const originalPathlessTasks = pathlessProject.tasks

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/contexts/DeviceContext', () => ({
  useDevices: () => ({
    devices: [],
  }),
}))

jest.mock('@/components/ui/dropdown', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  DropdownMenuPortal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({
    selectTask: setSelectedTaskMock,
    refreshTasks: refreshTasksMock,
  }),
}))

jest.mock('@/features/projects/contexts/projectContext', () => ({
  useProjectContext: () => ({
    projects,
    isLoading: false,
    expandedProjects: new Set(projects.map(project => project.id)),
    toggleProjectExpanded: toggleProjectExpandedMock,
    isProjectSectionCollapsed: false,
    setProjectSectionCollapsed: setProjectSectionCollapsedMock,
    selectedProjectTaskId: selectedProjectTaskMock?.task_id ?? null,
    selectedProjectTask: selectedProjectTaskMock,
    setSelectedProjectTaskId: setSelectedProjectTaskIdMock,
    refreshProjects: refreshProjectsMock,
    createProject: jest.fn(),
    updateProject: jest.fn(),
    deleteProject: deleteProjectMock,
    addTaskToProject: addTaskToProjectMock,
    removeTaskFromProject: removeTaskFromProjectMock,
    projectTaskIds: new Set([101, 202]),
    isWorkspaceEnabled: isWorkspaceEnabledMock,
    projectTaskPages: projectTaskPagesMock,
    loadProjectTasks: loadProjectTasksMock,
  }),
}))

jest.mock('@/features/projects/components/DroppableProject', () => ({
  DroppableProject: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/features/projects/components/DraggableProjectTask', () => ({
  DraggableProjectTask: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/features/projects/components/ProjectCreateDialog', () => ({
  ProjectCreateDialog: ({ open, mode }: { open: boolean; mode?: 'group' | 'workspace' }) =>
    open ? <div data-testid="project-create-dialog-mode">{mode}</div> : null,
}))

jest.mock('@/features/tasks/components/sidebar/SearchDialog', () => ({
  __esModule: true,
  default: ({
    open,
    projectId,
    projectName,
    onOpenChange,
    onProjectTaskSelect,
  }: {
    open: boolean
    projectId: number
    projectName: string
    onOpenChange: (open: boolean) => void
    onProjectTaskSelect: (task: ProjectTask) => void
  }) =>
    open ? (
      <div data-testid="project-search-dialog" data-project-id={projectId}>
        {projectName}
        <button
          type="button"
          data-testid="select-project-search-result"
          onClick={() => {
            onOpenChange(false)
            onProjectTaskSelect({
              task_id: 909,
              task_title: 'Task outside the loaded group page',
              task_status: 'COMPLETED',
              project_id: projectId,
              device_id: projectId === 1 ? 'device-2' : undefined,
              is_group_chat: false,
            })
          }}
        >
          Select result
        </button>
      </div>
    ) : null,
}))

jest.mock('@/components/common/TaskInlineRename', () => ({
  TaskInlineRename: () => <input aria-label="rename task" />,
}))

describe('project sidebar behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    deleteProjectMock.mockResolvedValue(true)
    isWorkspaceEnabledMock = true
    selectedProjectTaskMock = null
    loadProjectTasksMock.mockResolvedValue(undefined)
    projectTaskPagesMock = {
      1: { loading: false, loaded: true, hasMore: false },
      2: { loading: false, loaded: true, hasMore: false },
    }
    pathlessProject.tasks = originalPathlessTasks
  })

  test('renders the unified project section expanded by default', () => {
    render(<ProjectSection onTaskSelect={jest.fn()} />)

    expect(screen.getByTestId('project-section-header')).toHaveClass('h-6')
    expect(screen.getByText('workspaceSection.title')).toBeInTheDocument()
    expect(screen.queryByText('section.title')).not.toBeInTheDocument()
    expect(screen.queryByText('(2)')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-section-list')).toHaveClass('mt-1', 'space-y-0.5')
    expect(screen.getByText('pathless-project')).toBeInTheDocument()
    expect(screen.getByText('workspace-project')).toBeInTheDocument()
    expect(screen.getByTestId('conversation-group-icon')).toHaveClass('lucide-folder-open')
    expect(screen.getByTestId('workspace-project-icon')).toHaveClass('lucide-folder-kanban')

    fireEvent.click(screen.getByTestId('project-section-toggle'))
    expect(setProjectSectionCollapsedMock).toHaveBeenCalledTimes(1)
  })

  test('keeps workspace projects and creation available regardless of the workspace whitelist', () => {
    isWorkspaceEnabledMock = false

    render(<ProjectSection onTaskSelect={jest.fn()} />)

    expect(screen.getByText('pathless-project')).toBeInTheDocument()
    expect(screen.getByText('workspace-project')).toBeInTheDocument()
    expect(screen.getByTestId('create-workspace-project-button')).toBeInTheDocument()
    expect(screen.getByTestId('create-workspace-project-menu-item')).toBeInTheDocument()
  })

  test('opens group and workspace creation from the shared create menu', () => {
    render(<ProjectSection onTaskSelect={jest.fn()} />)

    expect(screen.getByTestId('create-workspace-project-menu-item')).toHaveTextContent(
      'workspaceCreate.title'
    )
    expect(screen.getByTestId('create-group-button')).toHaveTextContent('create.title')

    fireEvent.click(screen.getByTestId('create-group-button'))
    expect(screen.getByTestId('project-create-dialog-mode')).toHaveTextContent('group')

    fireEvent.click(screen.getByTestId('create-workspace-project-menu-item'))
    expect(screen.getByTestId('project-create-dialog-mode')).toHaveTextContent('workspace')
  })

  test.each([
    [1, 'pathless-project', '/devices/chat?taskId=909'],
    [2, 'workspace-project', '/devices/chat?taskId=909&projectId=2&deviceId=device-1'],
  ])('searches only project %s and keeps its task navigation', (id, name, target) => {
    const onTaskSelect = jest.fn()
    render(<ProjectSection onTaskSelect={onTaskSelect} />)

    fireEvent.click(screen.getByTestId(`project-search-tasks-${id}`))
    expect(screen.getByTestId('project-search-dialog')).toHaveAttribute(
      'data-project-id',
      String(id)
    )
    expect(screen.getByTestId('project-search-dialog')).toHaveTextContent(String(name))
    fireEvent.click(screen.getByTestId('select-project-search-result'))

    expect(setSelectedProjectTaskIdMock).toHaveBeenCalledWith(909)
    expect(pushMock).toHaveBeenCalledWith(target)
    expect(onTaskSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('project-search-dialog')).not.toBeInTheDocument()
  })

  test('loads an expanded group without mistaking unloaded tasks for an empty group', () => {
    pathlessProject.tasks = []
    projectTaskPagesMock[1] = { loading: false, loaded: false, hasMore: false }

    render(<ProjectSection />)

    expect(loadProjectTasksMock).toHaveBeenCalledWith(1)
    expect(screen.queryByText('section.noTasks')).not.toBeInTheDocument()
  })

  test('loads the next page using one load more control', () => {
    projectTaskPagesMock[1] = { loading: false, loaded: true, hasMore: true }

    render(<ProjectSection />)
    fireEvent.click(screen.getByTestId('project-tasks-load-more-1'))

    expect(loadProjectTasksMock).toHaveBeenCalledWith(1, true)
    expect(screen.getByText('pathless task')).toBeInTheDocument()
    expect(screen.queryByTestId('project-tasks-load-more-2')).not.toBeInTheDocument()
  })

  test('shows a selected task outside the loaded page without duplicating fetched tasks', () => {
    selectedProjectTaskMock = {
      task_id: 151,
      task_title: 'older selected task',
      task_status: 'COMPLETED',
      project_id: 1,
      is_group_chat: false,
    }
    const { rerender } = render(<ProjectSection />)

    expect(screen.getByText('older selected task').parentElement).toHaveClass('bg-primary/10')
    expect(screen.getByText('pathless task')).toBeInTheDocument()

    pathlessProject.tasks = [...originalPathlessTasks, selectedProjectTaskMock]
    rerender(<ProjectSection />)
    expect(screen.getAllByText('older selected task')).toHaveLength(1)
  })

  test('retries the failed page and disables the control during loading', () => {
    projectTaskPagesMock[1] = {
      loading: false,
      loaded: true,
      hasMore: true,
      error: 'Request failed',
    }
    const { rerender } = render(<ProjectSection />)

    fireEvent.click(screen.getByText('section.retryTasks'))
    expect(loadProjectTasksMock).toHaveBeenCalledWith(1, true)

    projectTaskPagesMock[1] = { loading: true, loaded: true, hasMore: true }
    rerender(<ProjectSection />)
    expect(screen.getByTestId('project-tasks-load-more-1')).toBeDisabled()
  })

  test('starts a new conversation inside either a group or a workspace project', () => {
    render(<ProjectSection onTaskSelect={jest.fn()} />)

    const newConversationButtons = screen.getAllByTestId('project-new-conversation-btn')
    expect(newConversationButtons).toHaveLength(2)
    expect(newConversationButtons[0]).toHaveClass('opacity-100')
    expect(screen.getAllByTestId('project-menu-new-conversation-btn')).toHaveLength(2)

    fireEvent.click(screen.getAllByTestId('project-menu-new-conversation-btn')[0])
    expect(pushMock).toHaveBeenLastCalledWith('/chat?conversationGroupId=1')

    fireEvent.click(newConversationButtons[1])
    expect(pushMock).toHaveBeenLastCalledWith('/devices/chat?projectId=2&deviceId=device-1')
    expect(setSelectedProjectTaskIdMock).toHaveBeenCalledWith(null)
    expect(setSelectedTaskMock).toHaveBeenCalledWith(null)
  })

  test('opens workspace project tasks in device chat from the unified section', () => {
    render(<ProjectSection onTaskSelect={jest.fn()} />)

    fireEvent.click(screen.getByText('workspace task'))

    expect(pushMock).toHaveBeenCalledWith('/devices/chat?taskId=202&projectId=2&deviceId=device-1')
  })

  test('keeps a grouped device conversation on the device chat page', () => {
    render(<ProjectSection onTaskSelect={jest.fn()} />)

    fireEvent.click(screen.getByText('pathless task'))

    expect(pushMock).toHaveBeenCalledWith('/devices/chat?taskId=101')
    expect(toggleProjectExpandedMock).not.toHaveBeenCalled()
  })

  test('ordinary task menu imports only into pathless projects', () => {
    render(
      <TaskMenu
        taskId={303}
        handleCopyTaskId={jest.fn()}
        handleDeleteTask={jest.fn()}
        isGroupChat={false}
      />
    )

    expect(screen.getByText('pathless-project')).toBeInTheDocument()
    expect(screen.queryByText('workspace-project')).not.toBeInTheDocument()
  })

  test('ordinary task menu starts bulk deletion from the current task', () => {
    const onSelectMultiple = jest.fn()

    render(
      <TaskMenu
        taskId={303}
        handleCopyTaskId={jest.fn()}
        handleDeleteTask={jest.fn()}
        onSelectMultiple={onSelectMultiple}
        isGroupChat={false}
      />
    )

    const deleteTaskAction = screen.getByText('common:tasks.delete_task')
    const bulkDeleteAction = screen.getByText('history:actions.bulk_delete')

    expect(
      deleteTaskAction.compareDocumentPosition(bulkDeleteAction) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    fireEvent.click(bulkDeleteAction)

    expect(onSelectMultiple).toHaveBeenCalledWith(303)
  })

  test('closes the delete dialog after deleting a project', async () => {
    const handleOpenChange = jest.fn()

    render(
      <ProjectDeleteDialog open={true} onOpenChange={handleOpenChange} project={pathlessProject} />
    )

    fireEvent.click(screen.getByText('delete.confirm'))

    await waitFor(() => {
      expect(deleteProjectMock).toHaveBeenCalledWith(pathlessProject.id)
      expect(handleOpenChange).toHaveBeenCalledWith(false)
    })
  })
})
