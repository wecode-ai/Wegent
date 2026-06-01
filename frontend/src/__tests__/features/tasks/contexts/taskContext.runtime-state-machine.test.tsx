// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, waitFor } from '@testing-library/react'

import { taskApis } from '@/apis/tasks'
import { TaskContextProvider, useTaskContext } from '@/features/tasks/contexts/taskContext'
import type { Task, TaskDetail } from '@/types/api'
import type { TaskStatusPayload } from '@/types/socket'

const mockHandleTaskStatus = jest.fn()
const mockSyncTaskDetail = jest.fn()
const mockCheckHealthAll = jest.fn((_reason?: string) => Promise.resolve())
const mockCheckHealth = jest.fn((_reason?: string) => Promise.resolve())
let mockTaskHandlers: { onTaskStatus?: (payload: TaskStatusPayload) => void } | null = null
let mockVisibleHandler: ((wasHiddenFor: number) => void) | null = null
let mockIsConnected = true

const mockSocketContext = {
  registerTaskHandlers: jest.fn(handlers => {
    mockTaskHandlers = handlers
    return jest.fn()
  }),
  get isConnected() {
    return mockIsConnected
  },
  leaveTask: jest.fn(),
}

jest.mock('@/features/tasks/state', () => ({
  taskStateManager: {
    handleTaskStatus: (taskId: number, taskStatus: string, updatedAt?: string) =>
      mockHandleTaskStatus(taskId, taskStatus, updatedAt),
    syncTaskDetail: (taskDetail: unknown) => mockSyncTaskDetail(taskDetail),
    isInitialized: () => true,
    checkHealthAll: (reason: string) => mockCheckHealthAll(reason),
    getOrCreate: () => ({
      checkHealth: (reason: string) => mockCheckHealth(reason),
    }),
  },
}))

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => mockSocketContext,
}))

jest.mock('@/apis/tasks', () => ({
  taskApis: {
    getTasksLite: jest.fn(),
    getGroupTasksLite: jest.fn(),
    getPersonalTasksLite: jest.fn(),
    searchTasks: jest.fn(),
    getTaskDetail: jest.fn(),
  },
}))

jest.mock('@/hooks/usePageVisibility', () => ({
  usePageVisibility: jest.fn(options => {
    mockVisibleHandler = options.onVisible
    return {
      isVisible: true,
      wasHidden: false,
      hiddenAt: null,
      lastHiddenDuration: null,
    }
  }),
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

const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: 42,
  title: 'Runtime task',
  team_id: 1,
  git_url: '',
  git_repo: '',
  git_repo_id: 0,
  git_domain: '',
  branch_name: '',
  prompt: '',
  status: 'RUNNING',
  task_type: 'chat',
  progress: 20,
  batch: 0,
  result: {},
  error_message: '',
  user_id: 1,
  user_name: 'user',
  created_at: '2026-05-31T09:00:00.000Z',
  updated_at: '2026-05-31T09:00:00.000Z',
  completed_at: '',
  is_group_chat: false,
  ...overrides,
})

const createTaskDetail = (overrides: Partial<TaskDetail> = {}): TaskDetail =>
  ({
    ...createTask(overrides),
    user: {
      id: 1,
      user_name: 'user',
      email: 'user@example.com',
      is_active: true,
      created_at: '2026-05-31T09:00:00.000Z',
      updated_at: '2026-05-31T09:00:00.000Z',
      git_info: [],
    },
    team: {
      id: 1,
      name: 'team',
      description: '',
      bots: [],
      workflow: {},
      is_active: true,
      user_id: 1,
      created_at: '2026-05-31T09:00:00.000Z',
      updated_at: '2026-05-31T09:00:00.000Z',
    },
    ...overrides,
  }) as TaskDetail

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
  contextProbe.current = useTaskContext()
  return null
}

