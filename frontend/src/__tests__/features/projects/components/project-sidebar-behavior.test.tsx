// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ProjectDeleteDialog } from '@/features/projects/components/ProjectDeleteDialog'
import { ProjectSection } from '@/features/projects/components/ProjectSection'
import TaskMenu from '@/features/tasks/components/sidebar/TaskMenu'
import type { ProjectWithTasks } from '@/types/api'

const pushMock = jest.fn()
const replaceMock = jest.fn()
const addTaskToProjectMock = jest.fn()
const removeTaskFromProjectMock = jest.fn()
const refreshProjectsMock = jest.fn()
const refreshTasksMock = jest.fn()
const deleteProjectMock = jest.fn()
const toggleProjectExpandedMock = jest.fn()
const setSelectedProjectTaskIdMock = jest.fn()
const setSelectedTaskMock = jest.fn()
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
  DropdownMenuItem: ({
    children,
    onClick,
    className,
  }: {
    children: React.ReactNode
    onClick?: React.MouseEventHandler<HTMLButtonElement>
    className?: string
  }) => (
    <button type="button" className={className} onClick={onClick}>
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
    selectedProjectTaskId: null,
    setSelectedProjectTaskId: setSelectedProjectTaskIdMock,
    refreshProjects: refreshProjectsMock,
    createProject: jest.fn(),
    updateProject: jest.fn(),
    deleteProject: deleteProjectMock,
    addTaskToProject: addTaskToProjectMock,
    removeTaskFromProject: removeTaskFromProjectMock,
    projectTaskIds: new Set([101, 202]),
    isWorkspaceEnabled: isWorkspaceEnabledMock,
  }),
}))

jest.mock('@/features/projects/components/DroppableProject', () => ({
  DroppableProject: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/features/projects/components/DraggableProjectTask', () => ({
  DraggableProjectTask: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/common/TaskInlineRename', () => ({
  TaskInlineRename: () => <input aria-label="rename task" />,
}))

describe('project sidebar behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    deleteProjectMock.mockResolvedValue(true)
    isWorkspaceEnabledMock = true
  })

  test('renders the unified project section as one compact row by default', () => {
    render(<ProjectSection onTaskSelect={jest.fn()} />)

    expect(screen.getByTestId('project-section-header')).toHaveClass('h-6')
    expect(screen.getByText('workspaceSection.title')).toBeInTheDocument()
    expect(screen.queryByText('section.title')).not.toBeInTheDocument()
    expect(screen.queryByText('(2)')).not.toBeInTheDocument()
    expect(screen.queryByText('pathless-project')).not.toBeInTheDocument()
    expect(screen.queryByText('workspace-project')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-section-toggle'))

    expect(screen.getByTestId('project-section-list')).toHaveClass('mt-1', 'space-y-0.5')
    expect(screen.getByText('pathless-project')).toBeInTheDocument()
    expect(screen.getByText('workspace-project')).toBeInTheDocument()
  })

  test('keeps workspace projects visible in the unified section when workspace creation is disabled', () => {
    isWorkspaceEnabledMock = false

    render(<ProjectSection onTaskSelect={jest.fn()} />)

    fireEvent.click(screen.getByTestId('project-section-toggle'))

    expect(screen.getByText('pathless-project')).toBeInTheDocument()
    expect(screen.getByText('workspace-project')).toBeInTheDocument()
  })

  test('shows the new conversation shortcut only for projects with a workspace path', () => {
    render(<ProjectSection onTaskSelect={jest.fn()} />)

    fireEvent.click(screen.getByTestId('project-section-toggle'))

    expect(screen.getAllByTestId('project-new-conversation-btn')).toHaveLength(1)
    expect(screen.getByText('pathless-project')).toBeInTheDocument()
    expect(screen.getByText('workspace-project')).toBeInTheDocument()
  })

  test('opens workspace project tasks in device chat from the unified section', () => {
    render(<ProjectSection onTaskSelect={jest.fn()} />)

    fireEvent.click(screen.getByTestId('project-section-toggle'))
    fireEvent.click(screen.getByText('workspace task'))

    expect(pushMock).toHaveBeenCalledWith('/devices/chat?taskId=202&projectId=2&deviceId=device-1')
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
