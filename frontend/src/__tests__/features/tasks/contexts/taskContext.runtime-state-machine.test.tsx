// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, waitFor } from '@testing-library/react'

import { taskApis } from '@/apis/tasks'
import { TaskSessionProvider, useTaskSession } from '@/features/tasks/session/TaskSession'
import type { Task, TaskDetail } from '@/types/api'
import type { TaskStatusPayload } from '@/types/socket'

let mockTaskHandlers: { onTaskStatus?: (payload: TaskStatusPayload) => void } | null = null
let mockVisibleHandler: ((wasHiddenFor: number) => void) | null = null
let mockReconnectHandler: (() => void) | null = null
let mockIsConnected = true

const mockJoinTask = jest.fn()

const mockSocketContext = {
  registerTaskHandlers: jest.fn(handlers => {
    mockTaskHandlers = handlers
    return jest.fn()
  }),
  get isConnected() {
    return mockIsConnected
  },
  joinTask: mockJoinTask,
  leaveTask: jest.fn(),
  sendChatMessage: jest.fn(),
  cancelChatStream: jest.fn(),
  registerChatHandlers: jest.fn(() => jest.fn()),
  registerSkillHandlers: jest.fn(() => jest.fn()),
  sendSkillResponse: jest.fn(),
  onReconnect: jest.fn((callback: () => void) => {
    mockReconnectHandler = callback
    return jest.fn()
  }),
}

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
    getTaskRuntimeCheck: jest.fn(),
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
  current: ReturnType<typeof useTaskSession> | null
} = {
  current: null,
}

function ContextProbe() {
  contextProbe.current = useTaskSession()
  return null
}

