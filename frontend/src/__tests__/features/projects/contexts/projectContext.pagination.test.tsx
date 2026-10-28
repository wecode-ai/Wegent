// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { projectApis } from '@/apis/projects'
import { taskApis } from '@/apis/tasks'
import { ProjectProvider, useProjectContext } from '@/features/projects/contexts/projectContext'
import type { ProjectTaskPageState } from '@/features/projects/contexts/useProjectTaskPages'
import type {
  ProjectTask,
  ProjectTaskListResponse,
  ProjectWithTasks,
  TaskDetail,
} from '@/types/api'

let mockUser = { id: 7, user_name: 'test-user' }
let mockIsConnected = false
const mockToast = jest.fn()
const mockSearchParams = new URLSearchParams()
const mockRegisterTaskHandlers = jest.fn()

jest.mock('next/navigation', () => ({ useSearchParams: () => mockSearchParams }))
jest.mock('@/apis/projects', () => ({
  projectApis: {
    getProjects: jest.fn(),
    getProjectTasks: jest.fn(),
    updateProject: jest.fn(),
    addTaskToProject: jest.fn(),
    removeTaskFromProject: jest.fn(),
  },
}))
jest.mock('@/apis/tasks', () => ({ taskApis: { getTaskDetail: jest.fn() } }))
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('@/lib/runtime-config', () => ({
  getRuntimeConfigSync: () => ({ enableProjectWorkspace: true }),
}))
jest.mock('@/features/common/UserContext', () => ({ useUser: () => ({ user: mockUser }) }))
jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    isConnected: mockIsConnected,
    registerTaskHandlers: mockRegisterTaskHandlers,
  }),
}))

const api = projectApis as jest.Mocked<typeof projectApis>
const taskApi = taskApis as jest.Mocked<typeof taskApis>

function project(id: number, count: number): ProjectWithTasks {
  return {
    id,
    user_id: 7,
    name: `Group ${id}`,
    description: '',
    color: null,
    sort_order: id,
    is_expanded: true,
    task_count: count,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    tasks: [],
  }
}

function task(id: number, projectId = 1): ProjectTask {
  return {
    task_id: id,
    task_title: `Task ${id}`,
    task_status: 'COMPLETED',
    is_group_chat: false,
    project_id: projectId,
  }
}

