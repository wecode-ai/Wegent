// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'

import { taskApis } from '@/apis/tasks'
import { PROJECT_DELETED_EVENT } from '@/features/projects/events'
import { TaskSessionProvider, useTaskSession } from '@/features/tasks/session/TaskSession'
import type { Task } from '@/types/api'

const mockSocketContext = {
  registerTaskHandlers: jest.fn(() => jest.fn()),
  registerChatHandlers: jest.fn(() => jest.fn()),
  registerSkillHandlers: jest.fn(() => jest.fn()),
  isConnected: false,
  joinTask: jest.fn().mockResolvedValue({ subtasks: [] }),
  sendChatMessage: jest.fn(),
  leaveTask: jest.fn(),
  onReconnect: jest.fn(() => jest.fn()),
}

jest.mock('@/apis/tasks', () => ({
  taskApis: {
    getTasksLite: jest.fn(),
    getGroupTasksLite: jest.fn(),
    getPersonalTasksLite: jest.fn(),
    searchTasks: jest.fn(),
    getTaskDetail: jest.fn(),
  },
}))

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => mockSocketContext,
}))

jest.mock('@/hooks/usePageVisibility', () => ({
  usePageVisibility: jest.fn(),
}))

jest.mock('@/utils/notification', () => ({
  notifyTaskCompletion: jest.fn(),
}))

jest.mock('@/utils/taskViewStatus', () => ({
  markTaskAsViewed: jest.fn(),
  getUnreadCount: jest.fn(() => 0),
  markAllTasksAsViewed: jest.fn(),
  initializeTaskViewStatus: jest.fn(),
  getTaskViewStatus: jest.fn(),
}))

const mockedTaskApis = taskApis as jest.Mocked<typeof taskApis>

const createGroupTask = (id: number): Task => ({
  id,
  title: `Group task ${id}`,
  team_id: 1,
  git_url: '',
  git_repo: '',
  git_repo_id: 0,
  git_domain: '',
  branch_name: '',
  prompt: '',
  status: 'COMPLETED',
  task_type: 'chat',
  progress: 100,
  batch: 0,
  result: {},
  error_message: '',
  user_id: 1,
  user_name: 'user',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:00.000Z',
  is_group_chat: true,
})

const createPersonalTask = (id: number, teamId = 1): Task => ({
  ...createGroupTask(id),
  title: `Personal task ${id}`,
  team_id: teamId,
  team_name: `team-${teamId}`,
  team_namespace: 'default',
  team_display_name: `Team ${teamId}`,
  is_group_chat: false,
})

const createGroupPage = (startId: number, count: number) =>
  Array.from({ length: count }, (_, index) => createGroupTask(startId + index))

const taskListResponse = (items: Task[]) => ({
  total: items.length,
  items,
})

const contextProbe: {
  current: ReturnType<typeof useTaskSession> | null
} = {
  current: null,
}

function ContextProbe() {
  const context = useTaskSession()
  contextProbe.current = context

  return <div data-testid="group-count">{context.groupTasks.length}</div>
}

