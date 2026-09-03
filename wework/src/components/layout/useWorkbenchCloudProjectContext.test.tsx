import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import {
  DEFAULT_WORK_ITEM_PROJECT_ID,
  DEFAULT_WORK_ITEM_PROJECT_KEY,
  type CloudLoopItem,
  type CloudProject,
} from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskAddress } from '@/types/api'
import { WorkspaceTabsContext } from '@/features/workspace-tabs/workspaceTabsContextValue'
import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { defaultProjectSpaceContentRoute } from '@/features/todo/projectSpaceRoute'
import {
  cloudItemAsLocalWorkItem,
  useWorkbenchCloudProjectContext,
} from './useWorkbenchCloudProjectContext'

function project(id: string, projectStore: 'local' | 'backend' = 'backend'): CloudProject {
  return {
    id,
    public_id: `public-${id}`,
    project_key: id.toUpperCase(),
    name: `${id} board`,
    description: 'Shared project context',
    project_store: projectStore,
    task_provider: projectStore === 'local' ? 'local' : 'native',
    provider_config: {},
    created_by_user_id: 1,
    status: 'active',
    tags: [],
    version: 1,
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
  }
}

function loopItem(projectId: string): CloudLoopItem {
  return {
    id: 'todo-1',
    cloud_project_id: projectId,
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    title: 'Ship the refactor',
    description: 'Keep the workbench behavior stable',
    status: 'in_progress',
    priority: 'medium',
    due_at: null,
    tags: [],
    sort_order: 2,
    current_delivery_id: null,
    version: 1,
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
    completed_at: null,
  }
}

function renderCloudContext(services?: WorkbenchServices) {
  return renderHook(() =>
    useWorkbenchCloudProjectContext({
      active: true,
      currentRuntimeTask: null,
      currentProjectId: 42,
      defaultProjectSpace: null,
      paneKey: 'project:42',
      runtimeTaskTitle: null,
      services,
      userId: 1,
    })
  )
}