function taskPage(
  total: number,
  items: ProjectTask[],
  nextCursor: string | null = null
): ProjectTaskListResponse {
  return { total, items, has_more: nextCursor !== null, next_cursor: nextCursor }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function Probe() {
  const {
    projects,
    projectTaskPages,
    loadProjectTasks,
    loadAllProjectTasks,
    refreshProjects,
    addTaskToProject,
    removeTaskFromProject,
    selectedProjectTask,
    selectedProjectTaskId,
    expandedProjects,
    toggleProjectExpanded,
    isProjectSectionCollapsed,
    setProjectSectionCollapsed,
  } = useProjectContext()
  return (
    <div>
      <output data-testid="projects">{JSON.stringify(projects)}</output>
      <output data-testid="pages">{JSON.stringify(projectTaskPages)}</output>
      <output data-testid="selected-task">{JSON.stringify(selectedProjectTask)}</output>
      <output data-testid="selected-task-id">{selectedProjectTaskId ?? 'none'}</output>
      <output data-testid="expanded-projects">{JSON.stringify([...expandedProjects])}</output>
      <output data-testid="section-collapsed">{String(isProjectSectionCollapsed)}</output>
      <button onClick={() => toggleProjectExpanded(1)}>toggle group</button>
      <button onClick={() => setProjectSectionCollapsed(true)}>collapse section</button>
      <button onClick={() => void loadProjectTasks(1)}>load first</button>
      <button onClick={() => void loadProjectTasks(1, true)}>load more</button>
      <button onClick={() => void loadAllProjectTasks(1)}>load all</button>
      <button onClick={() => void loadProjectTasks(2)}>load other group</button>
      <button onClick={() => void refreshProjects()}>refresh</button>
      <button onClick={() => void addTaskToProject(2, 201)}>move</button>
      <button onClick={() => void removeTaskFromProject(2, 201)}>remove</button>
      <button onClick={() => void addTaskToProject(2, 51)}>move selected</button>
    </div>
  )
}

function currentProjects(): ProjectWithTasks[] {
  return JSON.parse(screen.getByTestId('projects').textContent || '[]')
}

function currentPage(): ProjectTaskPageState & { nextCursor: string | null } {
  return JSON.parse(screen.getByTestId('pages').textContent || '{}')[1]
}

function renderProvider() {
  return render(
    <ProjectProvider>
      <Probe />
    </ProjectProvider>
  )
}

describe('ProjectContext task pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUser = { id: 7, user_name: 'test-user' }
    mockIsConnected = false
    mockSearchParams.delete('taskId')
    mockSearchParams.delete('projectId')
    api.getProjects.mockResolvedValue({ total: 2, items: [project(1, 120), project(2, 10)] })
    api.getProjectTasks.mockResolvedValue(taskPage(0, []))
    api.updateProject.mockResolvedValue(project(1, 120))
  })

  test('loads metadata without downloading expanded groups and appends deduplicated pages', async () => {
    api.getProjectTasks
      .mockResolvedValueOnce(
        taskPage(
          120,
          Array.from({ length: 50 }, (_, i) => task(i + 1)),
          'after-first'
        )
      )
      .mockResolvedValueOnce(taskPage(120, [task(50), task(51)], 'after-second'))
    renderProvider()
    await waitFor(() => expect(currentProjects()).toHaveLength(2))
    expect(api.getProjects).toHaveBeenCalledWith(false)
    expect(api.getProjectTasks).not.toHaveBeenCalled()
    expect(currentProjects()[0].task_count).toBe(120)

    fireEvent.click(screen.getByText('load first'))
    await waitFor(() => expect(currentProjects()[0].tasks).toHaveLength(50))
    fireEvent.click(screen.getByText('load more'))
    await waitFor(() => expect(currentProjects()[0].tasks).toHaveLength(51))
    expect(api.getProjectTasks.mock.calls).toEqual([
      [1, 50, undefined],
      [1, 50, 'after-first'],
    ])
    expect(currentProjects()[0].task_count).toBe(120)
    expect(currentPage()).toMatchObject({ hasMore: true, nextCursor: 'after-second' })
  })

  test('retries a failed first page without a cursor', async () => {
    api.getProjectTasks.mockRejectedValueOnce(new Error('first page failed'))
    renderProvider()
    await waitFor(() => expect(currentProjects()).toHaveLength(2))

    fireEvent.click(screen.getByText('load first'))
    await waitFor(() => expect(currentPage()).toMatchObject({ loaded: false, loading: false }))
    expect(currentPage().error).toBe('first page failed')
    expect(currentProjects()[0].tasks).toEqual([])

    api.getProjectTasks.mockResolvedValueOnce(taskPage(1, [task(1)]))
    fireEvent.click(screen.getByText('load first'))
    await waitFor(() => expect(currentProjects()[0].tasks).toEqual([task(1)]))
    expect(api.getProjectTasks.mock.calls).toEqual([
      [1, 50, undefined],
      [1, 50, undefined],
    ])
    expect(currentPage()).toEqual({
      loaded: true,
      loading: false,
      hasMore: false,
      nextCursor: null,
    })
  })

  test.each([50, 100])('stops without an extra request after exactly %i tasks', async total => {
    api.getProjects.mockResolvedValue({ total: 1, items: [project(1, total)] })
    api.getProjectTasks.mockResolvedValueOnce(
      taskPage(
        total,
        Array.from({ length: 50 }, (_, index) => task(index + 1)),
        total === 100 ? 'after-50' : null
      )
    )
    if (total === 100) {
      api.getProjectTasks.mockResolvedValueOnce(
        taskPage(
          total,
          Array.from({ length: 50 }, (_, index) => task(index + 51))
        )
      )
    }
    renderProvider()
    await waitFor(() => expect(currentProjects()).toHaveLength(1))
    fireEvent.click(screen.getByText('load first'))
    await waitFor(() => expect(currentProjects()[0].tasks).toHaveLength(50))
    expect(currentPage().hasMore).toBe(total === 100)

    if (total === 100) {
      fireEvent.click(screen.getByText('load more'))
      await waitFor(() => expect(currentProjects()[0].tasks).toHaveLength(100))
      expect(api.getProjectTasks).toHaveBeenLastCalledWith(1, 50, 'after-50')
    }
    expect(currentPage()).toMatchObject({ hasMore: false, nextCursor: null })
    fireEvent.click(screen.getByText('load more'))
    expect(api.getProjectTasks).toHaveBeenCalledTimes(total / 50)
  })

  test('loads an empty group once and stops', async () => {
    api.getProjects.mockResolvedValue({ total: 1, items: [project(1, 0)] })
    renderProvider()
    await waitFor(() => expect(currentProjects()).toHaveLength(1))
    fireEvent.click(screen.getByText('load first'))
    await waitFor(() => expect(currentPage()).toMatchObject({ loaded: true, hasMore: false }))
    fireEvent.click(screen.getByText('load more'))
    expect(currentProjects()[0].tasks).toEqual([])
    expect(api.getProjectTasks).toHaveBeenCalledTimes(1)
  })

  test('uses the server end marker even when the total still exceeds the loaded items', async () => {
    api.getProjectTasks.mockResolvedValueOnce(taskPage(120, [task(1)]))
    renderProvider()
    await waitFor(() => expect(currentProjects()).toHaveLength(2))
    fireEvent.click(screen.getByText('load first'))
    await waitFor(() => expect(currentProjects()[0].tasks).toEqual([task(1)]))
    expect(currentPage().hasMore).toBe(false)
    fireEvent.click(screen.getByText('load more'))
    expect(api.getProjectTasks).toHaveBeenCalledTimes(1)
  })

  test('stops at an empty final page without discarding earlier tasks', async () => {
    const firstPageTasks = Array.from({ length: 50 }, (_, index) => task(index + 1))
    api.getProjectTasks
      .mockResolvedValueOnce(taskPage(51, firstPageTasks, 'after-50'))
      .mockResolvedValueOnce(taskPage(50, []))
    renderProvider()
    await waitFor(() => expect(currentProjects()).toHaveLength(2))
    fireEvent.click(screen.getByText('load first'))
    await waitFor(() => expect(currentProjects()[0].tasks).toHaveLength(50))
    fireEvent.click(screen.getByText('load more'))
    await waitFor(() => expect(currentPage()).toMatchObject({ hasMore: false, nextCursor: null }))
    expect(currentProjects()[0].tasks).toEqual(firstPageTasks)
    expect(currentProjects()[0].task_count).toBe(50)
    fireEvent.click(screen.getByText('load more'))
    expect(api.getProjectTasks).toHaveBeenCalledTimes(2)
  })

  test('loads every project task page for mention candidates', async () => {
    const firstPageTasks = Array.from({ length: 50 }, (_, index) => task(index + 1))
    const secondPageTasks = Array.from({ length: 50 }, (_, index) => task(index + 51))
    const finalPageTasks = [task(101)]
    api.getProjectTasks
      .mockResolvedValueOnce(taskPage(101, firstPageTasks, 'after-first'))
      .mockResolvedValueOnce(taskPage(101, secondPageTasks, 'after-second'))
      .mockResolvedValueOnce(taskPage(101, finalPageTasks))
    renderProvider()
    await waitFor(() => expect(currentProjects()).toHaveLength(2))

    fireEvent.click(screen.getByText('load all'))
    await waitFor(() => expect(currentProjects()[0].tasks).toHaveLength(101))
    expect(api.getProjectTasks.mock.calls).toEqual([
      [1, 50, undefined],
      [1, 50, 'after-first'],
      [1, 50, 'after-second'],
    ])
    expect(currentPage()).toMatchObject({
      loaded: true,
      loading: false,
      hasMore: false,
      nextCursor: null,
    })
  })

  test('retries a failed all-pages load only when invoked again', async () => {
    api.getProjectTasks
      .mockResolvedValueOnce(taskPage(101, [task(1)], 'after-first'))
      .mockRejectedValueOnce(new Error('second page failed'))
    renderProvider()
    await waitFor(() => expect(currentProjects()).toHaveLength(2))

    fireEvent.click(screen.getByText('load all'))
    await waitFor(() => expect(currentPage().error).toBe('second page failed'))
    expect(api.getProjectTasks).toHaveBeenCalledTimes(2)
    expect(currentProjects()[0].tasks).toEqual([task(1)])

    api.getProjectTasks.mockResolvedValueOnce(taskPage(101, [task(51)]))
    fireEvent.click(screen.getByText('load all'))
    await waitFor(() => expect(currentProjects()[0].tasks).toEqual([task(1), task(51)]))
    expect(api.getProjectTasks.mock.calls).toEqual([
      [1, 50, undefined],
      [1, 50, 'after-first'],
      [1, 50, 'after-first'],
    ])
    expect(currentPage()).toMatchObject({
      loaded: true,
      loading: false,
      hasMore: false,
      nextCursor: null,
    })
  })

  test('blocks overlapping requests and retries the same cursor without discarding its first page', async () => {
    const pending = deferred<ProjectTaskListResponse>()
    api.getProjectTasks.mockReturnValueOnce(pending.promise)
    renderProvider()
    await waitFor(() => expect(currentProjects()).toHaveLength(2))
    fireEvent.click(screen.getByText('load first'))
    fireEvent.click(screen.getByText('load more'))
    expect(api.getProjectTasks).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(taskPage(120, [task(1)], 'after-first')))

    api.getProjectTasks.mockRejectedValueOnce(new Error('request failed'))
    fireEvent.click(screen.getByText('load more'))
    await waitFor(() => expect(screen.getByTestId('pages')).toHaveTextContent('request failed'))
    expect(currentProjects()[0].tasks).toEqual([task(1)])
    api.getProjectTasks.mockResolvedValueOnce(taskPage(120, [task(51)], 'after-second'))
    fireEvent.click(screen.getByText('load more'))
    await waitFor(() => expect(currentProjects()[0].tasks).toHaveLength(2))
    expect(api.getProjectTasks.mock.calls).toEqual([
      [1, 50, undefined],
      [1, 50, 'after-first'],
      [1, 50, 'after-first'],
    ])
    expect(currentPage()).toMatchObject({ nextCursor: 'after-second', hasMore: true })
  })

  test('discards a page response when metadata has been refreshed', async () => {
    const pending = deferred<ProjectTaskListResponse>()
    api.getProjectTasks.mockReturnValueOnce(pending.promise)
    renderProvider()
    await waitFor(() => expect(currentProjects()).toHaveLength(2))
    fireEvent.click(screen.getByText('load first'))
    api.getProjects.mockResolvedValue({ total: 1, items: [project(1, 9)] })
    fireEvent.click(screen.getByText('refresh'))
    await waitFor(() => expect(currentProjects()[0].task_count).toBe(9))
    await act(async () => pending.resolve(taskPage(120, [task(99)], 'old-cursor')))
    expect(currentProjects()[0].tasks).toEqual([])
    expect(currentProjects()[0].task_count).toBe(9)
    expect(screen.getByTestId('pages')).toHaveTextContent('{}')
  })

  test('merges task notifications without losing loaded pages or a concurrent pagination cursor', async () => {
    mockIsConnected = true
    mockSearchParams.set('taskId', '51')
    taskApi.getTaskDetail.mockResolvedValue({
      id: 51,
      title: 'Selected grouped task',
      status: 'COMPLETED',
      project_id: 1,
    } as TaskDetail)
    const firstTasks = Array.from({ length: 50 }, (_, index) => task(index + 1))
    const secondTasks = Array.from({ length: 50 }, (_, index) => task(index + 51))
    const otherTasks = [task(201, 2)]
    api.getProjectTasks
      .mockResolvedValueOnce(taskPage(120, firstTasks, 'after-first'))
      .mockResolvedValueOnce(taskPage(120, secondTasks, 'after-second'))
      .mockResolvedValueOnce(taskPage(10, otherTasks))
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('selected-task-id')).toHaveTextContent('51'))
    fireEvent.click(screen.getByText('load first'))
    await waitFor(() => expect(currentProjects()[0].tasks).toHaveLength(50))
    fireEvent.click(screen.getByText('load more'))
    await waitFor(() => expect(currentProjects()[0].tasks).toHaveLength(100))
    fireEvent.click(screen.getByText('load other group'))
    await waitFor(() => expect(currentProjects()[1].tasks).toEqual(otherTasks))

    const pendingPage = deferred<ProjectTaskListResponse>()
    api.getProjectTasks
      .mockReturnValueOnce(pendingPage.promise)
      .mockResolvedValueOnce(taskPage(121, [task(121), ...firstTasks.slice(0, 49)], 'head-cursor'))
    api.getProjects.mockResolvedValue({
      total: 3,
      items: [project(1, 121), project(2, 10), project(3, 0)],
    })
    taskApi.getTaskDetail.mockClear()
    fireEvent.click(screen.getByText('load more'))
    const handlers = mockRegisterTaskHandlers.mock.calls[0][0]
    await act(async () => handlers.onTaskCreated({ project_id: 1 }))
    await waitFor(() => expect(currentProjects()[0].tasks).toHaveLength(101))
    expect(currentProjects()[0].tasks[0].task_id).toBe(121)
    expect(currentPage()).toMatchObject({
      loaded: true,
      loading: true,
      hasMore: true,
      nextCursor: 'after-second',
    })
    expect(currentProjects()[1].tasks).toEqual(otherTasks)
    expect(currentProjects()[2].id).toBe(3)
    expect(api.getProjectTasks.mock.calls.filter(([id]) => id === 2)).toHaveLength(1)
    expect(taskApi.getTaskDetail).not.toHaveBeenCalled()

    await act(async () =>
      pendingPage.resolve(
        taskPage(
          121,
          Array.from({ length: 20 }, (_, index) => task(index + 101))
        )
      )
    )
    expect(currentProjects()[0].tasks).toHaveLength(121)
    expect(currentPage()).toMatchObject({ loading: false, hasMore: false, nextCursor: null })
  })

  test('resolves a deep-linked task when a notification supersedes initial metadata loading', async () => {
    mockIsConnected = true
    mockSearchParams.set('taskId', '51')
    const initialMetadata = deferred<{ total: number; items: ProjectWithTasks[] }>()
    api.getProjects
      .mockReturnValueOnce(initialMetadata.promise)
      .mockResolvedValueOnce({ total: 1, items: [project(1, 121)] })
    taskApi.getTaskDetail.mockResolvedValue({
      id: 51,
      title: 'Selected grouped task',
      status: 'COMPLETED',
      project_id: 1,
    } as TaskDetail)
    renderProvider()
    const handlers = mockRegisterTaskHandlers.mock.calls[0][0]
    await act(async () => handlers.onTaskCreated({ project_id: 1 }))
    await waitFor(() => expect(screen.getByTestId('selected-task-id')).toHaveTextContent('51'))
    expect(currentProjects()[0].task_count).toBe(121)
    expect(taskApi.getTaskDetail).toHaveBeenCalledTimes(1)
    await act(async () => initialMetadata.resolve({ total: 1, items: [project(1, 120)] }))
    expect(currentProjects()[0].task_count).toBe(121)
  })

  test('discards pages from a previous account and clears its cache', async () => {
    const pending = deferred<ProjectTaskListResponse>()
    api.getProjectTasks.mockReturnValueOnce(pending.promise)
    const view = renderProvider()
    await waitFor(() => expect(currentProjects()).toHaveLength(2))
    fireEvent.click(screen.getByText('load first'))
    mockUser = { id: 8, user_name: 'other-user' }
    api.getProjects.mockResolvedValue({ total: 1, items: [project(1, 3)] })
    view.rerender(
      <ProjectProvider>
        <Probe />
      </ProjectProvider>
    )
    await waitFor(() => expect(currentProjects()[0].task_count).toBe(3))
    const accountTasks = [task(1), task(2), task(3)]
    api.getProjectTasks.mockResolvedValueOnce(taskPage(3, accountTasks))
    fireEvent.click(screen.getByText('load first'))
    await waitFor(() => expect(currentProjects()[0].tasks).toEqual(accountTasks))
    await act(async () => pending.resolve(taskPage(120, [task(99)], 'old-cursor')))
    expect(currentProjects()[0].tasks).toEqual(accountTasks)
    expect(currentProjects()[0].task_count).toBe(3)
    expect(currentPage()).toMatchObject({ nextCursor: null, hasMore: false })
  })

  test('uses authoritative counts after moving an unloaded task and removing it', async () => {
    api.addTaskToProject.mockResolvedValue({ message: 'ok', project_task: task(201, 2) })
    api.removeTaskFromProject.mockResolvedValue({ message: 'ok' })
    renderProvider()
    await waitFor(() => expect(currentProjects()).toHaveLength(2))
    api.getProjects.mockResolvedValue({ total: 2, items: [project(1, 119), project(2, 11)] })
    fireEvent.click(screen.getByText('move'))
    await waitFor(() => expect(currentProjects().map(item => item.task_count)).toEqual([119, 11]))
    expect(currentProjects().every(item => item.tasks.length === 0)).toBe(true)

    api.getProjects.mockResolvedValue({ total: 2, items: [project(1, 119), project(2, 10)] })
    fireEvent.click(screen.getByText('remove'))
    await waitFor(() => expect(api.getProjects).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(currentProjects().map(item => item.task_count)).toEqual([119, 10]))
  })

  test('preserves cached pages when association mutation fails', async () => {
    api.getProjectTasks.mockResolvedValue(taskPage(120, [task(1)], 'after-first'))
    api.removeTaskFromProject.mockRejectedValue(new Error('request failed'))
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      renderProvider()
      await waitFor(() => expect(currentProjects()).toHaveLength(2))
      fireEvent.click(screen.getByText('load first'))
      await waitFor(() => expect(currentProjects()[0].tasks).toEqual([task(1)]))
      fireEvent.click(screen.getByText('remove'))
      await waitFor(() => expect(mockToast).toHaveBeenCalled())
      expect(currentProjects()[0].tasks).toEqual([task(1)])
      expect(currentProjects()[1].task_count).toBe(10)
      expect(api.getProjects).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('pages')).toHaveTextContent('"loaded":true')
    } finally {
      errorLog.mockRestore()
    }
  })

  test('preserves manual collapse of the selected task group while tasks load', async () => {
    mockSearchParams.set('taskId', '51')
    taskApi.getTaskDetail.mockResolvedValue({
      id: 51,
      title: 'Selected grouped task',
      status: 'COMPLETED',
      project_id: 1,
    } as TaskDetail)
    api.getProjectTasks.mockResolvedValue(taskPage(120, [task(1)], 'after-first'))
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('selected-task-id')).toHaveTextContent('51'))

    fireEvent.click(screen.getByText('toggle group'))
    fireEvent.click(screen.getByText('collapse section'))
    fireEvent.click(screen.getByText('load first'))

    await waitFor(() => expect(currentProjects()[0].tasks).toEqual([task(1)]))
    expect(screen.getByTestId('expanded-projects')).toHaveTextContent('[2]')
    expect(screen.getByTestId('section-collapsed')).toHaveTextContent('true')
    expect(api.updateProject).toHaveBeenCalledWith(1, { is_expanded: false })
    expect(currentProjects()[0].is_expanded).toBe(false)

    fireEvent.click(screen.getByText('toggle group'))
    expect(screen.getByTestId('expanded-projects')).toHaveTextContent('[2,1]')
    expect(api.updateProject).toHaveBeenLastCalledWith(1, { is_expanded: true })
  })

  test('preserves route expansion and manual collapse across metadata refreshes', async () => {
    mockSearchParams.set('taskId', '51')
    taskApi.getTaskDetail.mockResolvedValue({
      id: 51,
      title: 'Selected grouped task',
      status: 'COMPLETED',
      project_id: 1,
    } as TaskDetail)
    api.getProjects.mockResolvedValue({
      total: 2,
      items: [{ ...project(1, 120), is_expanded: false }, project(2, 10)],
    })
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('selected-task-id')).toHaveTextContent('51'))
    expect(screen.getByTestId('expanded-projects')).toHaveTextContent('[2,1]')

    api.getProjects.mockResolvedValue({
      total: 2,
      items: [{ ...project(1, 121), is_expanded: false }, project(3, 1)],
    })
    fireEvent.click(screen.getByText('refresh'))
    await waitFor(() => expect(currentProjects()[0].task_count).toBe(121))
    expect(screen.getByTestId('expanded-projects')).toHaveTextContent('[1,3]')

    fireEvent.click(screen.getByText('toggle group'))
    expect(screen.getByTestId('expanded-projects')).toHaveTextContent('[3]')
    api.getProjects.mockResolvedValue({
      total: 2,
      items: [project(1, 122), { ...project(3, 1), is_expanded: false }],
    })
    fireEvent.click(screen.getByText('refresh'))
    await waitFor(() => expect(currentProjects()[0].task_count).toBe(122))
    expect(screen.getByTestId('expanded-projects')).toHaveTextContent('[3]')
  })

  test('follows the selected task move despite a stale route group and preserves expanded groups', async () => {
    mockSearchParams.set('taskId', '51')
    mockSearchParams.set('projectId', '1')
    api.getProjects.mockResolvedValue({
      total: 2,
      items: [project(1, 120), { ...project(2, 10), is_expanded: false }],
    })
    const detail = {
      id: 51,
      title: 'Older selected task',
      status: 'COMPLETED',
      project_id: 1,
      updated_at: '2026-01-01T00:00:00Z',
    } as TaskDetail
    taskApi.getTaskDetail.mockResolvedValue(detail)
    api.getProjectTasks.mockResolvedValue(
      taskPage(
        120,
        Array.from({ length: 50 }, (_, i) => task(i + 1)),
        'after-first'
      )
    )
    renderProvider()
    await waitFor(() =>
      expect(screen.getByTestId('selected-task')).toHaveTextContent('"task_id":51')
    )
    expect(screen.getByTestId('expanded-projects')).toHaveTextContent('[1]')
    fireEvent.click(screen.getByText('load first'))
    await waitFor(() => expect(currentProjects()[0].tasks).toHaveLength(50))
    expect(screen.getByTestId('selected-task-id')).toHaveTextContent('51')
    expect(screen.getByTestId('selected-task')).toHaveTextContent('Older selected task')
    expect(taskApi.getTaskDetail).toHaveBeenCalledTimes(1)

    api.addTaskToProject.mockResolvedValue({ message: 'ok', project_task: task(51, 2) })
    taskApi.getTaskDetail.mockResolvedValue({ ...detail, project_id: 2 })
    api.getProjects.mockResolvedValue({
      total: 2,
      items: [
        { ...project(1, 119), is_expanded: false },
        { ...project(2, 11), is_expanded: false },
      ],
    })
    fireEvent.click(screen.getByText('move selected'))
    await waitFor(() =>
      expect(screen.getByTestId('selected-task')).toHaveTextContent('"project_id":2')
    )
    await waitFor(() => expect(screen.getByTestId('expanded-projects')).toHaveTextContent('[1,2]'))
    expect(taskApi.getTaskDetail).toHaveBeenCalledTimes(2)
  })
})