describe('TaskSessionContext group task loading', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    contextProbe.current = null

    mockedTaskApis.getGroupTasksLite.mockImplementation(async params => {
      switch (params?.page) {
        case 1:
          return taskListResponse(createGroupPage(1, 50))
        case 2:
          return taskListResponse(createGroupPage(51, 50))
        case 3:
          return taskListResponse(createGroupPage(101, 1))
        default:
          return taskListResponse([])
      }
    })
    mockedTaskApis.getPersonalTasksLite.mockResolvedValue(taskListResponse([]))
    mockedTaskApis.getTasksLite.mockResolvedValue(taskListResponse([]))
    mockedTaskApis.searchTasks.mockResolvedValue(taskListResponse([]))
  })

  it('defers group task loading until all group tasks are requested', async () => {
    render(
      <TaskSessionProvider>
        <ContextProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(mockedTaskApis.getPersonalTasksLite).toHaveBeenCalledWith({ page: 1, limit: 50 })
    })
    expect(screen.getByTestId('group-count')).toHaveTextContent('0')
    expect(mockedTaskApis.getGroupTasksLite).not.toHaveBeenCalled()

    await act(async () => {
      await contextProbe.current?.loadAllGroupTasks()
    })

    await waitFor(() => {
      expect(screen.getByTestId('group-count')).toHaveTextContent('101')
    })

    expect(mockedTaskApis.getGroupTasksLite).toHaveBeenCalledWith({ page: 1, limit: 50 })
    expect(mockedTaskApis.getGroupTasksLite).toHaveBeenCalledWith({ page: 2, limit: 50 })
    expect(mockedTaskApis.getGroupTasksLite).toHaveBeenCalledWith({ page: 3, limit: 50 })
    expect(mockedTaskApis.getGroupTasksLite).not.toHaveBeenCalledWith({ page: 4, limit: 50 })
    expect(contextProbe.current?.hasMoreGroupTasks).toBe(false)
  })

  it('stops personal history pagination when the last page is partial', async () => {
    const personalTask = createPersonalTask(1, 1)
    mockedTaskApis.getPersonalTasksLite.mockResolvedValueOnce(taskListResponse([personalTask]))

    render(
      <TaskSessionProvider>
        <ContextProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(mockedTaskApis.getPersonalTasksLite).toHaveBeenCalledWith({ page: 1, limit: 50 })
    })

    await waitFor(() => {
      expect(contextProbe.current?.personalTasks).toHaveLength(1)
    })
    expect(contextProbe.current?.personalTasks[0]).toMatchObject({
      team_name: personalTask.team_name,
      team_display_name: personalTask.team_display_name,
    })
    expect(contextProbe.current?.hasMorePersonalTasks).toBe(false)
  })

  it('refreshes personal history when a project is deleted', async () => {
    const beforeDeleteTask = createPersonalTask(1, 1)
    const afterDeleteTask = createPersonalTask(2, 1)
    mockedTaskApis.getPersonalTasksLite
      .mockResolvedValueOnce(taskListResponse([beforeDeleteTask]))
      .mockResolvedValueOnce(taskListResponse([afterDeleteTask]))

    render(
      <TaskSessionProvider>
        <ContextProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(contextProbe.current?.personalTasks.map(task => task.id)).toEqual([1])
    })

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(PROJECT_DELETED_EVENT, {
          detail: { projectId: 700 },
        })
      )
    })

    await waitFor(() => {
      expect(contextProbe.current?.personalTasks.map(task => task.id)).toEqual([2])
    })
    expect(mockedTaskApis.getPersonalTasksLite).toHaveBeenNthCalledWith(2, {
      page: 1,
      limit: 50,
    })
  })

  it('appends the next personal history page when load more is requested', async () => {
    const firstPageTasks = Array.from({ length: 50 }, (_, index) =>
      createPersonalTask(index + 1, 1)
    )
    const secondPageTask = createPersonalTask(51, 2)

    mockedTaskApis.getPersonalTasksLite
      .mockResolvedValueOnce(taskListResponse(firstPageTasks))
      .mockResolvedValueOnce(taskListResponse([secondPageTask]))

    render(
      <TaskSessionProvider>
        <ContextProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(contextProbe.current?.personalTasks).toHaveLength(50)
    })

    await act(async () => {
      await contextProbe.current?.loadMorePersonalTasks()
    })

    await waitFor(() => {
      expect(contextProbe.current?.personalTasks).toHaveLength(51)
    })
    expect(mockedTaskApis.getPersonalTasksLite).toHaveBeenCalledWith({ page: 2, limit: 50 })
    expect(contextProbe.current?.hasMorePersonalTasks).toBe(false)
  })

  it('keeps fetching personal history until load more finds non-duplicate tasks', async () => {
    const firstPageTasks = Array.from({ length: 50 }, (_, index) =>
      createPersonalTask(index + 1, 1)
    )
    const thirdPageTask = createPersonalTask(101, 2)

    mockedTaskApis.getPersonalTasksLite
      .mockResolvedValueOnce(taskListResponse(firstPageTasks))
      .mockResolvedValueOnce(taskListResponse(firstPageTasks))
      .mockResolvedValueOnce(taskListResponse([thirdPageTask]))

    render(
      <TaskSessionProvider>
        <ContextProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(contextProbe.current?.personalTasks).toHaveLength(50)
    })

    await act(async () => {
      await contextProbe.current?.loadMorePersonalTasks()
    })

    await waitFor(() => {
      expect(contextProbe.current?.personalTasks).toHaveLength(51)
    })
    expect(mockedTaskApis.getPersonalTasksLite).toHaveBeenCalledWith({ page: 2, limit: 50 })
    expect(mockedTaskApis.getPersonalTasksLite).toHaveBeenCalledWith({ page: 3, limit: 50 })
    expect(contextProbe.current?.hasMorePersonalTasks).toBe(false)
  })
})
