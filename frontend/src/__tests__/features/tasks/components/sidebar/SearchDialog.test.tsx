// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'

import { taskApis } from '@/apis/tasks'
import { projectApis } from '@/apis/projects'
import SearchDialog from '@/features/tasks/components/sidebar/SearchDialog'
import type { ProjectTask, ProjectTaskListResponse, Task } from '@/types/api'

const mockPush = jest.fn()
const mockSelectTask = jest.fn()
const mockRecentTask = {
  id: 900,
  title: 'Recent global task',
  status: 'COMPLETED',
  created_at: '2026-01-01T00:00:00Z',
} as Task

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}))

jest.mock('@/apis/tasks', () => ({ taskApis: { searchTasks: jest.fn() } }))
jest.mock('@/apis/projects', () => ({ projectApis: { getProjectTasks: jest.fn() } }))

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({ tasks: [mockRecentTask], selectTask: mockSelectTask }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key}: ${options.name}` : key,
  }),
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

const searchTasksMock = jest.mocked(taskApis.searchTasks)
const projectTasksMock = jest.mocked(projectApis.getProjectTasks)

const createProjectTask = (id: number): ProjectTask => ({
  task_id: id,
  task_title: `Matching task ${id}`,
  task_status: 'COMPLETED',
  project_id: 7,
  is_group_chat: false,
})

const projectResponse = (items: ProjectTask[], cursor?: string): ProjectTaskListResponse => ({
  items,
  total: cursor ? 21 : items.length,
  has_more: Boolean(cursor),
  next_cursor: cursor ?? null,
})

const searchFor = async (term: string) => {
  fireEvent.change(screen.getByTestId('task-search-input'), { target: { value: term } })
  await act(async () => {
    jest.advanceTimersByTime(300)
  })
}

const loadDefaultTasks = async () => {
  await act(async () => {
    jest.advanceTimersByTime(0)
  })
}

const deferredResponse = () => {
  let resolve!: (value: ProjectTaskListResponse) => void
  const promise = new Promise<ProjectTaskListResponse>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('SearchDialog group search', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    searchTasksMock.mockReset()
    searchTasksMock.mockResolvedValue({ total: 0, items: [] })
    projectTasksMock.mockReset()
    projectTasksMock.mockResolvedValue(projectResponse([]))
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('reuses loaded group pages and restores them after a server keyword search', async () => {
    const cachedTasks = Array.from({ length: 100 }, (_, index) => createProjectTask(index + 1))
    const loadTasks = jest.fn().mockResolvedValue(undefined)
    const projectTaskList = {
      tasks: cachedTasks,
      page: { loaded: true, loading: false, hasMore: true },
      loadTasks,
    }
    const onOpenChange = jest.fn()
    const { rerender } = render(
      <SearchDialog
        open
        projectId={7}
        projectTaskList={projectTaskList}
        onOpenChange={onOpenChange}
      />
    )

    expect(screen.getAllByTestId(/^task-search-result-/)).toHaveLength(100)
    await loadDefaultTasks()
    expect(projectTasksMock).not.toHaveBeenCalled()
    expect(loadTasks).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('task-search-load-more-button'))
    expect(loadTasks).toHaveBeenCalledWith(true)

    projectTasksMock.mockResolvedValueOnce(projectResponse([createProjectTask(201)]))
    await searchFor('outside loaded pages')
    expect(projectTasksMock).toHaveBeenCalledWith(7, 20, undefined, 'outside loaded pages')
    expect(screen.getByTestId('task-search-result-201')).toBeInTheDocument()
    expect(screen.queryByTestId('task-search-result-1')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('task-search-clear-button'))
    await loadDefaultTasks()
    expect(screen.getAllByTestId(/^task-search-result-/)).toHaveLength(100)
    expect(projectTasksMock).toHaveBeenCalledTimes(1)
    expect(loadTasks).toHaveBeenCalledTimes(1)

    rerender(
      <SearchDialog
        open
        projectId={7}
        projectTaskList={{
          ...projectTaskList,
          tasks: [...cachedTasks, createProjectTask(101)],
          page: { loaded: true, loading: false, hasMore: false },
        }}
        onOpenChange={onOpenChange}
      />
    )
    expect(screen.getAllByTestId(/^task-search-result-/)).toHaveLength(101)
    expect(screen.queryByTestId('task-search-load-more-button')).not.toBeInTheDocument()
    expect(projectTasksMock).toHaveBeenCalledTimes(1)
  })

  it('shares the initial group request and reuses a loaded empty group on reopening', async () => {
    const loadTasks = jest.fn().mockResolvedValue(undefined)
    const onOpenChange = jest.fn()
    const { rerender } = render(
      <SearchDialog
        open
        projectId={7}
        projectTaskList={{ tasks: [], loadTasks }}
        onOpenChange={onOpenChange}
      />
    )
    expect(loadTasks).toHaveBeenCalledTimes(1)
    rerender(
      <SearchDialog
        open
        projectId={7}
        projectTaskList={{
          tasks: [],
          page: { loaded: false, loading: true, hasMore: true },
          loadTasks,
        }}
        onOpenChange={onOpenChange}
      />
    )
    await loadDefaultTasks()
    expect(loadTasks).toHaveBeenCalledTimes(1)
    expect(projectTasksMock).not.toHaveBeenCalled()

    const projectTaskList = {
      tasks: [],
      page: { loaded: true, loading: false, hasMore: false },
      loadTasks,
    }
    rerender(
      <SearchDialog
        open
        projectId={7}
        projectTaskList={projectTaskList}
        onOpenChange={onOpenChange}
      />
    )
    expect(screen.getByText('common:tasks.no_tasks')).toBeInTheDocument()
    rerender(
      <SearchDialog
        open={false}
        projectId={7}
        projectTaskList={projectTaskList}
        onOpenChange={onOpenChange}
      />
    )
    rerender(
      <SearchDialog
        open
        projectId={7}
        projectTaskList={projectTaskList}
        onOpenChange={onOpenChange}
      />
    )
    await loadDefaultTasks()
    expect(screen.getByText('common:tasks.no_tasks')).toBeInTheDocument()
    expect(loadTasks).toHaveBeenCalledTimes(1)
    expect(projectTasksMock).not.toHaveBeenCalled()
  })

  it('shows the selected group tasks on open and loads subsequent pages without a keyword', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => createProjectTask(index + 1))
    projectTasksMock
      .mockResolvedValueOnce(projectResponse(firstPage, 'page-2'))
      .mockResolvedValueOnce(projectResponse([createProjectTask(21)]))
    const onTaskSelect = jest.fn()
    const onOpenChange = jest.fn()
    render(
      <SearchDialog
        open
        projectId={7}
        projectName="API tasks"
        onOpenChange={onOpenChange}
        onProjectTaskSelect={onTaskSelect}
      />
    )

    expect(screen.getByRole('heading')).toHaveTextContent('projects:search.title: API tasks')
    expect(screen.queryByText(mockRecentTask.title)).not.toBeInTheDocument()
    expect(screen.queryByText('common:tasks.new_conversation')).not.toBeInTheDocument()
    await loadDefaultTasks()
    expect(projectTasksMock).toHaveBeenLastCalledWith(7, 20, undefined, undefined)
    expect(screen.getAllByTestId(/^task-search-result-/)).toHaveLength(20)
    expect(searchTasksMock).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-search-load-more-button'))
    })
    expect(projectTasksMock).toHaveBeenLastCalledWith(7, 20, 'page-2', undefined)
    expect(screen.getAllByTestId(/^task-search-result-/)).toHaveLength(21)
    expect(screen.queryByTestId('task-search-load-more-button')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('task-search-result-21'))
    expect(onTaskSelect).toHaveBeenCalledWith(createProjectTask(21))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('starts a keyword search from the first page and paginates matching tasks', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => createProjectTask(index + 1))
    projectTasksMock
      .mockResolvedValueOnce(projectResponse([createProjectTask(100)], 'default-page-2'))
      .mockResolvedValueOnce(projectResponse(firstPage, 'matching-page-2'))
      .mockResolvedValueOnce(projectResponse([createProjectTask(21)]))
    render(<SearchDialog open projectId={7} onOpenChange={jest.fn()} />)
    await loadDefaultTasks()
    expect(screen.getByText('Matching task 100')).toBeInTheDocument()

    await searchFor('Matching')
    expect(projectTasksMock).toHaveBeenLastCalledWith(7, 20, undefined, 'Matching')
    expect(screen.queryByText('Matching task 100')).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-search-load-more-button'))
    })
    expect(projectTasksMock).toHaveBeenLastCalledWith(7, 20, 'matching-page-2', 'Matching')
    expect(screen.getAllByTestId(/^task-search-result-/)).toHaveLength(21)
    expect(searchTasksMock).not.toHaveBeenCalled()
  })

  it('retains global recent tasks and omits the group filter in global mode', async () => {
    render(<SearchDialog open onOpenChange={jest.fn()} />)
    await loadDefaultTasks()
    expect(screen.getByText(mockRecentTask.title)).toBeInTheDocument()
    expect(screen.getByText('common:tasks.new_conversation')).toBeInTheDocument()
    expect(searchTasksMock).not.toHaveBeenCalled()
    expect(projectTasksMock).not.toHaveBeenCalled()
    await searchFor('global')
    expect(searchTasksMock).toHaveBeenLastCalledWith('global', { page: 1, limit: 20 })
    fireEvent.click(screen.getByTestId('task-search-clear-button'))
    await loadDefaultTasks()
    expect(screen.getByText(mockRecentTask.title)).toBeInTheDocument()
    expect(searchTasksMock).toHaveBeenCalledTimes(1)
    expect(projectTasksMock).not.toHaveBeenCalled()
  })

  it('ignores an initial group response after the keyword results arrive', async () => {
    const initialRequest = deferredResponse()
    projectTasksMock
      .mockReturnValueOnce(initialRequest.promise)
      .mockResolvedValueOnce(projectResponse([createProjectTask(2)]))
    render(<SearchDialog open projectId={7} onOpenChange={jest.fn()} />)
    await loadDefaultTasks()
    await searchFor('new')
    await act(async () => initialRequest.resolve(projectResponse([createProjectTask(1)])))
    expect(screen.getByText('Matching task 2')).toBeInTheDocument()
    expect(screen.queryByText('Matching task 1')).not.toBeInTheDocument()
  })

  it('ignores an older keyword response when a newer search finishes first', async () => {
    const oldRequest = deferredResponse()
    projectTasksMock
      .mockResolvedValueOnce(projectResponse([createProjectTask(100)]))
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce(projectResponse([createProjectTask(2)]))
    render(<SearchDialog open projectId={7} onOpenChange={jest.fn()} />)
    await loadDefaultTasks()
    await searchFor('old')
    await searchFor('new')
    await act(async () => oldRequest.resolve(projectResponse([createProjectTask(1)])))
    expect(screen.getByText('Matching task 2')).toBeInTheDocument()
    expect(screen.queryByText('Matching task 1')).not.toBeInTheDocument()
  })

  it('restores the first group page on clearing and ignores pending or in-flight keyword results', async () => {
    projectTasksMock.mockResolvedValue(projectResponse([createProjectTask(100)]))
    render(<SearchDialog open projectId={7} onOpenChange={jest.fn()} />)
    await loadDefaultTasks()
    fireEvent.change(screen.getByTestId('task-search-input'), { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('task-search-clear-button'))
    await loadDefaultTasks()
    expect(projectTasksMock).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Matching task 100')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('task-search-input'), { target: { value: 'pending' } })
    fireEvent.click(screen.getByTestId('task-search-clear-button'))
    await act(async () => jest.advanceTimersByTime(300))
    expect(projectTasksMock).toHaveBeenCalledTimes(2)
    expect(projectTasksMock).not.toHaveBeenCalledWith(7, 20, undefined, 'pending')
    expect(screen.getByText('Matching task 100')).toBeInTheDocument()

    const request = deferredResponse()
    projectTasksMock.mockReturnValueOnce(request.promise)
    await searchFor('inflight')
    fireEvent.click(screen.getByTestId('task-search-clear-button'))
    await loadDefaultTasks()
    await act(async () => request.resolve(projectResponse([createProjectTask(1)])))
    expect(screen.getByTestId('task-search-input')).toHaveValue('')
    expect(projectTasksMock).toHaveBeenLastCalledWith(7, 20, undefined, undefined)
    expect(screen.getByText('Matching task 100')).toBeInTheDocument()
    expect(screen.queryByText('Matching task 1')).not.toBeInTheDocument()
  })

  it('clears a changed group scope and ignores the previous group response', async () => {
    const oldRequest = deferredResponse()
    projectTasksMock.mockImplementation((projectId, _limit, _cursor, title) => {
      if (projectId === 7 && title === 'old group') return oldRequest.promise
      const task = createProjectTask(projectId === 7 ? 100 : 200)
      return Promise.resolve(projectResponse([{ ...task, project_id: projectId }]))
    })
    const onOpenChange = jest.fn()
    const { rerender } = render(<SearchDialog open projectId={7} onOpenChange={onOpenChange} />)
    await loadDefaultTasks()
    await searchFor('old group')
    rerender(<SearchDialog open projectId={8} onOpenChange={onOpenChange} />)
    await loadDefaultTasks()
    await act(async () => oldRequest.resolve(projectResponse([createProjectTask(1)])))
    expect(screen.getByTestId('task-search-input')).toHaveValue('')
    expect(projectTasksMock).toHaveBeenLastCalledWith(8, 20, undefined, undefined)
    expect(screen.getByText('Matching task 200')).toBeInTheDocument()
    expect(screen.queryByText('Matching task 100')).not.toBeInTheDocument()
    expect(screen.queryByText('Matching task 1')).not.toBeInTheDocument()
    await searchFor('new group')
    expect(projectTasksMock).toHaveBeenLastCalledWith(8, 20, undefined, 'new group')
  })

  it('ignores in-flight results after closing and reopening the dialog', async () => {
    const request = deferredResponse()
    projectTasksMock
      .mockResolvedValue(projectResponse([createProjectTask(100)]))
      .mockResolvedValueOnce(projectResponse([createProjectTask(100)]))
      .mockReturnValueOnce(request.promise)
    const onOpenChange = jest.fn()
    const { rerender } = render(<SearchDialog open projectId={7} onOpenChange={onOpenChange} />)
    await loadDefaultTasks()
    await searchFor('old')
    rerender(<SearchDialog open={false} projectId={7} onOpenChange={onOpenChange} />)
    rerender(<SearchDialog open projectId={7} onOpenChange={onOpenChange} />)
    await loadDefaultTasks()
    await act(async () => request.resolve(projectResponse([createProjectTask(1)])))
    expect(screen.getByTestId('task-search-input')).toHaveValue('')
    expect(projectTasksMock).toHaveBeenLastCalledWith(7, 20, undefined, undefined)
    expect(screen.getByText('Matching task 100')).toBeInTheDocument()
    expect(screen.queryByText('Matching task 1')).not.toBeInTheDocument()
  })

  it('shows the empty task state when the selected group has no tasks', async () => {
    render(<SearchDialog open projectId={7} onOpenChange={jest.fn()} />)
    await loadDefaultTasks()
    expect(screen.getByText('common:tasks.no_tasks')).toBeInTheDocument()
    expect(screen.queryByText('common:tasks.search_hint')).not.toBeInTheDocument()
    expect(screen.queryByText(mockRecentTask.title)).not.toBeInTheDocument()
  })

  it('retries the initial group page after a request failure without requiring a keyword', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    projectTasksMock
      .mockRejectedValueOnce(new Error('Group task request failed'))
      .mockResolvedValueOnce(projectResponse([createProjectTask(1)]))
    render(<SearchDialog open projectId={7} onOpenChange={jest.fn()} />)
    await loadDefaultTasks()
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-search-retry-button'))
    })
    expect(projectTasksMock).toHaveBeenCalledTimes(2)
    expect(projectTasksMock).toHaveBeenLastCalledWith(7, 20, undefined, undefined)
    expect(screen.getByText('Matching task 1')).toBeInTheDocument()
    expect(screen.queryByTestId('task-search-retry-button')).not.toBeInTheDocument()
  })
})