describe('TaskSessionContext runtime state machine sync', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    contextProbe.current = null
    mockTaskHandlers = null
    mockVisibleHandler = null
    mockReconnectHandler = null
    mockIsConnected = true
    mockJoinTask.mockResolvedValue({ subtasks: [] })

    mockedTaskApis.getGroupTasksLite.mockResolvedValue(taskListResponse([]))
    mockedTaskApis.getPersonalTasksLite.mockResolvedValue(taskListResponse([createTask()]))
    mockedTaskApis.getTasksLite.mockResolvedValue(taskListResponse([]))
    mockedTaskApis.searchTasks.mockResolvedValue(taskListResponse([]))
    mockedTaskApis.getTaskDetail.mockResolvedValue(createTaskDetail())
    mockedTaskApis.getTaskRuntimeCheck.mockResolvedValue({
      task_id: 42,
      task_status: 'RUNNING',
      status_updated_at: '2026-05-31T10:00:00.000Z',
      active_stream: null,
    })
  })

  it('updates selected task runtime from task status websocket events', async () => {
    render(
      <TaskSessionProvider>
        <ContextProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(mockTaskHandlers?.onTaskStatus).toBeDefined()
    })

    act(() => {
      contextProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(contextProbe.current?.taskState?.taskId).toBe(42)
    })

    act(() => {
      mockTaskHandlers?.onTaskStatus?.({
        task_id: 42,
        status: 'COMPLETED',
        progress: 100,
        completed_at: '2026-05-31T10:00:00.000Z',
      })
    })

    await waitFor(() => {
      expect(contextProbe.current?.taskState?.runtime.taskStatus).toBe('COMPLETED')
    })
    expect(contextProbe.current?.taskState?.runtime.lastStatusUpdatedAt).toBe(
      '2026-05-31T10:00:00.000Z'
    )
  })

  it('does not stamp active task runtime events with client time', async () => {
    render(
      <TaskSessionProvider>
        <ContextProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(mockTaskHandlers?.onTaskStatus).toBeDefined()
    })

    act(() => {
      contextProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(contextProbe.current?.taskState?.taskId).toBe(42)
    })

    act(() => {
      mockTaskHandlers?.onTaskStatus?.({
        task_id: 42,
        status: 'RUNNING',
        progress: 50,
      })
    })

    await waitFor(() => {
      expect(contextProbe.current?.taskState?.runtime.taskStatus).toBe('RUNNING')
    })
    expect(contextProbe.current?.taskState?.runtime.lastStatusUpdatedAt).toBe(
      '2026-05-31T09:00:00.000Z'
    )
  })

  it('syncs selected task detail snapshots into the current state machine', async () => {
    render(
      <TaskSessionProvider>
        <ContextProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(contextProbe.current).not.toBeNull()
    })

    act(() => {
      contextProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(mockedTaskApis.getTaskDetail).toHaveBeenCalledWith(42)
    })

    expect(contextProbe.current?.taskState?.runtime.taskStatus).toBe('RUNNING')
  })

  it('checks runtime health and selected task detail when the socket reconnects', async () => {
    const renderTree = () => (
      <TaskSessionProvider>
        <ContextProbe />
      </TaskSessionProvider>
    )
    const { rerender } = render(renderTree())

    await waitFor(() => {
      expect(contextProbe.current).not.toBeNull()
    })

    act(() => {
      contextProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(mockedTaskApis.getTaskDetail).toHaveBeenCalledWith(42)
    })

    mockedTaskApis.getTaskRuntimeCheck.mockClear()
    mockJoinTask.mockClear()
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
      expect(mockedTaskApis.getTaskRuntimeCheck).toHaveBeenCalledWith(42)
    })
    expect(mockedTaskApis.getPersonalTasksLite).toHaveBeenCalledWith({ page: 1, limit: 50 })
  })

  it('checks runtime health when the socket reconnect callback fires', async () => {
    render(
      <TaskSessionProvider>
        <ContextProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(contextProbe.current).not.toBeNull()
    })

    act(() => {
      contextProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(mockedTaskApis.getTaskDetail).toHaveBeenCalledWith(42)
    })

    mockedTaskApis.getTaskRuntimeCheck.mockClear()
    mockedTaskApis.getPersonalTasksLite.mockClear()

    act(() => {
      mockReconnectHandler?.()
    })

    await waitFor(() => {
      expect(mockedTaskApis.getTaskRuntimeCheck).toHaveBeenCalledWith(42)
    })
    expect(mockedTaskApis.getPersonalTasksLite).toHaveBeenCalledWith({ page: 1, limit: 50 })
  })

  it('uses the same health-check path when the page becomes visible after the hidden threshold', async () => {
    render(
      <TaskSessionProvider>
        <ContextProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(contextProbe.current).not.toBeNull()
    })

    act(() => {
      contextProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(mockedTaskApis.getTaskDetail).toHaveBeenCalledWith(42)
    })

    mockedTaskApis.getTaskRuntimeCheck.mockClear()
    mockJoinTask.mockClear()
    mockedTaskApis.getPersonalTasksLite.mockClear()
    mockedTaskApis.getTaskDetail.mockClear()

    act(() => {
      mockVisibleHandler?.(3000)
    })

    await waitFor(() => {
      expect(mockedTaskApis.getTaskRuntimeCheck).toHaveBeenCalledWith(42)
    })
    expect(mockedTaskApis.getPersonalTasksLite).toHaveBeenCalledWith({ page: 1, limit: 50 })
  })

  it('refreshes server snapshots even if runtime health check is still pending', async () => {
    mockedTaskApis.getTaskRuntimeCheck.mockImplementationOnce(() => new Promise(() => {}))

    render(
      <TaskSessionProvider>
        <ContextProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(contextProbe.current).not.toBeNull()
    })

    act(() => {
      contextProbe.current?.selectTask(createTask())
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
      expect(mockedTaskApis.getPersonalTasksLite).toHaveBeenCalledWith({ page: 1, limit: 50 })
    })
    expect(mockedTaskApis.getTaskDetail).not.toHaveBeenCalled()
  })
})
