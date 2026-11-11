import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskAddress } from '@/types/api'
import { useWorkbenchCloudProjectContext } from './useWorkbenchCloudProjectContext'
import {
  cloudRuntimePort,
  loopItem,
  project,
  renderCloudContext,
  threadOwner,
} from './workbenchCloudProjectContextTestFixtures'

describe.each(['local', 'backend'] as const)('new task association in %s projects', store => {
  afterEach(() => {
    const { result, unmount } = renderCloudContext()
    act(() => result.current.clearPendingProjectContext())
    unmount()
    vi.restoreAllMocks()
  })

  test.each(['existing', 'new'] as const)(
    'defers the %s Issue association until the first message creates a session',
    async choice => {
      const diagnostics = vi.spyOn(console, 'info').mockImplementation(() => {})
      const target = project(`draft-${store}`, store)
      const { owner: group, groups } = threadOwner(`group-${store}`, store)
      const issue =
        choice === 'new'
          ? { ...loopItem(group.id), group_id: group.id, project_id: target.id }
          : loopItem(target.id)
      const bindingOwner = choice === 'new' ? group : target
      let boundItem: CloudLoopItem | null = null
      const api = {
        listCloudProjects: vi.fn().mockResolvedValue({ items: [target] }),
        listLoopItems: vi.fn().mockResolvedValue({ items: [issue] }),
        listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
        listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
        findCloudContextForTask: vi.fn().mockImplementation(async () => {
          if (!boundItem) throw new Error('Not bound yet')
          return { project: bindingOwner, loop_item: boundItem }
        }),
        bindTask: vi.fn().mockImplementation(async () => {
          boundItem = issue
        }),
        trackProjectTask: vi.fn().mockImplementation(async () => {
          boundItem = issue
          return { item: issue }
        }),
      }
      const services = {
        deliveryApi: api,
        projectSpaceApis: { [store === 'local' ? 'local' : 'cloud']: api },
        chatGroupApis: { [store === 'local' ? 'local' : 'cloud']: groups },
        ...(store === 'backend' ? { workspaceRuntimePort: cloudRuntimePort(api) } : {}),
      } as unknown as WorkbenchServices
      const { result, rerender } = renderHook(
        ({ task }: { task: RuntimeTaskAddress | null }) =>
          useWorkbenchCloudProjectContext({
            active: true,
            currentRuntimeTask: task,
            currentProjectId: 42,
            defaultProjectSpace: null,
            paneKey: 'project:42',
            runtimeTaskTitle: null,
            services,
            userId: 1,
          }),
        { initialProps: { task: null } }
      )

      act(() => result.current.handleSelectCloudProject(target))
      expect(result.current.taskBoardAssociation?.project).toEqual(target)
      await waitFor(() => expect(result.current.taskBoardAssociation?.items).toEqual([issue]))
      expect(result.current.pendingCloudProject).toBeNull()
      act(() => {
        if (choice === 'existing') result.current.associateRuntimeTaskWithExistingItem(issue)
        else result.current.associateRuntimeTaskWithNewItem()
      })
      if (choice === 'new') {
        expect(result.current.taskOriginCreation?.target).toEqual(target)
        expect(result.current.pendingCloudProject).toBeNull()
        expect(api.trackProjectTask).not.toHaveBeenCalled()
        expect(api.bindTask).not.toHaveBeenCalled()
        await act(() => result.current.associateCreatedTaskOrigin(issue, group))
      }
      expect(result.current.taskBoardAssociation).toBeNull()
      expect(result.current.pendingCloudProject).toEqual(bindingOwner)
      expect(result.current.pendingTodoItem).toEqual(issue)
      expect(result.current.cloudActionNotice).toContain(issue.title)
      expect(api.bindTask).not.toHaveBeenCalled()
      expect(api.trackProjectTask).not.toHaveBeenCalled()

      const submission = await act(() => result.current.prepareSubmission('First message'))
      expect(submission.origin?.loopItemId).toBe(issue.id)
      expect(submission.origin?.cloudProjectId).toBe(bindingOwner.id)
      expect(submission.additionalContext?.cloudCollaboration.value).toContain(bindingOwner.name)
      expect(api.bindTask).not.toHaveBeenCalled()
      expect(api.trackProjectTask).not.toHaveBeenCalled()
      const task = { deviceId: 'draft-device', taskId: `draft-${store}-${choice}` }
      act(() => submission.onRuntimeTaskCreated(task))
      rerender({ task })

      await waitFor(() => expect(result.current.boundCloudItem).toEqual(issue))
      expect(api.bindTask).toHaveBeenCalledExactlyOnceWith(issue.id, task, 'First message')
      expect(api.trackProjectTask).not.toHaveBeenCalled()
      const boundUpdate = diagnostics.mock.calls
        .map(([, serialized]) => JSON.parse(serialized))
        .find(entry => entry.stage === 'project-space-context-bound-update')
      expect(boundUpdate).toEqual({
        timestamp: expect.any(String),
        stage: 'project-space-context-bound-update',
        itemVersion: issue.version,
        hasGroupOwner: Boolean(issue.group_id),
      })
    }
  )

  test('preserves the draft selection when another project dialog is cancelled or fails to load', async () => {
    const selected = project(`selected-${store}`, store)
    const other = project(`other-${store}`, store)
    const api = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [selected, other] }),
      listLoopItems: vi.fn().mockRejectedValue(new Error('Cannot load board')),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
    }
    const { result } = renderCloudContext({
      deliveryApi: api,
      projectSpaceApis: { [store === 'local' ? 'local' : 'cloud']: api },
    } as unknown as WorkbenchServices)
    act(() => result.current.handleTodoBound(selected, loopItem(selected.id)))

    act(() => result.current.handleSelectCloudProject(other))
    await waitFor(() => expect(result.current.todoBindingError).toBe('Cannot load board'))
    expect(result.current.taskBoardAssociation?.loading).toBe(false)
    expect(result.current.pendingCloudProject).toEqual(selected)
    act(() => result.current.closeTaskBoardAssociation())
    expect(result.current.taskBoardAssociation).toBeNull()
    expect(result.current.pendingCloudProject).toEqual(selected)
    expect(result.current.pendingTodoItem?.cloud_project_id).toBe(selected.id)
  })
})