describe('TaskContext runtime state machine sync', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    contextProbe.current = null
    mockTaskHandlers = null
    mockVisibleHandler = null
    mockIsConnected = true

    mockedTaskApis.getGroupTasksLite.mockResolvedValue(taskListResponse([]))
    mockedTaskApis.getPersonalTasksLite.mockResolvedValue(taskListResponse([createTask()]))
    mockedTaskApis.getTasksLite.mockResolvedValue(taskListResponse([]))
    mockedTaskApis.searchTasks.mockResolvedValue(taskListResponse([]))
    mockedTaskApis.getTaskDetail.mockResolvedValue(createTaskDetail())
  })

  it('dispatches task status websocket updates into the task state machine', async () => {
    render(
      <TaskContextProvider>
        <ContextProbe />
      </TaskContextProvider>
    )

    await waitFor(() => {
      expect(mockTaskHandlers?.onTaskStatus).toBeDefined()
    })

    act(() => {
      mockTaskHandlers?.onTaskStatus?.({
        task_id: 42,
        status: 'COMPLETED',
        progress: 100,
        completed_at: '2026-05-31T10:00:00.000Z',
      })
    })

    expect(mockHandleTaskStatus).toHaveBeenCalledWith(42, 'COMPLETED', '2026-05-31T10:00:00.000Z')
  })

  it('does not stamp active task status events with client time', async () => {
    render(
      <TaskContextProvider>
        <ContextProbe />
      </TaskContextProvider>
    )

    await waitFor(() => {
      expect(mockTaskHandlers?.onTaskStatus).toBeDefined()
    })

    act(() => {
      mockTaskHandlers?.onTaskStatus?.({
        task_id: 42,
        status: 'RUNNING',
        progress: 50,
      })
    })

    expect(mockHandleTaskStatus).toHaveBeenCalledWith(42, 'RUNNING', undefined)
  })

  it('syncs selected task detail snapshots into the task state machine', async () => {
    render(
      <TaskContextProvider>
        <ContextProbe />
      </TaskContextProvider>
    )

    await waitFor(() => {
      expect(contextProbe.current).not.toBeNull()
    })

    act(() => {
      contextProbe.current?.setSelectedTask(createTask())
    })

    await waitFor(() => {
      expect(mockedTaskApis.getTaskDetail).toHaveBeenCalledWith(42)
    })

    expect(mockSyncTaskDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 42,
        status: 'RUNNING',
      })
    )
  })

  it('checks runtime health and selected task detail when the socket reconnects', async () => {
    const renderTree = () => (
      <TaskContextProvider>
        <ContextProbe />
      </TaskContextProvider>
    )
    const { rerender } = render(renderTree())

    await waitFor(() => {
      expect(contextProbe.current).not.toBeNull()
    })

    act(() => {
      contextProbe.current?.setSelectedTask(createTask())
    })

    await waitFor(() => {
      expect(mockedTaskApis.getTaskDetail).toHaveBeenCalledWith(42)
    })

    mockCheckHealthAll.mockClear()
    mockedTaskApis.getPersonalTasksLite.mockClear()
    mockedTaskApis.getTaskDetail.mockClear()

    act(() => {
      mockIsConnected = false
      rerender(renderTree())
    })

    act(() => {
      mockIsConnected = true
      rerender(renderTree())
    })

    await waitFor(() => {
      expect(mockCheckHealthAll).toHaveBeenCalledWith('websocket-reconnect')
    })
    expect(mockedTaskApis.getPersonalTasksLite).toHaveBeenCalledWith({ page: 1, limit: 50 })
    expect(mockedTaskApis.getTaskDetail).toHaveBeenCalledWith(42)
  })

  it('uses the same health-check path when the page becomes visible after the hidden threshold', async () => {
    render(
      <TaskContextProvider>
        <ContextProbe />
      </TaskContextProvider>
    )

    await waitFor(() => {
      expect(contextProbe.current).not.toBeNull()
    })

    act(() => {
      contextProbe.current?.setSelectedTask(createTask())
    })

    await waitFor(() => {
      expect(mockedTaskApis.getTaskDetail).toHaveBeenCalledWith(42)
    })

    mockCheckHealthAll.mockClear()
    mockedTaskApis.getPersonalTasksLite.mockClear()
    mockedTaskApis.getTaskDetail.mockClear()

    act(() => {
      mockVisibleHandler?.(3000)
    })

    await waitFor(() => {
      expect(mockCheckHealthAll).toHaveBeenCalledWith('page-visible')
    })
    expect(mockedTaskApis.getPersonalTasksLite).toHaveBeenCalledWith({ page: 1, limit: 50 })
    expect(mockedTaskApis.getTaskDetail).toHaveBeenCalledWith(42)
  })

  it('refreshes server snapshots even if runtime health check is still pending', async () => {
    mockCheckHealthAll.mockImplementationOnce(() => new Promise(() => {}))

    render(
      <TaskContextProvider>
        <ContextProbe />
      </TaskContextProvider>
    )

    await waitFor(() => {
      expect(contextProbe.current).not.toBeNull()
    })

    act(() => {
      contextProbe.current?.setSelectedTask(createTask())
    })

    await waitFor(() => {
      expect(mockedTaskApis.getTaskDetail).toHaveBeenCalledWith(42)
    })

    mockedTaskApis.getPersonalTasksLite.mockClear()
    mockedTaskApis.getTaskDetail.mockClear()

    act(() => {
      mockVisibleHandler?.(3000)
    })

    await waitFor(() => {
      expect(mockedTaskApis.getTaskDetail).toHaveBeenCalledWith(42)
    })
    expect(mockedTaskApis.getPersonalTasksLite).toHaveBeenCalledWith({ page: 1, limit: 50 })
  })
})
