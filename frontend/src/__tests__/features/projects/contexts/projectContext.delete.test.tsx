// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { projectApis } from '@/apis/projects'
import { taskApis } from '@/apis/tasks'
import { ProjectProvider, useProjectContext } from '@/features/projects/contexts/projectContext'
import { PROJECT_DELETED_EVENT, ProjectDeletedEventDetail } from '@/features/projects/events'
import type { ProjectWithTasks } from '@/types/api'
import type { TaskEventHandlers } from '@/contexts/SocketContext'

const toastMock = jest.fn()
let mockSearchParams = new URLSearchParams()
let mockTaskHandlers: TaskEventHandlers = {}
const mockSocketContext = {
  isConnected: true,
  registerTaskHandlers: jest.fn((handlers: TaskEventHandlers) => {
    mockTaskHandlers = handlers
    return jest.fn()
  }),
}

jest.mock('@/contexts/SocketContext', () => ({ useSocket: () => mockSocketContext }))

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/apis/projects', () => ({
  projectApis: {
    getProjects: jest.fn(),
    getProjectTasks: jest.fn(),
    createProject: jest.fn(),
    updateProject: jest.fn(),
    deleteProject: jest.fn(),
    addTaskToProject: jest.fn(),
    removeTaskFromProject: jest.fn(),
  },
}))

jest.mock('@/apis/tasks', () => ({
  taskApis: { getTaskDetail: jest.fn() },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: toastMock,
  }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/lib/runtime-config', () => ({
  getRuntimeConfigSync: () => ({
    enableProjectWorkspace: true,
    projectWorkspaceWhitelist: '',
  }),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({
    user: { user_name: 'sifang' },
  }),
}))

const mockedProjectApis = projectApis as jest.Mocked<typeof projectApis>
const mockedTaskApis = taskApis as jest.Mocked<typeof taskApis>

function DeleteProjectProbe() {
  const { deleteProject } = useProjectContext()

  return (
    <button type="button" onClick={() => void deleteProject(42)}>
      delete project
    </button>
  )
}

function ProjectExpansionProbe() {
  const {
    expandedProjects,
    toggleProjectExpanded,
    refreshProjects,
    selectedProjectTaskId,
    isProjectSectionCollapsed,
  } = useProjectContext()

  return (
    <div>
      <span data-testid="project-expansion-state">
        {expandedProjects.has(42) ? 'expanded' : 'collapsed'}
      </span>
      <span data-testid="selected-project-task">{selectedProjectTaskId ?? 'none'}</span>
      <span data-testid="project-section-state">
        {isProjectSectionCollapsed ? 'collapsed' : 'expanded'}
      </span>
      <button type="button" onClick={() => toggleProjectExpanded(42)}>
        toggle project
      </button>
      <button type="button" onClick={() => void refreshProjects()}>
        refresh projects
      </button>
    </div>
  )
}

const projectFixture: ProjectWithTasks = {
  id: 42,
  user_id: 7,
  name: 'conversation group',
  description: '',
  color: null,
  sort_order: 1,
  is_expanded: true,
  task_count: 0,
  config: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  tasks: [],
}

