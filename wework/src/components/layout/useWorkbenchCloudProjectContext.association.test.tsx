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
} from './workbenchCloudProjectContextTestFixtures'

describe.each(['local', 'backend'] as const)('new task association in %s projects', store => {
  afterEach(() => {
    const { result, unmount } = renderCloudContext()
    act(() => result.current.clearPendingProjectContext())
    unmount()
  })

  test.each(['existing', 'new'] as const)(
    'defers the %s Issue association until the first message creates a session',
    async choice => {
      const target = project(`draft-${store}`, store)
      const issue = loopItem(target.id)
      let boundItem: CloudLoopItem | null = null
      const api = {
        listCloudProjects: vi.fn().mockResolvedValue({ items: [target] }),
        listLoopItems: vi.fn().mockResolvedValue({ items: [issue] }),
        listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
        listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
        findCloudContextForTask: vi.fn().mockImplementation(async () => {
          if (!boundItem) throw new Error('Not bound yet')
          return { project: target, loop_item: boundItem }
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
      expect(result.current.taskBoardAssociation).toBeNull()
      expect(result.current.pendingCloudProject).toEqual(target)
      expect(result.current.pendingTodoItem).toEqual(choice === 'existing' ? issue : null)
      expect(result.current.cloudActionNotice).toContain(
        choice === 'existing' ? issue.title : target.name
      )
      expect(api.bindTask).not.toHaveBeenCalled()
      expect(api.trackProjectTask).not.toHaveBeenCalled()

      const submission = await act(() => result.current.prepareSubmission('First message'))
      expect(submission.origin?.loopItemId).toBe(choice === 'existing' ? issue.id : undefined)
      expect(submission.additionalContext?.cloudCollaboration.value).toContain(target.name)
      expect(api.bindTask).not.toHaveBeenCalled()
      expect(api.trackProjectTask).not.toHaveBeenCalled()
      const task = { deviceId: 'draft-device', taskId: `draft-${store}-${choice}` }
      act(() => submission.onRuntimeTaskCreated(task))
      rerender({ task })

      await waitFor(() => expect(result.current.boundCloudItem).toEqual(issue))
      if (choice === 'existing') {
        expect(api.bindTask).toHaveBeenCalledExactlyOnceWith(issue.id, task, 'First message')
        expect(api.trackProjectTask).not.toHaveBeenCalled()
      } else {
        expect(api.trackProjectTask).toHaveBeenCalledExactlyOnceWith(
          target.id,
          task,
          'First message',
          'First message'
        )
        expect(api.bindTask).not.toHaveBeenCalled()
      }
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
