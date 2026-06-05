// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, render, waitFor } from '@testing-library/react'

import { ApiError } from '@/apis/client'
import { taskApis } from '@/apis/tasks'
import { TaskSessionProvider, useTaskSession } from '@/features/tasks/session/TaskSession'
import type { Task, TaskDetail } from '@/types/api'

let mockVisibleHandler: ((wasHiddenFor: number) => void) | null = null
let mockIsConnected = true

const mockJoinTask = jest.fn()
const mockLeaveTask = jest.fn()

const mockSocketContext = {
  get isConnected() {
    return mockIsConnected
  },
  joinTask: mockJoinTask,
  leaveTask: mockLeaveTask,
  sendChatMessage: jest.fn(),
  cancelChatStream: jest.fn(),
  registerChatHandlers: jest.fn(() => jest.fn()),
  registerSkillHandlers: jest.fn(() => jest.fn()),
  registerTaskHandlers: jest.fn(() => jest.fn()),
  sendSkillResponse: jest.fn(),
  onReconnect: jest.fn(() => jest.fn()),
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
  id: 713,
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

const sessionProbe: {
  current: ReturnType<typeof useTaskSession> | null
} = {
  current: null,
}

function SessionProbe() {
  sessionProbe.current = useTaskSession()
  return null
}

describe('TaskSessionProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    sessionProbe.current = null
    mockVisibleHandler = null
    mockIsConnected = true

    mockJoinTask.mockResolvedValue({ subtasks: [] })
    mockedTaskApis.getGroupTasksLite.mockResolvedValue(taskListResponse([]))
    mockedTaskApis.getPersonalTasksLite.mockResolvedValue(taskListResponse([createTask()]))
    mockedTaskApis.getTasksLite.mockResolvedValue(taskListResponse([]))
    mockedTaskApis.searchTasks.mockResolvedValue(taskListResponse([]))
    mockedTaskApis.getTaskDetail.mockResolvedValue(createTaskDetail())
    mockedTaskApis.getTaskRuntimeCheck.mockResolvedValue({
      task_id: 713,
      task_status: 'RUNNING',
      status_updated_at: '2026-06-01T10:00:00.000Z',
      active_stream: {
        subtask_id: 77,
        cursor: 10,
        last_activity_at: '2026-06-01T10:00:01.000Z',
      },
    })
  })

  it('opens the task room immediately when selecting a task without runtime check gating', async () => {
    render(
      <TaskSessionProvider>
        <SessionProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(sessionProbe.current).not.toBeNull()
    })

    act(() => {
      sessionProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(mockJoinTask).toHaveBeenCalledWith(
        713,
        expect.objectContaining({ forceRefresh: true })
      )
    })

    expect(mockedTaskApis.getTaskDetail).toHaveBeenCalledWith(713)
    expect(mockedTaskApis.getTaskRuntimeCheck).not.toHaveBeenCalled()
  })

  it('loads task detail after a new chat message resolves to a real task id', async () => {
    mockSocketContext.sendChatMessage.mockResolvedValue({
      task_id: 713,
      subtask_id: 714,
      message_id: 1,
    })

    render(
      <TaskSessionProvider>
        <SessionProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(sessionProbe.current).not.toBeNull()
    })

    mockedTaskApis.getTaskDetail.mockClear()

    await act(async () => {
      await sessionProbe.current?.sendMessage(
        {
          message: 'hello',
          team_id: 1,
          task_type: 'task',
        },
        {
          immediateTaskId: -1,
        }
      )
    })

    await waitFor(() => {
      expect(mockedTaskApis.getTaskDetail).toHaveBeenCalledWith(713)
    })
  })

  it('uses runtime check only for later consistency recovery', async () => {
    render(
      <TaskSessionProvider>
        <SessionProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(sessionProbe.current).not.toBeNull()
    })

    act(() => {
      sessionProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(mockJoinTask).toHaveBeenCalledTimes(1)
    })

    mockedTaskApis.getTaskRuntimeCheck.mockClear()
    mockJoinTask.mockClear()

    act(() => {
      mockVisibleHandler?.(3000)
    })

    await waitFor(() => {
      expect(mockedTaskApis.getTaskRuntimeCheck).toHaveBeenCalledWith(713)
    })

    await waitFor(() => {
      expect(mockJoinTask).toHaveBeenCalledWith(
        713,
        expect.objectContaining({
          forceRefresh: true,
          activeStreamSubtaskId: 77,
        })
      )
    })
  })

  it('keeps pending recovery and joins after the socket connects', async () => {
    mockIsConnected = false

    const renderTree = () => (
      <TaskSessionProvider>
        <SessionProbe />
      </TaskSessionProvider>
    )

    const { rerender } = render(renderTree())

    await waitFor(() => {
      expect(sessionProbe.current).not.toBeNull()
    })

    act(() => {
      sessionProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(sessionProbe.current?.taskState?.phase).toBe('waiting_socket')
    })
    expect(mockJoinTask).not.toHaveBeenCalled()

    act(() => {
      mockIsConnected = true
      rerender(renderTree())
    })

    await waitFor(() => {
      expect(mockJoinTask).toHaveBeenCalledWith(
        713,
        expect.objectContaining({ forceRefresh: true })
      )
    })
  })

  it('clears stale task detail immediately when switching tasks', async () => {
    const nextTask = createTask({ id: 714, title: 'Next task' })
    let resolveNextDetail: (detail: TaskDetail) => void = () => {}

    mockedTaskApis.getTaskDetail.mockImplementation(taskId => {
      if (taskId === 714) {
        return new Promise<TaskDetail>(resolve => {
          resolveNextDetail = resolve
        })
      }
      return Promise.resolve(createTaskDetail())
    })

    render(
      <TaskSessionProvider>
        <SessionProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(sessionProbe.current).not.toBeNull()
    })

    act(() => {
      sessionProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(sessionProbe.current?.selectedTaskDetail?.id).toBe(713)
    })

    act(() => {
      sessionProbe.current?.selectTask(nextTask)
    })

    await waitFor(() => {
      expect(sessionProbe.current?.taskState?.taskId).toBe(714)
    })
    expect(sessionProbe.current?.selectedTaskDetail).toBeNull()

    act(() => {
      resolveNextDetail(createTaskDetail({ id: 714, title: 'Next task' }))
    })

    await waitFor(() => {
      expect(sessionProbe.current?.selectedTaskDetail?.id).toBe(714)
    })
  })

  it('clears all current task state when selecting no task', async () => {
    mockedTaskApis.getTaskRuntimeCheck.mockResolvedValue({
      task_id: 713,
      task_status: 'RUNNING',
      status_updated_at: '2026-05-31T10:00:00.000Z',
      active_stream: { subtask_id: 88, cursor: 12 },
    })

    render(
      <TaskSessionProvider>
        <SessionProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(sessionProbe.current).not.toBeNull()
    })

    act(() => {
      sessionProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(sessionProbe.current?.selectedTaskDetail?.id).toBe(713)
    })

    await act(async () => {
      await sessionProbe.current?.recoverCurrentTask('manual-refresh')
    })

    expect(sessionProbe.current?.taskRuntimeSnapshot?.task_id).toBe(713)

    act(() => {
      sessionProbe.current?.selectTask(null)
    })

    expect(sessionProbe.current?.selectedTask).toBeNull()
    expect(sessionProbe.current?.selectedTaskDetail).toBeNull()
    expect(sessionProbe.current?.taskRuntimeSnapshot).toBeNull()
    expect(sessionProbe.current?.taskState).toBeNull()
  })

  it('ignores stale task detail when a task load finishes after starting a new conversation', async () => {
    let resolveDetail: (detail: TaskDetail) => void = () => {}
    mockedTaskApis.getTaskDetail.mockImplementation(
      () =>
        new Promise<TaskDetail>(resolve => {
          resolveDetail = resolve
        })
    )

    render(
      <TaskSessionProvider>
        <SessionProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(sessionProbe.current).not.toBeNull()
    })

    act(() => {
      sessionProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(sessionProbe.current?.taskState?.taskId).toBe(713)
    })

    act(() => {
      sessionProbe.current?.selectTask(null)
    })

    await act(async () => {
      resolveDetail(createTaskDetail())
    })

    expect(sessionProbe.current?.selectedTask).toBeNull()
    expect(sessionProbe.current?.selectedTaskDetail).toBeNull()
    expect(sessionProbe.current?.taskState).toBeNull()
  })

  it('ignores stale runtime snapshots when runtime check finishes after starting a new conversation', async () => {
    let resolveRuntime: (
      snapshot: Awaited<ReturnType<typeof taskApis.getTaskRuntimeCheck>>
    ) => void = () => {}
    mockedTaskApis.getTaskRuntimeCheck.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveRuntime = resolve
        })
    )

    render(
      <TaskSessionProvider>
        <SessionProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(sessionProbe.current).not.toBeNull()
    })

    act(() => {
      sessionProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(sessionProbe.current?.selectedTaskDetail?.id).toBe(713)
    })

    let recoveryPromise: Promise<void> | undefined
    act(() => {
      recoveryPromise = sessionProbe.current?.recoverCurrentTask('manual-refresh')
    })

    act(() => {
      sessionProbe.current?.selectTask(null)
    })

    await act(async () => {
      resolveRuntime({
        task_id: 713,
        task_status: 'COMPLETED',
        status_updated_at: '2026-06-01T10:00:00.000Z',
        active_stream: null,
      })
      await recoveryPromise
    })

    expect(sessionProbe.current?.selectedTask).toBeNull()
    expect(sessionProbe.current?.selectedTaskDetail).toBeNull()
    expect(sessionProbe.current?.taskRuntimeSnapshot).toBeNull()
    expect(sessionProbe.current?.taskState).toBeNull()
  })

  it('clears access denied state when selecting no task', async () => {
    mockedTaskApis.getTaskDetail.mockRejectedValue(new ApiError('Forbidden', 403))

    render(
      <TaskSessionProvider>
        <SessionProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(sessionProbe.current).not.toBeNull()
    })

    act(() => {
      sessionProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(sessionProbe.current?.accessDenied).toBe(true)
    })

    act(() => {
      sessionProbe.current?.selectTask(null)
    })

    expect(sessionProbe.current?.selectedTask).toBeNull()
    expect(sessionProbe.current?.selectedTaskDetail).toBeNull()
    expect(sessionProbe.current?.taskRuntimeSnapshot).toBeNull()
    expect(sessionProbe.current?.taskState).toBeNull()
    expect(sessionProbe.current?.accessDenied).toBe(false)
  })

  it('ignores stale join results from the previous selected task', async () => {
    const previousTask = createTask({ id: 711, title: 'Previous task' })
    const nextTask = createTask({ id: 713, title: 'Next task' })
    let resolvePreviousJoin: (value: {
      subtasks: Array<Record<string, unknown>>
    }) => void = () => {}

    mockJoinTask.mockImplementation(taskId => {
      if (taskId === 711) {
        return new Promise(resolve => {
          resolvePreviousJoin = resolve
        })
      }
      return Promise.resolve({
        subtasks: [
          {
            id: 99,
            role: 'TEAM',
            status: 'COMPLETED',
            result: { value: 'next task answer' },
            message_id: 9,
            created_at: '2026-06-01T10:00:00.000Z',
            updated_at: '2026-06-01T10:00:00.000Z',
            completed_at: '2026-06-01T10:00:00.000Z',
            bots: [],
          },
        ],
      })
    })

    render(
      <TaskSessionProvider>
        <SessionProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(sessionProbe.current).not.toBeNull()
    })

    act(() => {
      sessionProbe.current?.selectTask(previousTask)
    })

    await waitFor(() => {
      expect(mockJoinTask).toHaveBeenCalledWith(
        711,
        expect.objectContaining({ forceRefresh: true })
      )
    })

    act(() => {
      sessionProbe.current?.selectTask(nextTask)
    })

    await waitFor(() => {
      expect(sessionProbe.current?.taskState?.taskId).toBe(713)
    })

    act(() => {
      resolvePreviousJoin({
        subtasks: [
          {
            id: 88,
            role: 'TEAM',
            status: 'COMPLETED',
            result: { value: 'previous task answer' },
            message_id: 8,
            created_at: '2026-06-01T09:00:00.000Z',
            updated_at: '2026-06-01T09:00:00.000Z',
            completed_at: '2026-06-01T09:00:00.000Z',
            bots: [],
          },
        ],
      })
    })

    await waitFor(() => {
      expect(sessionProbe.current?.messages.get('ai-99')?.content).toBe('next task answer')
    })
    expect(sessionProbe.current?.taskState?.taskId).toBe(713)
    expect(sessionProbe.current?.messages.has('ai-88')).toBe(false)
    expect(mockLeaveTask).toHaveBeenCalledWith(711)
  })

  it('does not reopen the current task when URL sync selects the same task again', async () => {
    let resolveJoin: (value: { subtasks: Array<Record<string, unknown>> }) => void = () => {}
    mockJoinTask.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveJoin = resolve
        })
    )

    render(
      <TaskSessionProvider>
        <SessionProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(sessionProbe.current).not.toBeNull()
    })

    act(() => {
      sessionProbe.current?.selectTask(createTask({ id: 713, title: 'Full task' }))
    })

    await waitFor(() => {
      expect(mockJoinTask).toHaveBeenCalledTimes(1)
    })

    act(() => {
      sessionProbe.current?.selectTask({ id: 713 } as Task)
    })

    act(() => {
      resolveJoin({ subtasks: [] })
    })

    await waitFor(() => {
      expect(sessionProbe.current?.taskState?.phase).toBe('ready')
    })
    expect(mockJoinTask).toHaveBeenCalledTimes(1)
  })

  it('keeps selectTask stable after selecting a task', async () => {
    render(
      <TaskSessionProvider>
        <SessionProbe />
      </TaskSessionProvider>
    )

    await waitFor(() => {
      expect(sessionProbe.current).not.toBeNull()
    })

    const initialSelectTask = sessionProbe.current?.selectTask

    act(() => {
      sessionProbe.current?.selectTask(createTask())
    })

    await waitFor(() => {
      expect(sessionProbe.current?.taskState?.taskId).toBe(713)
    })

    expect(sessionProbe.current?.selectTask).toBe(initialSelectTask)
  })
})