describe('ProjectContext delete project behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTaskHandlers = {}
    mockSearchParams = new URLSearchParams()
    mockedProjectApis.getProjects.mockResolvedValue({ total: 0, items: [] })
    mockedProjectApis.deleteProject.mockResolvedValue({ message: 'ok' })
  })

  test('refreshes grouped task metadata once on task creation without fetching group pages', async () => {
    render(
      <ProjectProvider>
        <DeleteProjectProbe />
      </ProjectProvider>
    )
    await waitFor(() => expect(mockedProjectApis.getProjects).toHaveBeenCalledTimes(1))
    const createdTask = {
      task_id: 99,
      title: 'API task',
      team_id: 3,
      team_name: 'Test agent',
      created_at: '2026-01-01T00:00:00Z',
    }
    act(() => mockTaskHandlers.onTaskCreated?.(createdTask))
    expect(mockedProjectApis.getProjects).toHaveBeenCalledTimes(1)

    act(() => mockTaskHandlers.onTaskCreated?.({ ...createdTask, project_id: 42 }))

    await waitFor(() => expect(mockedProjectApis.getProjects).toHaveBeenCalledTimes(2))
    expect(mockedProjectApis.getProjects).toHaveBeenLastCalledWith(false)
    expect(mockedProjectApis.getProjectTasks).not.toHaveBeenCalled()
    expect(mockedTaskApis.getTaskDetail).not.toHaveBeenCalled()
  })

  test('emits a project deleted event after deletion succeeds', async () => {
    const deletedListener = jest.fn((event: Event) => {
      const detail = (event as CustomEvent<ProjectDeletedEventDetail>).detail
      expect(detail).toEqual({ projectId: 42 })
    })
    window.addEventListener(PROJECT_DELETED_EVENT, deletedListener)

    try {
      render(
        <ProjectProvider>
          <DeleteProjectProbe />
        </ProjectProvider>
      )

      await waitFor(() => expect(mockedProjectApis.getProjects).toHaveBeenCalled())

      fireEvent.click(screen.getByText('delete project'))

      await waitFor(() => {
        expect(mockedProjectApis.deleteProject).toHaveBeenCalledWith(42)
        expect(deletedListener).toHaveBeenCalledTimes(1)
      })
    } finally {
      window.removeEventListener(PROJECT_DELETED_EVENT, deletedListener)
    }
  })

  test('keeps the persisted expansion state aligned across refreshes', async () => {
    let persistedExpanded = true
    mockedProjectApis.getProjects.mockImplementation(async () => ({
      total: 1,
      items: [{ ...projectFixture, is_expanded: persistedExpanded }],
    }))
    mockedProjectApis.updateProject.mockImplementation(async (_projectId, data) => {
      persistedExpanded = data.is_expanded ?? persistedExpanded
      return { ...projectFixture, is_expanded: persistedExpanded }
    })

    render(
      <ProjectProvider>
        <ProjectExpansionProbe />
      </ProjectProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('project-expansion-state')).toHaveTextContent('expanded')
    })

    fireEvent.click(screen.getByText('toggle project'))
    await waitFor(() => {
      expect(mockedProjectApis.updateProject).toHaveBeenLastCalledWith(42, {
        is_expanded: false,
      })
      expect(screen.getByTestId('project-expansion-state')).toHaveTextContent('collapsed')
    })

    fireEvent.click(screen.getByText('toggle project'))
    await waitFor(() => {
      expect(mockedProjectApis.updateProject).toHaveBeenLastCalledWith(42, {
        is_expanded: true,
      })
      expect(screen.getByTestId('project-expansion-state')).toHaveTextContent('expanded')
    })

    fireEvent.click(screen.getByText('refresh projects'))
    await waitFor(() => {
      expect(mockedProjectApis.getProjects).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId('project-expansion-state')).toHaveTextContent('expanded')
    })
  })

  test('expands the group containing the task selected by the current route', async () => {
    mockSearchParams = new URLSearchParams({ taskId: '101' })
    mockedTaskApis.getTaskDetail.mockResolvedValue({ project_id: 42 } as Awaited<
      ReturnType<typeof taskApis.getTaskDetail>
    >)
    mockedProjectApis.getProjects.mockResolvedValue({
      total: 1,
      items: [
        {
          ...projectFixture,
          is_expanded: false,
          task_count: 1,
          tasks: [],
        },
      ],
    })

    render(
      <ProjectProvider>
        <ProjectExpansionProbe />
      </ProjectProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('selected-project-task')).toHaveTextContent('101')
      expect(screen.getByTestId('project-expansion-state')).toHaveTextContent('expanded')
      expect(screen.getByTestId('project-section-state')).toHaveTextContent('expanded')
      expect(taskApis.getTaskDetail).toHaveBeenCalledWith(101)
    })
  })
})
