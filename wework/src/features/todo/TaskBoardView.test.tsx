import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import type { RuntimeWorkListResponse } from '@/types/api'
import { TaskBoardView } from './TaskBoardView'

function runtimeWork(): RuntimeWorkListResponse {
  return {
    projects: [],
    chats: [
      {
        deviceId: 'device-1',
        workspacePath: '/workspace/project',
        label: 'Project',
        available: true,
        tasks: [
          {
            taskId: 'review-1',
            workspacePath: '/workspace/project',
            title: 'Review one',
            runtime: 'codex',
            status: 'done',
            running: false,
          },
          {
            taskId: 'review-2',
            workspacePath: '/workspace/project',
            title: 'Review two',
            runtime: 'codex',
            status: 'failed',
            running: false,
          },
          {
            taskId: 'archived-1',
            workspacePath: '/workspace/project',
            title: 'Archived task',
            runtime: 'codex',
            status: 'archived',
            running: false,
          },
        ],
      },
    ],
    totalTasks: 3,
  }
}

describe('TaskBoardView', () => {
  it('confirms review tasks as completed without archiving them', async () => {
    const work = runtimeWork()
    const lifecycleStore = new RuntimeTaskLifecycleStore('task-board-batch-confirm')
    lifecycleStore.syncRuntimeWork(work)
    const findCloudContextForTask = vi.fn(async ({ taskId }: { taskId: string }) => ({
      project: {
        id: 'default-work-items',
        project_key: 'WORK',
        project_store: 'backend',
      },
      loop_item: {
        id: taskId,
        status: 'in_review',
        version: 1,
      },
    }))
    const updateLoopItem = vi.fn(
      async (itemId: string, values: { version: number; status?: string }) => ({
        id: itemId,
        status: values.status,
        version: values.version + 1,
      })
    )
    const onArchiveRuntimeTasks = vi.fn(async () => ({ status: 'archived' as const }))
    const projectSpaceApi = {
      findCloudContextForTask,
      updateLoopItem,
    } as unknown as ProjectSpaceApi

    render(
      <TaskBoardView
        runtimeWork={work}
        runtimeTaskLifecycle={lifecycleStore.getSnapshot()}
        unreadRuntimeTaskKeys={new Set()}
        onCreateTask={vi.fn()}
        projectSpaceApis={[projectSpaceApi]}
        onArchiveRuntimeTasks={onArchiveRuntimeTasks}
        onMarkRuntimeTaskRead={vi.fn()}
        onOpenRuntimeTask={vi.fn()}
      />
    )

    expect(screen.getByTestId('cloud-todo-column-in_review')).toHaveTextContent('Review one')
    expect(screen.getByTestId('cloud-todo-column-in_review')).toHaveTextContent('Review two')
    expect(screen.queryByText('Archived task')).not.toBeInTheDocument()

    await waitFor(() => expect(findCloudContextForTask).toHaveBeenCalledTimes(2))
    await userEvent.click(screen.getByTestId('task-board-card-confirm-runtime:device-1:review-1'))
    expect(screen.getByTestId('task-board-batch-confirm-review-dialog')).toHaveTextContent(
      '将当前列中的 1 个任务标记为已完成'
    )
    await userEvent.click(screen.getByTestId('task-board-batch-confirm-review-confirm'))

    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith('review-1', {
        version: 1,
        status: 'completed',
      })
    )
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent('Review one')

    await userEvent.click(screen.getByTestId('task-board-batch-confirm-review'))
    expect(screen.getByTestId('task-board-batch-confirm-review-dialog')).toHaveTextContent(
      '将当前列中的 1 个任务标记为已完成'
    )
    await userEvent.click(screen.getByTestId('task-board-batch-confirm-review-confirm'))

    await waitFor(() => expect(updateLoopItem).toHaveBeenCalledTimes(2))
    expect(updateLoopItem).toHaveBeenCalledWith('review-2', {
      version: 1,
      status: 'completed',
    })
    expect(screen.queryByTestId('task-board-batch-confirm-review-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent('Review one')
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent('Review two')

    await userEvent.click(screen.getByTestId('task-board-card-archive-runtime:device-1:review-1'))
    expect(screen.getByTestId('task-board-batch-archive-completed-dialog')).toHaveTextContent(
      '归档 1 个已完成任务'
    )
    await userEvent.click(screen.getByTestId('task-board-batch-archive-completed-confirm'))
    await waitFor(() =>
      expect(onArchiveRuntimeTasks).toHaveBeenCalledWith([
        expect.objectContaining({ deviceId: 'device-1', taskId: 'review-1' }),
      ])
    )

    await userEvent.click(screen.getByTestId('task-board-batch-archive-completed'))
    await userEvent.click(screen.getByTestId('task-board-batch-archive-completed-confirm'))
    await waitFor(() => expect(onArchiveRuntimeTasks).toHaveBeenCalledTimes(2))
    expect(onArchiveRuntimeTasks).toHaveBeenLastCalledWith([
      expect.objectContaining({ deviceId: 'device-1', taskId: 'review-1' }),
      expect.objectContaining({ deviceId: 'device-1', taskId: 'review-2' }),
    ])
  })

  it('limits concurrent updates when confirming all review tasks', async () => {
    const work: RuntimeWorkListResponse = {
      projects: [],
      chats: [
        {
          deviceId: 'device-1',
          workspacePath: '/workspace/project',
          label: 'Project',
          available: true,
          tasks: Array.from({ length: 9 }, (_, index) => ({
            taskId: `review-${index}`,
            workspacePath: '/workspace/project',
            title: `Review ${index}`,
            runtime: 'codex' as const,
            status: 'done' as const,
            running: false,
          })),
        },
      ],
      totalTasks: 9,
    }
    const lifecycleStore = new RuntimeTaskLifecycleStore('task-board-batch-confirm-concurrency')
    lifecycleStore.syncRuntimeWork(work)
    const updateRequests = new Map<
      string,
      {
        promise: Promise<{ id: string; status: string; version: number }>
        resolve: (value: { id: string; status: string; version: number }) => void
      }
    >()
    const updateLoopItem = vi.fn((itemId: string, values: { version: number; status?: string }) => {
      let resolve!: (value: { id: string; status: string; version: number }) => void
      const promise = new Promise<{ id: string; status: string; version: number }>(nextResolve => {
        resolve = nextResolve
      })
      updateRequests.set(itemId, { promise, resolve })
      return promise.then(() => ({
        id: itemId,
        status: values.status ?? 'in_review',
        version: values.version + 1,
      }))
    })
    const projectSpaceApi = {
      findCloudContextForTask: vi.fn(async ({ taskId }: { taskId: string }) => ({
        project: {
          id: 'default-work-items',
          project_key: 'WORK',
          project_store: 'backend',
        },
        loop_item: {
          id: taskId,
          status: 'in_review',
          version: 1,
        },
      })),
      updateLoopItem,
    } as unknown as ProjectSpaceApi

    render(
      <TaskBoardView
        runtimeWork={work}
        runtimeTaskLifecycle={lifecycleStore.getSnapshot()}
        unreadRuntimeTaskKeys={new Set()}
        onCreateTask={vi.fn()}
        projectSpaceApis={[projectSpaceApi]}
        onArchiveRuntimeTasks={vi.fn()}
        onMarkRuntimeTaskRead={vi.fn()}
        onOpenRuntimeTask={vi.fn()}
      />
    )

    await waitFor(() => expect(projectSpaceApi.findCloudContextForTask).toHaveBeenCalledTimes(9))
    await userEvent.click(screen.getByTestId('task-board-batch-confirm-review'))
    await userEvent.click(screen.getByTestId('task-board-batch-confirm-review-confirm'))
    await waitFor(() => expect(updateLoopItem).toHaveBeenCalledTimes(8))

    await act(async () => {
      updateRequests.get('review-0')?.resolve({
        id: 'review-0',
        status: 'completed',
        version: 2,
      })
      await updateRequests.get('review-0')?.promise
    })
    await waitFor(() => expect(updateLoopItem).toHaveBeenCalledTimes(9))

    await act(async () => {
      for (let index = 1; index < 9; index += 1) {
        updateRequests.get(`review-${index}`)?.resolve({
          id: `review-${index}`,
          status: 'completed',
          version: 2,
        })
      }
      await Promise.all(updateLoopItem.mock.results.map(result => result.value as Promise<unknown>))
    })
    expect(screen.queryByTestId('task-board-batch-confirm-review-dialog')).not.toBeInTheDocument()
  })

  it('repairs missing Runtime Task bindings before confirming them', async () => {
    const work = runtimeWork()
    const lifecycleStore = new RuntimeTaskLifecycleStore('task-board-repair-bindings')
    lifecycleStore.syncRuntimeWork(work)
    const defaultProject = {
      id: 'default-work-items',
      project_key: 'WORK',
      project_store: 'local',
      metadata: { system_kind: 'default_work_items' },
    }
    const findCloudContextForTask = vi.fn(async () => {
      throw new Error('Task context not found')
    })
    const trackProjectTask = vi.fn(async (_projectId: string, { taskId }: { taskId: string }) => ({
      item: {
        id: `WORK-${taskId}`,
        status: 'inbox',
        version: 1,
      },
    }))
    const updateLoopItem = vi.fn(
      async (itemId: string, values: { version: number; status?: string }) => ({
        id: itemId,
        status: values.status,
        version: values.version + 1,
      })
    )
    const projectSpaceApi = {
      findCloudContextForTask,
      listCloudProjects: vi.fn(async () => ({ items: [defaultProject] })),
      trackProjectTask,
      updateLoopItem,
    } as unknown as ProjectSpaceApi

    render(
      <TaskBoardView
        runtimeWork={work}
        runtimeTaskLifecycle={lifecycleStore.getSnapshot()}
        unreadRuntimeTaskKeys={new Set()}
        onCreateTask={vi.fn()}
        projectSpaceApis={[projectSpaceApi]}
        onArchiveRuntimeTasks={vi.fn()}
        onMarkRuntimeTaskRead={vi.fn()}
        onOpenRuntimeTask={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('task-board-batch-confirm-review'))
    await userEvent.click(screen.getByTestId('task-board-batch-confirm-review-confirm'))

    await waitFor(() => expect(trackProjectTask).toHaveBeenCalledTimes(2))
    expect(projectSpaceApi.listCloudProjects).toHaveBeenCalledOnce()
    expect(trackProjectTask).toHaveBeenCalledWith(
      'default-work-items',
      expect.objectContaining({ taskId: 'review-1' }),
      'Review one',
      ''
    )
    expect(updateLoopItem).toHaveBeenCalledWith('WORK-review-1', {
      version: 1,
      status: 'completed',
    })
    expect(updateLoopItem).toHaveBeenCalledWith('WORK-review-2', {
      version: 1,
      status: 'completed',
    })
    expect(screen.queryByTestId('task-board-batch-confirm-review-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent('Review one')
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent('Review two')
  })

  it('filters tasks whose linked project item is archived', async () => {
    const work = runtimeWork()
    const lifecycleStore = new RuntimeTaskLifecycleStore('task-board-archived-binding')
    lifecycleStore.syncRuntimeWork(work)
    const findCloudContextForTask = vi.fn(async ({ taskId }: { taskId: string }) => ({
      project: {
        id: 'default-work-items',
        project_key: 'WORK',
        project_store: 'backend',
      },
      loop_item: {
        id: taskId,
        status: taskId === 'review-1' ? 'archived' : 'in_review',
        version: 1,
      },
    }))
    const projectSpaceApi = {
      findCloudContextForTask,
      updateLoopItem: vi.fn(),
    } as unknown as ProjectSpaceApi

    render(
      <TaskBoardView
        runtimeWork={work}
        runtimeTaskLifecycle={lifecycleStore.getSnapshot()}
        unreadRuntimeTaskKeys={new Set()}
        onCreateTask={vi.fn()}
        projectSpaceApis={[projectSpaceApi]}
        onArchiveRuntimeTasks={vi.fn()}
        onMarkRuntimeTaskRead={vi.fn()}
        onOpenRuntimeTask={vi.fn()}
      />
    )

    await waitFor(() => expect(findCloudContextForTask).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('Review one')).not.toBeInTheDocument())
    expect(screen.getByTestId('cloud-todo-column-in_review')).toHaveTextContent('Review two')
  })

  it('does not repeat pending context lookups when runtime work refreshes', async () => {
    const work = runtimeWork()
    const lifecycleStore = new RuntimeTaskLifecycleStore('task-board-context-single-flight')
    lifecycleStore.syncRuntimeWork(work)
    let resolveContexts: (() => void) | undefined
    const contextsReady = new Promise<void>(resolve => {
      resolveContexts = resolve
    })
    const findCloudContextForTask = vi.fn(async ({ taskId }: { taskId: string }) => {
      await contextsReady
      return {
        project: {
          id: 'default-work-items',
          project_key: 'WORK',
          project_store: 'backend',
        },
        loop_item: {
          id: taskId,
          status: taskId === 'review-1' ? 'archived' : 'in_review',
          version: 1,
        },
      }
    })
    const projectSpaceApi = {
      findCloudContextForTask,
      updateLoopItem: vi.fn(),
    } as unknown as ProjectSpaceApi
    const view = (nextWork: RuntimeWorkListResponse) => (
      <TaskBoardView
        runtimeWork={nextWork}
        runtimeTaskLifecycle={lifecycleStore.getSnapshot()}
        unreadRuntimeTaskKeys={new Set()}
        onCreateTask={vi.fn()}
        projectSpaceApis={[projectSpaceApi]}
        onArchiveRuntimeTasks={vi.fn()}
        onMarkRuntimeTaskRead={vi.fn()}
        onOpenRuntimeTask={vi.fn()}
      />
    )

    const rendered = render(view(work))
    await waitFor(() => expect(findCloudContextForTask).toHaveBeenCalledTimes(2))

    await act(async () => {
      rendered.rerender(view({ ...work, chats: [...work.chats] }))
      rendered.rerender(view({ ...work, totalTasks: work.totalTasks + 1 }))
    })
    expect(findCloudContextForTask).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveContexts?.()
      await contextsReady
    })
    await waitFor(() => expect(screen.queryByText('Review one')).not.toBeInTheDocument())
    await act(async () => {
      rendered.rerender(view({ ...work, chats: [...work.chats] }))
    })
    expect(findCloudContextForTask).toHaveBeenCalledTimes(2)
  })

  it('discards pending context results from replaced project-space APIs', async () => {
    const work = runtimeWork()
    const lifecycleStore = new RuntimeTaskLifecycleStore('task-board-context-api-replacement')
    lifecycleStore.syncRuntimeWork(work)
    let resolveOldContexts: (() => void) | undefined
    const oldContextsReady = new Promise<void>(resolve => {
      resolveOldContexts = resolve
    })
    const oldUpdateLoopItem = vi.fn()
    const oldApi = {
      findCloudContextForTask: vi.fn(async ({ taskId }: { taskId: string }) => {
        await oldContextsReady
        return {
          project: {
            id: 'old-project',
            project_key: 'OLD',
            project_store: 'backend',
          },
          loop_item: {
            id: taskId,
            status: 'completed',
            version: 1,
          },
        }
      }),
      updateLoopItem: oldUpdateLoopItem,
    } as unknown as ProjectSpaceApi
    const newUpdateLoopItem = vi.fn(
      async (itemId: string, values: { version: number; status?: string }) => ({
        id: itemId,
        status: values.status,
        version: values.version + 1,
      })
    )
    const newApi = {
      findCloudContextForTask: vi.fn(async ({ taskId }: { taskId: string }) => ({
        project: {
          id: 'new-project',
          project_key: 'NEW',
          project_store: 'backend',
        },
        loop_item: {
          id: taskId,
          status: taskId === 'review-1' ? 'archived' : 'in_review',
          version: 2,
        },
      })),
      updateLoopItem: newUpdateLoopItem,
    } as unknown as ProjectSpaceApi
    const oldApis = [oldApi]
    const newApis = [newApi]
    const view = (projectSpaceApis: ProjectSpaceApi[]) => (
      <TaskBoardView
        runtimeWork={work}
        runtimeTaskLifecycle={lifecycleStore.getSnapshot()}
        unreadRuntimeTaskKeys={new Set()}
        onCreateTask={vi.fn()}
        projectSpaceApis={projectSpaceApis}
        onArchiveRuntimeTasks={vi.fn()}
        onMarkRuntimeTaskRead={vi.fn()}
        onOpenRuntimeTask={vi.fn()}
      />
    )

    const rendered = render(view(oldApis))
    await waitFor(() => expect(oldApi.findCloudContextForTask).toHaveBeenCalledTimes(2))

    rendered.rerender(view(newApis))
    await waitFor(() => expect(newApi.findCloudContextForTask).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('Review one')).not.toBeInTheDocument())

    await act(async () => {
      resolveOldContexts?.()
      await oldContextsReady
    })
    expect(screen.queryByText('Review one')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('task-board-batch-confirm-review'))
    await userEvent.click(screen.getByTestId('task-board-batch-confirm-review-confirm'))

    await waitFor(() =>
      expect(newUpdateLoopItem).toHaveBeenCalledWith('review-2', {
        version: 2,
        status: 'completed',
      })
    )
    expect(oldUpdateLoopItem).not.toHaveBeenCalled()
  })

  it('refreshes a failed local task context before retrying confirmation', async () => {
    const work = runtimeWork()
    const lifecycleStore = new RuntimeTaskLifecycleStore('task-board-refresh-local-context')
    lifecycleStore.syncRuntimeWork(work)
    let reviewItemVersion = 1
    const findCloudContextForTask = vi.fn(async ({ taskId }: { taskId: string }) => ({
      project: {
        id: 'default-work-items',
        project_key: 'WORK',
        project_store: 'local',
      },
      loop_item: {
        id: taskId,
        status: 'in_review',
        version: taskId === 'review-1' ? reviewItemVersion : 1,
      },
    }))
    const updateLoopItem = vi.fn(
      async (itemId: string, values: { version: number; status?: string }) => {
        if (itemId === 'review-1' && values.version === 1) {
          reviewItemVersion = 2
          throw new Error('version conflict')
        }
        return {
          id: itemId,
          status: values.status,
          version: values.version + 1,
        }
      }
    )
    const projectSpaceApi = {
      findCloudContextForTask,
      updateLoopItem,
    } as unknown as ProjectSpaceApi

    render(
      <TaskBoardView
        runtimeWork={work}
        runtimeTaskLifecycle={lifecycleStore.getSnapshot()}
        unreadRuntimeTaskKeys={new Set()}
        onCreateTask={vi.fn()}
        projectSpaceApis={[projectSpaceApi]}
        onArchiveRuntimeTasks={vi.fn()}
        onMarkRuntimeTaskRead={vi.fn()}
        onOpenRuntimeTask={vi.fn()}
      />
    )

    await waitFor(() => expect(findCloudContextForTask).toHaveBeenCalledTimes(2))
    await userEvent.click(screen.getByTestId('task-board-card-confirm-runtime:device-1:review-1'))
    await userEvent.click(screen.getByTestId('task-board-batch-confirm-review-confirm'))

    expect(await screen.findByRole('alert')).toHaveTextContent('1 个任务确认失败，请稍后重试')
    expect(updateLoopItem).toHaveBeenCalledWith('review-1', {
      version: 1,
      status: 'completed',
    })

    await userEvent.click(screen.getByTestId('task-board-batch-confirm-review-confirm'))

    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenLastCalledWith('review-1', {
        version: 2,
        status: 'completed',
      })
    )
    expect(findCloudContextForTask).toHaveBeenCalledTimes(3)
    expect(screen.queryByTestId('task-board-batch-confirm-review-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent('Review one')
  })

  it('ignores an initial context lookup that resolves after confirmation', async () => {
    const work = runtimeWork()
    const lifecycleStore = new RuntimeTaskLifecycleStore('task-board-ignore-stale-context')
    lifecycleStore.syncRuntimeWork(work)
    let resolveInitialReviewContext:
      | ((source: {
          project: { id: string; project_key: string; project_store: 'local' }
          loop_item: { id: string; status: 'in_review'; version: number }
        }) => void)
      | undefined
    const initialReviewContext = new Promise<{
      project: { id: string; project_key: string; project_store: 'local' }
      loop_item: { id: string; status: 'in_review'; version: number }
    }>(resolve => {
      resolveInitialReviewContext = resolve
    })
    const lookupCounts = new Map<string, number>()
    const findCloudContextForTask = vi.fn(async ({ taskId }: { taskId: string }) => {
      const lookupCount = (lookupCounts.get(taskId) ?? 0) + 1
      lookupCounts.set(taskId, lookupCount)
      if (taskId === 'review-1' && lookupCount === 1) return initialReviewContext
      return {
        project: {
          id: 'default-work-items',
          project_key: 'WORK',
          project_store: 'local' as const,
        },
        loop_item: {
          id: taskId,
          status: 'in_review' as const,
          version: 1,
        },
      }
    })
    const updateLoopItem = vi.fn(
      async (itemId: string, values: { version: number; status?: string }) => ({
        id: itemId,
        status: values.status,
        version: values.version + 1,
      })
    )
    const projectSpaceApi = {
      findCloudContextForTask,
      updateLoopItem,
    } as unknown as ProjectSpaceApi

    render(
      <TaskBoardView
        runtimeWork={work}
        runtimeTaskLifecycle={lifecycleStore.getSnapshot()}
        unreadRuntimeTaskKeys={new Set()}
        onCreateTask={vi.fn()}
        projectSpaceApis={[projectSpaceApi]}
        onArchiveRuntimeTasks={vi.fn()}
        onMarkRuntimeTaskRead={vi.fn()}
        onOpenRuntimeTask={vi.fn()}
      />
    )

    await waitFor(() => expect(findCloudContextForTask).toHaveBeenCalledTimes(2))
    await userEvent.click(screen.getByTestId('task-board-card-confirm-runtime:device-1:review-1'))
    await userEvent.click(screen.getByTestId('task-board-batch-confirm-review-confirm'))

    await waitFor(() =>
      expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent('Review one')
    )

    await act(async () => {
      resolveInitialReviewContext?.({
        project: {
          id: 'default-work-items',
          project_key: 'WORK',
          project_store: 'local',
        },
        loop_item: {
          id: 'review-1',
          status: 'in_review',
          version: 1,
        },
      })
      await initialReviewContext
    })

    expect(screen.getByTestId('cloud-todo-column-completed')).toHaveTextContent('Review one')
    expect(screen.getByTestId('cloud-todo-column-in_review')).not.toHaveTextContent('Review one')
  })
})
