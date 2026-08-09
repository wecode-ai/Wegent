import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
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
  test('prepares a pending backend project and task for runtime creation', async () => {
    const cloudProject = project('space-cloud')
    const item = loopItem(cloudProject.id)
    const { result } = renderCloudContext()

    await act(async () => {})
    act(() => result.current.handleTodoBound(cloudProject, item))

    let submission: ReturnType<typeof result.current.prepareSubmission> | undefined
    act(() => {
      submission = result.current.prepareSubmission('Implement the selected task')
    })

    expect(submission?.cloudProjectId).toBe(cloudProject.id)
    expect(submission?.additionalContext?.cloudCollaboration.value).toContain(
      `Current task: ${item.id} — ${item.title}.`
    )
    expect(result.current.pendingCloudProject).toEqual(cloudProject)
    expect(result.current.pendingTodoItem).toEqual(item)

    act(() => result.current.clearPendingProjectContext())
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

    act(() => result.current.clearPendingProjectContext())
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

    act(() => result.current.clearPendingProjectContext())
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
