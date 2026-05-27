// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, screen, waitFor } from '@testing-library/react'

import { taskApis } from '@/apis/tasks'
import { TaskContextProvider, useTaskContext } from '@/features/tasks/contexts/taskContext'
import type { Task } from '@/types/api'

const mockSocketContext = {
  registerTaskHandlers: jest.fn(() => jest.fn()),
  isConnected: false,
  leaveTask: jest.fn(),
  onReconnect: jest.fn(() => jest.fn()),
}

jest.mock('@/apis/tasks', () => ({
  taskApis: {
    getTasksLite: jest.fn(),
    getGroupTasksLite: jest.fn(),
    getPersonalTasksLite: jest.fn(),
    getPersonalTaskGroupsLite: jest.fn(),
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
  current: ReturnType<typeof useTaskContext> | null
} = {
  current: null,
}

function ContextProbe() {
  const context = useTaskContext()
  contextProbe.current = context

  return <div data-testid="group-count">{context.groupTasks.length}</div>
}

describe('TaskContext group task loading', () => {
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
    mockedTaskApis.getPersonalTaskGroupsLite.mockResolvedValue({ total: 0, items: [] })
    mockedTaskApis.getTasksLite.mockResolvedValue(taskListResponse([]))
    mockedTaskApis.searchTasks.mockResolvedValue(taskListResponse([]))
  })

  it('defers group task loading until all group tasks are requested', async () => {
    render(
      <TaskContextProvider>
        <ContextProbe />
      </TaskContextProvider>
    )

    await waitFor(() => {
      expect(mockedTaskApis.getPersonalTaskGroupsLite).toHaveBeenCalledWith({ page: 1, limit: 50 })
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

  it('stops personal grouped history pagination when the last page is partial', async () => {
    mockedTaskApis.getPersonalTaskGroupsLite.mockResolvedValueOnce({
      total: 1,
      items: [
        {
          group_type: 'team',
          group_key: 'team:1',
          team_id: 1,
          team_name: 'support-agent',
          team_namespace: 'default',
          team_display_name: 'Support Agent',
          team_icon: null,
          device_id: null,
          device_name: null,
          items: [createGroupTask(1)],
        },
      ],
    })

    render(
      <TaskContextProvider>
        <ContextProbe />
      </TaskContextProvider>
    )

    await waitFor(() => {
      expect(mockedTaskApis.getPersonalTaskGroupsLite).toHaveBeenCalledWith({ page: 1, limit: 50 })
    })

    await waitFor(() => {
      expect(contextProbe.current?.personalTasks).toHaveLength(1)
    })
    expect(contextProbe.current?.hasMorePersonalTasks).toBe(false)
  })

  it('appends the next grouped personal history page when load more is requested', async () => {
    const firstPageTasks = Array.from({ length: 50 }, (_, index) =>
      createPersonalTask(index + 1, 1)
    )
    const secondPageTask = createPersonalTask(51, 2)

    mockedTaskApis.getPersonalTaskGroupsLite
      .mockResolvedValueOnce({
        total: 51,
        items: [
          {
            group_type: 'team',
            group_key: 'team:1',
            team_id: 1,
            team_name: 'team-1',
            team_namespace: 'default',
            team_display_name: 'Team 1',
            team_icon: null,
            device_id: null,
            device_name: null,
            items: firstPageTasks,
          },
        ],
      })
      .mockResolvedValueOnce({
        total: 51,
        items: [
          {
            group_type: 'team',
            group_key: 'team:2',
            team_id: 2,
            team_name: 'team-2',
            team_namespace: 'default',
            team_display_name: 'Team 2',
            team_icon: null,
            device_id: null,
            device_name: null,
            items: [secondPageTask],
          },
        ],
      })

    render(
      <TaskContextProvider>
        <ContextProbe />
      </TaskContextProvider>
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
    expect(mockedTaskApis.getPersonalTaskGroupsLite).toHaveBeenCalledWith({ page: 2, limit: 50 })
    expect(contextProbe.current?.personalTaskGroups.map(group => group.group_key)).toEqual([
      'team:1',
      'team:2',
    ])
    expect(contextProbe.current?.hasMorePersonalTasks).toBe(false)
  })

  it('keeps fetching personal history until load more finds non-duplicate tasks', async () => {
    const firstPageTasks = Array.from({ length: 50 }, (_, index) =>
      createPersonalTask(index + 1, 1)
    )
    const thirdPageTask = createPersonalTask(101, 2)

    mockedTaskApis.getPersonalTaskGroupsLite
      .mockResolvedValueOnce({
        total: 101,
        items: [
          {
            group_type: 'team',
            group_key: 'team:1',
            team_id: 1,
            team_name: 'team-1',
            team_namespace: 'default',
            team_display_name: 'Team 1',
            team_icon: null,
            device_id: null,
            device_name: null,
            items: firstPageTasks,
          },
        ],
      })
      .mockResolvedValueOnce({
        total: 101,
        items: [
          {
            group_type: 'team',
            group_key: 'team:1',
            team_id: 1,
            team_name: 'team-1',
            team_namespace: 'default',
            team_display_name: 'Team 1',
            team_icon: null,
            device_id: null,
            device_name: null,
            items: firstPageTasks,
          },
        ],
      })
      .mockResolvedValueOnce({
        total: 101,
        items: [
          {
            group_type: 'team',
            group_key: 'team:2',
            team_id: 2,
            team_name: 'team-2',
            team_namespace: 'default',
            team_display_name: 'Team 2',
            team_icon: null,
            device_id: null,
            device_name: null,
            items: [thirdPageTask],
          },
        ],
      })

    render(
      <TaskContextProvider>
        <ContextProbe />
      </TaskContextProvider>
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
    expect(mockedTaskApis.getPersonalTaskGroupsLite).toHaveBeenCalledWith({ page: 2, limit: 50 })
    expect(mockedTaskApis.getPersonalTaskGroupsLite).toHaveBeenCalledWith({ page: 3, limit: 50 })
    expect(contextProbe.current?.personalTaskGroups.map(group => group.group_key)).toEqual([
      'team:1',
      'team:2',
    ])
    expect(contextProbe.current?.hasMorePersonalTasks).toBe(false)
  })
})