describe('useWorkbenchCloudProjectContext', () => {
  afterEach(() => {
    const { result, unmount } = renderCloudContext()
    act(() => result.current.clearPendingProjectContext())
    unmount()
  })

  test('prepares a pending backend project and task for runtime creation', async () => {
    const cloudProject = project('space-cloud')
    const item = loopItem(cloudProject.id)
    const runtimeTask = {
      deviceId: 'device-1',
      taskId: 'runtime-1',
    }
    const deliveryApi = {
      bindTask: vi.fn().mockResolvedValue(undefined),
      findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not bound yet')),
      listCloudProjects: vi.fn().mockResolvedValue({ items: [cloudProject] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [item] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
    }
    const services = {
      deliveryApi,
    } as unknown as WorkbenchServices
    const { result, rerender } = renderHook(
      ({ currentRuntimeTask }: { currentRuntimeTask: RuntimeTaskAddress | null }) =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask,
          currentProjectId: 42,
          defaultProjectSpace: null,
          paneKey: 'project:42',
          runtimeTaskTitle: null,
          services,
          userId: 1,
        }),
      { initialProps: { currentRuntimeTask: null } }
    )

    await act(async () => {})
    act(() => result.current.handleTodoBound(cloudProject, item))

    let submission: Awaited<ReturnType<typeof result.current.prepareSubmission>> | undefined
    await act(async () => {
      submission = await result.current.prepareSubmission('Implement the selected task')
    })

    expect(submission?.cloudProjectId).toBe(cloudProject.id)
    expect(submission?.origin).toEqual({
      type: 'board_task',
      projectStore: cloudProject.project_store,
      cloudProjectId: cloudProject.id,
      loopItemId: item.id,
    })
    expect(submission?.additionalContext?.cloudCollaboration.value).toContain(
      `Current task: ${item.id} — ${item.title}.`
    )
    expect(result.current.pendingCloudProject).toEqual(cloudProject)
    expect(result.current.pendingTodoItem).toEqual(item)

    act(() => submission?.onRuntimeTaskCreated(runtimeTask))
    rerender({ currentRuntimeTask: runtimeTask })

    await waitFor(() =>
      expect(deliveryApi.bindTask).toHaveBeenCalledWith(
        item.id,
        runtimeTask,
        'Implement the selected task'
      )
    )
  })

  test('does not reload task context when only the address object identity changes', async () => {
    const findCloudContextForTask = vi.fn().mockRejectedValue(new Error('Not bound yet'))
    const services = {
      deliveryApi: {
        findCloudContextForTask,
      },
    } as unknown as WorkbenchServices
    const { rerender } = renderHook(
      ({ currentRuntimeTask }: { currentRuntimeTask: RuntimeTaskAddress }) =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask,
          currentProjectId: 42,
          defaultProjectSpace: null,
          paneKey: 'project:42',
          runtimeTaskTitle: null,
          services,
          userId: 1,
        }),
      {
        initialProps: {
          currentRuntimeTask: {
            deviceId: 'cloud-device',
            taskId: 'claude-task',
            runtime: 'claude_code',
          },
        },
      }
    )

    await waitFor(() => expect(findCloudContextForTask).toHaveBeenCalledOnce())

    rerender({
      currentRuntimeTask: {
        deviceId: 'cloud-device',
        taskId: 'claude-task',
        runtime: 'claude_code',
        workspacePath: '/updated/workspace',
      },
    })
    await act(async () => {})

    expect(findCloudContextForTask).toHaveBeenCalledOnce()
  })

  test('reloads the bound work item after its tracking status is persisted', async () => {
    const cloudProject = project('space-cloud')
    const runningItem = loopItem(cloudProject.id)
    const completedItem = {
      ...runningItem,
      status: 'completed' as const,
      completed_at: '2026-08-15T01:30:24Z',
    }
    const runtimeTask = {
      deviceId: 'local-device',
      taskId: 'runtime-1',
    }
    const findCloudContextForTask = vi
      .fn()
      .mockResolvedValueOnce({ project: cloudProject, loop_item: runningItem })
      .mockResolvedValueOnce({ project: cloudProject, loop_item: completedItem })
    const services = {
      deliveryApi: {
        findCloudContextForTask,
        listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
        listCloudProjects: vi.fn().mockResolvedValue({ items: [cloudProject] }),
        listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
        listLoopItems: vi.fn().mockResolvedValue({ items: [completedItem] }),
      },
    } as unknown as WorkbenchServices
    const { publishProjectSpaceTaskContextChanged } =
      await import('@/features/todo/projectSpaceSelection')
    const { result } = renderHook(() =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask: runtimeTask,
        currentProjectId: 42,
        defaultProjectSpace: null,
        paneKey: 'project:42',
        runtimeTaskTitle: 'Lifecycle task',
        services,
        userId: 1,
      })
    )

    await waitFor(() => expect(result.current.boundCloudItem?.status).toBe('in_progress'))

    act(() => publishProjectSpaceTaskContextChanged(runtimeTask))

    await waitFor(() => expect(result.current.boundCloudItem?.status).toBe('completed'))
    expect(findCloudContextForTask).toHaveBeenCalledTimes(2)
  })

  test('automatically selects the configured default project space', async () => {
    const defaultProject = project('space-default')
    const deliveryApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [defaultProject] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
    }
    const services = {
      deliveryApi,
    } as unknown as WorkbenchServices
    const defaultProjectSpace = {
      projectStore: defaultProject.project_store,
      projectId: defaultProject.id,
    } as const

    const { result } = renderHook(() =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask: null,
        currentProjectId: 42,
        defaultProjectSpace,
        paneKey: 'project:42',
        runtimeTaskTitle: null,
        services,
        userId: 1,
      })
    )

    await waitFor(() => expect(result.current.pendingCloudProject).toEqual(defaultProject))
    expect(result.current.pendingTodoItem).toBeNull()
    expect(deliveryApi.listCloudProjects).toHaveBeenCalledOnce()
    await waitFor(() => expect(deliveryApi.listCloudFiles).toHaveBeenCalledOnce())
    expect(deliveryApi.listLoopItems).toHaveBeenCalledOnce()
  })

  test('keeps concurrent pending project-space selections isolated by pane', async () => {
    const firstProject = {
      ...project(DEFAULT_WORK_ITEM_PROJECT_ID, 'local'),
      project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
      metadata: { system_kind: 'default_work_items' },
    }
    const secondProject = project('space-default', 'local')
    const firstTask = { deviceId: 'device-1', taskId: 'runtime-1' }
    const secondTask = { deviceId: 'device-1', taskId: 'runtime-2' }
    const firstItem = loopItem(firstProject.id)
    const secondItem = { ...loopItem(secondProject.id), id: 'todo-2' }
    const firstTrackProjectTask = vi.fn().mockResolvedValue({ item: firstItem })
    const secondTrackProjectTask = vi.fn().mockResolvedValue({ item: secondItem })
    const firstServices = {
      deliveryApi: {
        findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not bound yet')),
        listCloudProjects: vi.fn().mockResolvedValue({ items: [firstProject] }),
        listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
        listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
        listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
        trackProjectTask: firstTrackProjectTask,
      },
    } as unknown as WorkbenchServices
    const secondServices = {
      deliveryApi: {
        findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not bound yet')),
        listCloudProjects: vi.fn().mockResolvedValue({ items: [secondProject] }),
        listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
        listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
        listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
        trackProjectTask: secondTrackProjectTask,
      },
    } as unknown as WorkbenchServices
    const firstHook = renderHook(
      ({ currentRuntimeTask }: { currentRuntimeTask: RuntimeTaskAddress | null }) =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask,
          currentProjectId: 1,
          defaultProjectSpace: null,
          paneKey: 'project:1',
          runtimeTaskTitle: 'First task',
          services: firstServices,
          userId: 1,
        }),
      { initialProps: { currentRuntimeTask: null } }
    )
    const secondHook = renderHook(
      ({ currentRuntimeTask }: { currentRuntimeTask: RuntimeTaskAddress | null }) =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask,
          currentProjectId: 2,
          defaultProjectSpace: {
            projectStore: secondProject.project_store,
            projectId: secondProject.id,
          },
          paneKey: 'project:2',
          runtimeTaskTitle: 'Second task',
          services: secondServices,
          userId: 1,
        }),
      { initialProps: { currentRuntimeTask: null } }
    )

    await waitFor(() => expect(firstHook.result.current.pendingCloudProject).toEqual(firstProject))
    await waitFor(() =>
      expect(secondHook.result.current.pendingCloudProject).toEqual(secondProject)
    )

    const firstSubmission = await firstHook.result.current.prepareSubmission('First task')
    const secondSubmission = await secondHook.result.current.prepareSubmission('Second task')
    act(() => {
      firstSubmission.onRuntimeTaskCreated(firstTask)
      secondSubmission.onRuntimeTaskCreated(secondTask)
    })
    firstHook.rerender({ currentRuntimeTask: firstTask })
    secondHook.rerender({ currentRuntimeTask: secondTask })

    expect(firstTrackProjectTask).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(secondTrackProjectTask).toHaveBeenCalledWith(
        secondProject.id,
        secondTask,
        'Second task',
        'Second task'
      )
    )
    secondHook.unmount()
    firstHook.unmount()
  })

  test('falls back to My Tasks after clearing an extra project-space selection', async () => {
    const configuredProject = project('space-default', 'local')
    const defaultBoard = {
      ...project(DEFAULT_WORK_ITEM_PROJECT_ID, 'local'),
      project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
      name: '我的任务',
      metadata: { system_kind: 'default_work_items' },
    }
    const localApi = {
      listCloudProjects: vi.fn().mockResolvedValue({
        items: [configuredProject, defaultBoard],
      }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
    }
    const services = {
      projectSpaceApis: {
        local: localApi,
        defaultLocation: 'local',
      },
    } as unknown as WorkbenchServices
    const { result } = renderHook(() =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask: null,
        currentProjectId: 42,
        defaultProjectSpace: {
          projectStore: configuredProject.project_store,
          projectId: configuredProject.id,
        },
        paneKey: 'project:42',
        runtimeTaskTitle: null,
        services,
        userId: 1,
      })
    )

    await waitFor(() => expect(result.current.pendingCloudProject).toEqual(configuredProject))

    act(() => result.current.clearPendingProjectContext())

    expect(result.current.pendingCloudProject).toBeNull()
    expect(result.current.defaultProject).toEqual(defaultBoard)

    let submission: Awaited<ReturnType<typeof result.current.prepareSubmission>> | undefined
    await act(async () => {
      submission = await result.current.prepareSubmission('只加入我的任务')
    })

    expect(submission?.additionalContext?.cloudCollaboration?.value).toContain(
      `Current cloud project: 我的任务 (id=${DEFAULT_WORK_ITEM_PROJECT_ID}).`
    )
  })

  test('waits for the executor to bind the default work-item project', async () => {
    const defaultBoard = {
      ...project(DEFAULT_WORK_ITEM_PROJECT_ID, 'local'),
      project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
      name: '我的任务',
    }
    const trackedItem = loopItem(defaultBoard.id)
    const runtimeTask = {
      deviceId: 'device-1',
      taskId: 'runtime-1',
    }
    const localApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [defaultBoard] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      findCloudContextForTask: vi.fn().mockResolvedValue({
        id: 1,
        cloud_project_id: defaultBoard.id,
        loop_item_id: trackedItem.id,
        project: defaultBoard,
        loop_item: trackedItem,
      }),
      trackProjectTask: vi.fn().mockResolvedValue({ item: trackedItem }),
    }
    const services = {
      projectSpaceApis: {
        local: localApi,
        defaultLocation: 'local',
      },
    } as unknown as WorkbenchServices
    const { result, rerender } = renderHook(
      ({ currentRuntimeTask }: { currentRuntimeTask: RuntimeTaskAddress | null }) =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask,
          currentProjectId: 42,
          defaultProjectSpace: null,
          paneKey: 'project:42',
          runtimeTaskTitle: null,
          services,
          userId: 1,
        }),
      { initialProps: { currentRuntimeTask: null } }
    )

    await waitFor(() => expect(result.current.pendingCloudProject).toEqual(defaultBoard))

    let submission: Awaited<ReturnType<typeof result.current.prepareSubmission>> | undefined
    await act(async () => {
      submission = await result.current.prepareSubmission('完成零配置任务')
    })
    act(() => submission?.onRuntimeTaskCreated(runtimeTask))
    rerender({ currentRuntimeTask: runtimeTask })

    await waitFor(() => expect(result.current.boundCloudItem).toEqual(trackedItem))
    expect(localApi.trackProjectTask).not.toHaveBeenCalled()
  })

  test('submits immediately and delegates a late default-project association to executor', async () => {
    const defaultBoard = {
      ...project(DEFAULT_WORK_ITEM_PROJECT_ID, 'local'),
      project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
      name: '我的任务',
    }
    const trackedItem = loopItem(defaultBoard.id)
    const runtimeTask = {
      deviceId: 'device-1',
      taskId: 'runtime-1',
    }
    let resolveLocalProjects: ((value: { items: CloudProject[] }) => void) | undefined
    const localApi = {
      listCloudProjects: vi.fn(
        () =>
          new Promise<{ items: CloudProject[] }>(resolve => {
            resolveLocalProjects = resolve
          })
      ),
      findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not bound yet')),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      trackProjectTask: vi.fn().mockResolvedValue({ item: trackedItem }),
    }
    const cloudApi = {
      listCloudProjects: vi.fn(() => new Promise<never>(() => {})),
      findCloudContextForTask: vi.fn(() => new Promise<never>(() => {})),
    }
    const services = {
      projectSpaceApis: {
        local: localApi,
        cloud: cloudApi,
        defaultLocation: 'local',
      },
    } as unknown as WorkbenchServices
    const { result, rerender } = renderHook(
      ({ currentRuntimeTask }: { currentRuntimeTask: RuntimeTaskAddress | null }) =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask,
          currentProjectId: 42,
          defaultProjectSpace: null,
          paneKey: 'project:42',
          runtimeTaskTitle: null,
          services,
          userId: 1,
        }),
      { initialProps: { currentRuntimeTask: null } }
    )

    const submission = result.current.prepareSubmission('继续发送')

    expect(submission.cloudProjectId).toBeUndefined()
    expect(submission.additionalContext).toBeUndefined()

    act(() => submission.onRuntimeTaskCreated(runtimeTask))
    rerender({ currentRuntimeTask: runtimeTask })
    await waitFor(() => expect(localApi.listCloudProjects).toHaveBeenCalledOnce())
    await act(async () => resolveLocalProjects?.({ items: [defaultBoard] }))

    await waitFor(() => expect(result.current.pendingCloudProject).toEqual(defaultBoard))
    expect(localApi.trackProjectTask).not.toHaveBeenCalled()
  })

  test('does not bind My Tasks from the frontend after runtime creation', async () => {
    const defaultBoard = {
      ...project(DEFAULT_WORK_ITEM_PROJECT_ID, 'local'),
      project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
      name: '我的任务',
    }
    const runtimeTask = {
      deviceId: 'device-1',
      taskId: 'runtime-1',
    }
    const bindProjectTask = vi.fn()
    const localApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [defaultBoard] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not bound yet')),
      bindProjectTask,
    }
    const services = {
      projectSpaceApis: {
        local: localApi,
        defaultLocation: 'local',
      },
    } as unknown as WorkbenchServices
    const { result } = renderHook(() =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask: runtimeTask,
        currentProjectId: 42,
        defaultProjectSpace: null,
        paneKey: 'project:42',
        runtimeTaskTitle: 'Runtime task',
        services,
        userId: 1,
      })
    )

    await waitFor(() => expect(localApi.listCloudProjects).toHaveBeenCalledOnce())
    act(() => result.current.handleSelectCloudProject(defaultBoard))

    expect(bindProjectTask).not.toHaveBeenCalled()
  })

  test('recovers when the first context lookup races with default-board binding', async () => {
    const defaultBoard = {
      ...project(DEFAULT_WORK_ITEM_PROJECT_ID, 'local'),
      project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
      name: '我的任务',
    }
    const trackedItem = loopItem(defaultBoard.id)
    const runtimeTask = {
      deviceId: 'device-1',
      taskId: 'runtime-1',
    }
    const findCloudContextForTask = vi
      .fn()
      .mockRejectedValueOnce(new Error('Binding has not committed yet'))
      .mockResolvedValue({
        id: 1,
        cloud_project_id: defaultBoard.id,
        loop_item_id: trackedItem.id,
        project: defaultBoard,
        loop_item: trackedItem,
      })
    const localApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [defaultBoard] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      findCloudContextForTask,
      trackProjectTask: vi.fn(() => new Promise<{ item: CloudLoopItem }>(() => {})),
    }
    const services = {
      projectSpaceApis: {
        local: localApi,
        defaultLocation: 'local',
      },
    } as unknown as WorkbenchServices
    const { result, rerender } = renderHook(
      ({ currentRuntimeTask }: { currentRuntimeTask: RuntimeTaskAddress | null }) =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask,
          currentProjectId: 42,
          defaultProjectSpace: null,
          paneKey: 'project:42',
          runtimeTaskTitle: null,
          services,
          userId: 1,
        }),
      { initialProps: { currentRuntimeTask: null } }
    )

    await waitFor(() => expect(result.current.pendingCloudProject).toEqual(defaultBoard))
    let submission: Awaited<ReturnType<typeof result.current.prepareSubmission>> | undefined
    await act(async () => {
      submission = await result.current.prepareSubmission('验证绑定竞态')
    })
    act(() => submission?.onRuntimeTaskCreated(runtimeTask))
    rerender({ currentRuntimeTask: runtimeTask })

    await waitFor(() => expect(result.current.boundCloudItem).toEqual(trackedItem))
    expect(findCloudContextForTask).toHaveBeenCalledTimes(2)
    expect(result.current.boundCloudProject).toEqual(defaultBoard)
    expect(result.current.pendingCloudProject).toBeNull()
  })

  test('keeps the executor-created work item visible when the runtime title arrives', async () => {
    const defaultBoard = {
      ...project(DEFAULT_WORK_ITEM_PROJECT_ID, 'local'),
      project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
      name: '我的任务',
    }
    const trackedItem = loopItem(defaultBoard.id)
    const runtimeTask = {
      deviceId: 'device-1',
      taskId: 'runtime-1',
    }
    let resolveContext:
      | ((value: {
          id: number
          cloud_project_id: string
          loop_item_id: string
          project: CloudProject
          loop_item: CloudLoopItem
        }) => void)
      | undefined
    const localApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [defaultBoard] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      findCloudContextForTask: vi.fn(
        () =>
          new Promise(resolve => {
            resolveContext = resolve
          })
      ),
      trackProjectTask: vi.fn(),
    }
    const services = {
      projectSpaceApis: {
        local: localApi,
        defaultLocation: 'local',
      },
    } as unknown as WorkbenchServices
    const { result, rerender } = renderHook(
      ({
        currentRuntimeTask,
        runtimeTaskTitle,
      }: {
        currentRuntimeTask: RuntimeTaskAddress | null
        runtimeTaskTitle: string | null
      }) =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask,
          currentProjectId: 42,
          defaultProjectSpace: null,
          paneKey: 'project:42',
          runtimeTaskTitle,
          services,
          userId: 1,
        }),
      {
        initialProps: {
          currentRuntimeTask: null,
          runtimeTaskTitle: null,
        },
      }
    )

    await waitFor(() => expect(result.current.pendingCloudProject).toEqual(defaultBoard))
    let submission: Awaited<ReturnType<typeof result.current.prepareSubmission>> | undefined
    await act(async () => {
      submission = await result.current.prepareSubmission('完成零配置任务')
    })
    act(() => submission?.onRuntimeTaskCreated(runtimeTask))
    rerender({ currentRuntimeTask: runtimeTask, runtimeTaskTitle: null })
    await waitFor(() => expect(localApi.findCloudContextForTask).toHaveBeenCalled())

    rerender({ currentRuntimeTask: runtimeTask, runtimeTaskTitle: '运行时生成的标题' })
    await act(async () =>
      resolveContext?.({
        id: 1,
        cloud_project_id: defaultBoard.id,
        loop_item_id: trackedItem.id,
        project: defaultBoard,
        loop_item: trackedItem,
      })
    )

    await waitFor(() => expect(result.current.boundCloudItem).toEqual(trackedItem))
    expect(result.current.boundCloudProject).toEqual(defaultBoard)
    expect(localApi.trackProjectTask).not.toHaveBeenCalled()
  })

  test('ignores an older missing-context response after an explicit project binding succeeds', async () => {
    const selectedProject = project('selected-project', 'local')
    const trackedItem = loopItem(selectedProject.id)
    const runtimeTask = {
      deviceId: 'device-1',
      taskId: 'runtime-1',
    }
    let rejectInitialLookup: ((reason: Error) => void) | undefined
    const localApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [selectedProject] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      findCloudContextForTask: vi.fn(
        () =>
          new Promise<never>((_, reject) => {
            rejectInitialLookup = reject
          })
      ),
      trackProjectTask: vi.fn().mockResolvedValue({ item: trackedItem }),
    }
    const services = {
      projectSpaceApis: {
        local: localApi,
        defaultLocation: 'local',
      },
    } as unknown as WorkbenchServices
    const { result, rerender } = renderHook(
      ({ currentRuntimeTask }: { currentRuntimeTask: RuntimeTaskAddress | null }) =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask,
          currentProjectId: 42,
          defaultProjectSpace: {
            projectStore: selectedProject.project_store,
            projectId: selectedProject.id,
          },
          paneKey: 'project:42',
          runtimeTaskTitle: null,
          services,
          userId: 1,
        }),
      { initialProps: { currentRuntimeTask: null } }
    )

    await waitFor(() => expect(result.current.pendingCloudProject).toEqual(selectedProject))
    let submission: Awaited<ReturnType<typeof result.current.prepareSubmission>> | undefined
    await act(async () => {
      submission = await result.current.prepareSubmission('完成零配置任务')
    })
    act(() => submission?.onRuntimeTaskCreated(runtimeTask))
    rerender({ currentRuntimeTask: runtimeTask })

    await waitFor(() => expect(result.current.boundCloudItem).toEqual(trackedItem))
    await act(async () => rejectInitialLookup?.(new Error('Cloud context not found')))

    expect(result.current.boundCloudItem).toEqual(trackedItem)
    expect(result.current.boundCloudProject).toEqual(selectedProject)
  })

  test('reloads project spaces when a retained workbench becomes active again', async () => {
    const defaultProject = project('space-default')
    let projects: CloudProject[] = []
    const deliveryApi = {
      listCloudProjects: vi.fn().mockImplementation(async () => ({ items: projects })),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
    }
    const services = {
      deliveryApi,
    } as unknown as WorkbenchServices
    const defaultProjectSpace = {
      projectStore: defaultProject.project_store,
      projectId: defaultProject.id,
    } as const
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useWorkbenchCloudProjectContext({
          active,
          currentRuntimeTask: null,
          currentProjectId: 42,
          defaultProjectSpace,
          paneKey: 'project:42',
          runtimeTaskTitle: null,
          services,
          userId: 1,
        }),
      { initialProps: { active: true } }
    )

    await waitFor(() => expect(deliveryApi.listCloudProjects).toHaveBeenCalledOnce())
    expect(result.current.pendingCloudProject).toBeNull()

    rerender({ active: false })
    projects = [defaultProject]
    rerender({ active: true })

    await waitFor(() => expect(deliveryApi.listCloudProjects).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.pendingCloudProject).toEqual(defaultProject))
  })

  test('does not reload task context when equivalent service and task wrappers rerender', async () => {
    const findCloudContextForTask = vi.fn().mockRejectedValue(new Error('Not bound yet'))
    const deliveryApi = {
      findCloudContextForTask,
      listCloudProjects: vi.fn().mockResolvedValue({ items: [] }),
    }
    const runtimeTask = {
      deviceId: 'device-1',
      taskId: 'runtime-1',
    }
    const { rerender } = renderHook(
      ({
        currentRuntimeTask,
        services,
      }: {
        currentRuntimeTask: RuntimeTaskAddress
        services: WorkbenchServices
      }) =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask,
          currentProjectId: 42,
          defaultProjectSpace: null,
          paneKey: 'project:42',
          runtimeTaskTitle: null,
          services,
          userId: 1,
        }),
      {
        initialProps: {
          currentRuntimeTask: runtimeTask,
          services: { deliveryApi } as unknown as WorkbenchServices,
        },
      }
    )

    await waitFor(() => expect(findCloudContextForTask).toHaveBeenCalledOnce())

    rerender({
      currentRuntimeTask: { ...runtimeTask },
      services: { deliveryApi } as unknown as WorkbenchServices,
    })
    await act(async () => {})

    expect(findCloudContextForTask).toHaveBeenCalledOnce()
  })

  test('loads mentions from the selected local project-space API', async () => {
    const localProject = project('space-local', 'local')
    const item = loopItem(localProject.id)
    const localApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [localProject] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [item] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
    }
    const cloudApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
    }
    const services = {
      projectSpaceApis: {
        local: localApi,
        cloud: cloudApi,
      },
    } as unknown as WorkbenchServices
    const { result } = renderCloudContext(services)

    act(() => result.current.handleTodoBound(localProject, item))

    await waitFor(() => expect(result.current.visibleCloudMentionCandidates).not.toHaveLength(0))
    expect(localApi.listCloudFiles).toHaveBeenCalledWith(localProject.id)
    expect(localApi.listLoopItems).toHaveBeenCalledWith(localProject.id)
    expect(localApi.listDeliveries).toHaveBeenCalledWith(item.id)
    expect(cloudApi.listCloudFiles).not.toHaveBeenCalled()
    expect(cloudApi.listLoopItems).not.toHaveBeenCalled()
  })

  test('keeps transient notice clear callbacks stable across renders', () => {
    const { result, rerender } = renderCloudContext()
    const clearCloudActionNotice = result.current.clearCloudActionNotice
    const clearTodoBindingError = result.current.clearTodoBindingError
    const closeDeliveryDialog = result.current.closeDeliveryDialog

    rerender()

    expect(result.current.clearCloudActionNotice).toBe(clearCloudActionNotice)
    expect(result.current.clearTodoBindingError).toBe(clearTodoBindingError)
    expect(result.current.closeDeliveryDialog).toBe(closeDeliveryDialog)
  })

  test.each([
    {
      description: 'resolved project board tab',
      boardTabId: 'board-existing',
      boardRoute: '/todo?projectStore=local&projectId=space-local',
      cloudProject: { ...project('space-local', 'local'), name: '我的任务' },
      fixed: false,
    },
    {
      description: 'unresolved fixed default project board tab',
      boardTabId: 'fixed-board',
      boardRoute: defaultProjectSpaceContentRoute(),
      cloudProject: {
        ...project(DEFAULT_WORK_ITEM_PROJECT_ID, 'local'),
        project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
        name: '我的任务',
        metadata: { system_kind: 'default_work_items' },
      },
      fixed: true,
    },
  ])('reuses the $description when opening a bound work item', async setup => {
    const { boardRoute, boardTabId, cloudProject, fixed } = setup
    const item = loopItem(cloudProject.id)
    const currentRuntimeTask = {
      deviceId: 'local-device',
      taskId: 'runtime-1',
    }
    const localApi = {
      findCloudContextForTask: vi.fn().mockResolvedValue({
        project: cloudProject,
        loop_item: item,
      }),
      listCloudProjects: vi.fn().mockResolvedValue({ items: [cloudProject] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [item] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
    }
    const services = {
      projectSpaceApis: {
        local: localApi,
        defaultLocation: 'local',
      },
    } as unknown as WorkbenchServices
    const taskTab = {
      id: 'task-existing',
      kind: 'task' as const,
      title: '当前任务',
      contentRoute: '/?deviceId=local-device&taskId=runtime-1',
    }
    const boardTab = {
      id: boardTabId,
      kind: 'board' as const,
      title: fixed ? '工作空间' : '工作项',
      contentRoute: boardRoute,
      fixed,
    }
    const openTab = vi.fn()
    const workspaceTabs = {
      tabs: [taskTab, boardTab],
      activeTabId: taskTab.id,
      activeTab: taskTab,
      openTab,
      selectTab: vi.fn(),
      closeTab: vi.fn(),
      closeOtherTabs: vi.fn(),
      restoreClosedTab: vi.fn(),
      moveTab: vi.fn(),
      updateActiveTab: vi.fn(),
    } as unknown as WorkspaceTabsContextValue
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WorkspaceTabsContext.Provider value={workspaceTabs}>
        {children}
      </WorkspaceTabsContext.Provider>
    )
    const { result } = renderHook(
      () =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask,
          currentProjectId: 42,
          defaultProjectSpace: null,
          paneKey: 'project:42',
          runtimeTaskTitle: '当前任务',
          services,
          userId: 1,
        }),
      { wrapper }
    )

    await waitFor(() => expect(result.current.boundCloudItem).toEqual(item))
    act(() => result.current.openBoundProjectSpaceTask())

    expect(openTab).not.toHaveBeenCalled()
    expect(workspaceTabs.selectTab).toHaveBeenCalledOnce()
    expect(workspaceTabs.selectTab).toHaveBeenCalledWith(boardTab.id, {
      title: '我的任务',
      contentRoute: `/todo?projectStore=${cloudProject.project_store}&projectId=${cloudProject.id}`,
    })
    expect(workspaceTabs.tabs).toEqual([taskTab, boardTab])
  })

  test('creates and binds a board item for an existing runtime task', async () => {
    const targetProject = project('space-target', 'local')
    const createdItem = {
      ...loopItem(targetProject.id),
      status: 'pending' as const,
    }
    const runningItem = {
      ...createdItem,
      status: 'in_progress' as const,
    }
    const currentRuntimeTask = {
      deviceId: 'local-device',
      taskId: 'runtime-existing',
    }
    const localApi = {
      findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not bound yet')),
      listCloudProjects: vi.fn().mockResolvedValue({ items: [targetProject] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      trackProjectTask: vi.fn().mockResolvedValue({ item: createdItem }),
      updateTaskTrackingStatus: vi.fn().mockResolvedValue(runningItem),
    }
    const services = {
      projectSpaceApis: {
        local: localApi,
        defaultLocation: 'local',
      },
    } as unknown as WorkbenchServices
    const { result } = renderHook(() =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask,
        currentProjectId: 42,
        defaultProjectSpace: null,
        paneKey: 'project:42',
        runtimeTaskDescription: '完成已有任务的看板关联',
        runtimeTaskExecutionStatus: 'running',
        runtimeTaskRunning: true,
        runtimeTaskTitle: '已有任务',
        services,
        userId: 1,
      })
    )

    await waitFor(() => expect(result.current.cloudProjects).toEqual([targetProject]))
    act(() => result.current.handleSelectCloudProject(targetProject))
    await waitFor(() => expect(result.current.taskBoardAssociation?.loading).toBe(false))

    act(() => result.current.associateRuntimeTaskWithNewItem())

    await waitFor(() => expect(result.current.boundCloudItem).toEqual(runningItem))
    expect(localApi.trackProjectTask).toHaveBeenCalledWith(
      targetProject.id,
      currentRuntimeTask,
      '已有任务',
      '完成已有任务的看板关联'
    )
    expect(localApi.updateTaskTrackingStatus).toHaveBeenCalledWith(currentRuntimeTask, 'running')
  })

  test('marks a new board item as awaiting confirmation when a settled task reports done', async () => {
    const targetProject = project('space-target', 'local')
    const createdItem = {
      ...loopItem(targetProject.id),
      status: 'inbox' as const,
    }
    const reviewItem = {
      ...createdItem,
      status: 'in_review' as const,
    }
    const currentRuntimeTask = {
      deviceId: 'local-device',
      taskId: 'runtime-existing',
    }
    const localApi = {
      findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not bound yet')),
      listCloudProjects: vi.fn().mockResolvedValue({ items: [targetProject] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      trackProjectTask: vi.fn().mockResolvedValue({ item: createdItem }),
      updateTaskTrackingStatus: vi.fn().mockResolvedValue(reviewItem),
    }
    const services = {
      projectSpaceApis: {
        local: localApi,
        defaultLocation: 'local',
      },
    } as unknown as WorkbenchServices
    const { result } = renderHook(() =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask,
        currentProjectId: 42,
        defaultProjectSpace: null,
        paneKey: 'project:42',
        runtimeTaskExecutionKnown: true,
        runtimeTaskExecutionStatus: 'done',
        runtimeTaskRunning: false,
        runtimeTaskTitle: '已有任务',
        services,
        userId: 1,
      })
    )

    await waitFor(() => expect(result.current.cloudProjects).toEqual([targetProject]))
    act(() => result.current.handleSelectCloudProject(targetProject))
    await waitFor(() => expect(result.current.taskBoardAssociation?.loading).toBe(false))

    act(() => result.current.associateRuntimeTaskWithNewItem())

    await waitFor(() => expect(result.current.boundCloudItem).toEqual(reviewItem))
    expect(localApi.updateTaskTrackingStatus).toHaveBeenCalledWith(currentRuntimeTask, 'succeeded')
  })

  test('moves an existing runtime task by binding the selected target card', async () => {
    const sourceProject = project('space-source', 'local')
    const targetProject = project('space-target', 'local')
    const sourceItem = loopItem(sourceProject.id)
    const targetItem = {
      ...loopItem(targetProject.id),
      id: 'todo-target',
      title: '目标卡片',
      status: 'completed' as const,
    }
    const currentRuntimeTask = {
      deviceId: 'local-device',
      taskId: 'runtime-existing',
    }
    let currentContext = {
      project: sourceProject,
      loop_item: sourceItem,
    }
    const localApi = {
      bindTask: vi.fn().mockImplementation(async () => {
        currentContext = {
          project: targetProject,
          loop_item: targetItem,
        }
      }),
      findCloudContextForTask: vi.fn().mockImplementation(async () => currentContext),
      listCloudProjects: vi.fn().mockResolvedValue({ items: [sourceProject, targetProject] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockImplementation(async projectId => ({
        items: projectId === targetProject.id ? [targetItem] : [sourceItem],
      })),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
    }
    const services = {
      projectSpaceApis: {
        local: localApi,
        defaultLocation: 'local',
      },
    } as unknown as WorkbenchServices
    const { result } = renderHook(() =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask,
        currentProjectId: 42,
        defaultProjectSpace: null,
        paneKey: 'project:42',
        runtimeTaskTitle: '已有任务',
        services,
        userId: 1,
      })
    )

    await waitFor(() => expect(result.current.boundCloudItem).toEqual(sourceItem))
    act(() => result.current.handleSelectCloudProject(targetProject))
    await waitFor(() => expect(result.current.taskBoardAssociation?.items).toEqual([targetItem]))

    act(() => result.current.associateRuntimeTaskWithExistingItem(targetItem))

    await waitFor(() => expect(result.current.boundCloudItem).toEqual(targetItem))
    expect(localApi.bindTask).toHaveBeenCalledWith(targetItem.id, currentRuntimeTask, '已有任务')
    expect(result.current.boundCloudProject).toEqual(targetProject)
    expect(result.current.boundCloudItem?.status).toBe('completed')
  })

  test('maps a cloud task to the local delivery model', () => {
    const item = loopItem('space-cloud')

    expect(
      cloudItemAsLocalWorkItem(item, {
        deviceId: 'device-1',
        taskId: 'runtime-1',
      })
    ).toMatchObject({
      id: item.id,
      title: item.title,
      state: 'started',
      priority: 'normal',
      runtimeRefs: [{ deviceId: 'device-1', taskId: 'runtime-1' }],
    })
  })
})
