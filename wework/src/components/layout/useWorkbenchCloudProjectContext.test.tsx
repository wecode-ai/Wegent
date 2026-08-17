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

  test('tracks the default work-item project when the user configured nothing', async () => {
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
      findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not bound yet')),
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

    await waitFor(() =>
      expect(localApi.trackProjectTask).toHaveBeenCalledWith(
        defaultBoard.id,
        runtimeTask,
        '完成零配置任务',
        '完成零配置任务'
      )
    )
  })

  test('does not block submission when the default work-item lookup stalls', async () => {
    vi.useFakeTimers()
    try {
      const localApi = {
        listCloudProjects: vi.fn(() => new Promise<never>(() => {})),
      }
      const services = {
        projectSpaceApis: {
          local: localApi,
          defaultLocation: 'local',
        },
      } as unknown as WorkbenchServices
      const { result } = renderCloudContext(services)
      let submission: Awaited<ReturnType<typeof result.current.prepareSubmission>> | undefined

      const pendingSubmission = result.current.prepareSubmission('继续发送')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500)
        submission = await pendingSubmission
      })

      expect(submission?.cloudProjectId).toBeUndefined()
      expect(submission?.additionalContext).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
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

  test('keeps the created work item visible when the runtime title arrives during binding', async () => {
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
    let resolveTracking: ((value: { item: CloudLoopItem }) => void) | undefined
    const localApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [defaultBoard] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not bound yet')),
      trackProjectTask: vi.fn(
        () =>
          new Promise<{ item: CloudLoopItem }>(resolve => {
            resolveTracking = resolve
          })
      ),
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
    await waitFor(() => expect(localApi.trackProjectTask).toHaveBeenCalledOnce())

    rerender({ currentRuntimeTask: runtimeTask, runtimeTaskTitle: '运行时生成的标题' })
    await act(async () => resolveTracking?.({ item: trackedItem }))

    await waitFor(() => expect(result.current.boundCloudItem).toEqual(trackedItem))
    expect(result.current.boundCloudProject).toEqual(defaultBoard)
  })

  test('ignores an older missing-context response after binding succeeds', async () => {
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
    let rejectInitialLookup: ((reason: Error) => void) | undefined
    const localApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [defaultBoard] }),
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
    await act(async () => rejectInitialLookup?.(new Error('Cloud context not found')))

    expect(result.current.boundCloudItem).toEqual(trackedItem)
    expect(result.current.boundCloudProject).toEqual(defaultBoard)
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

  test('reuses the existing project board tab when opening a bound work item', async () => {
    const cloudProject = project('space-local', 'local')
    cloudProject.name = '我的任务'
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
      id: 'board-existing',
      kind: 'board' as const,
      title: '工作项',
      contentRoute: `/todo?projectStore=${cloudProject.project_store}&projectId=${cloudProject.id}`,
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
      contentRoute: `/todo?projectStore=${cloudProject.project_store}&projectId=${cloudProject.id}&itemId=${item.id}`,
    })
    expect(workspaceTabs.tabs).toEqual([taskTab, boardTab])
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
