import { trackRuntimeTaskCreation } from '@/features/workbench/runtimeTaskCreation'
import {
  DEFAULT_WORK_ITEM_PROJECT_ID,
  DEFAULT_WORK_ITEM_PROJECT_KEY,
  type CloudLoopItem,
  type CloudProject,
} from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import * as navigation from '@/lib/navigation'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  forgetProjectSpaceTaskBinding,
  projectSpaceForRuntimeTask,
  projectSpaceRef,
  publishProjectSpaceTaskBindingChanged,
  publishProjectSpaceTaskContextChanged,
  rememberProjectSpaceTaskBinding,
  subscribeProjectSpaceTaskBindingChanged,
} from '@/features/todo/projectSpaceSelection'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useWorkbenchCloudProjectContext } from './useWorkbenchCloudProjectContext'

import {
  cloudRuntimePort,
  loopItem,
  project,
  renderCloudContext,
} from './workbenchCloudProjectContextTestFixtures'

describe('useWorkbenchCloudProjectContext', () => {
  test('retains handled context lookup causes in the durable E2E diagnostic journal', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const localCause = new Error('local context request failed')
    const backendCause = new Error('backend context request failed')
    const services = {
      projectSpaceApis: {
        local: {
          listCloudProjects: vi.fn().mockResolvedValue({ items: [] }),
          findCloudContextForTask: vi.fn().mockRejectedValue(localCause),
        },
      },
      workspaceRuntimePort: cloudRuntimePort({
        findCloudContextForTask: vi.fn().mockRejectedValue(backendCause),
      }),
    } as unknown as WorkbenchServices
    const { result, unmount } = renderHook(() =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask: { deviceId: 'failure-device', taskId: 'failure-task' },
        defaultProjectSpace: null,
        paneKey: 'context-failure',
        runtimeTaskTitle: null,
        services,
      })
    )
    try {
      await waitFor(() =>
        expect(
          log.mock.calls.some(
            ([prefix, value]) =>
              prefix === '[wework-e2e-diagnostic]' &&
              JSON.parse(String(value)).type === 'project-space-task-context-failed'
          )
        ).toBe(true)
      )
      const report = log.mock.calls
        .filter(([prefix]) => prefix === '[wework-e2e-diagnostic]')
        .map(([, value]) => JSON.parse(String(value)))
        .find(report => report.type === 'project-space-task-context-failed')
      expect(report).toMatchObject({
        details: {
          error: 'Task is not linked to a project space',
          deviceId: 'failure-device',
          taskId: 'failure-task',
          pendingBinding: null,
          causes: [
            { message: localCause.message, stack: localCause.stack },
            { message: backendCause.message, stack: backendCause.stack },
          ],
        },
      })
      expect(result.current.boundCloudProject).toBeNull()
      expect(result.current.boundCloudItem).toBeNull()
    } finally {
      unmount()
      log.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  test('journals a context failure after unmount without applying stale state', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let rejectLookup!: (error: Error) => void
    const held = new Promise<never>((_, reject) => {
      rejectLookup = reject
    })
    const findCloudContextForTask = vi.fn(() => held)
    const services = {
      projectSpaceApis: {
        local: {
          listCloudProjects: vi.fn().mockResolvedValue({ items: [] }),
          findCloudContextForTask,
        },
      },
    } as unknown as WorkbenchServices
    const { unmount } = renderHook(() =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask: { deviceId: 'unmounted-device', taskId: 'unmounted-task' },
        defaultProjectSpace: null,
        paneKey: 'unmounted-context',
        runtimeTaskTitle: null,
        services,
      })
    )
    try {
      await waitFor(() => expect(findCloudContextForTask).toHaveBeenCalledOnce())
      unmount()
      await act(async () => rejectLookup(new Error('Lookup failed after unmount')))
      await waitFor(() => {
        const reports = log.mock.calls
          .filter(([prefix]) => prefix === '[wework-e2e-diagnostic]')
          .map(([, value]) => JSON.parse(String(value)))
        expect(reports).toContainEqual(
          expect.objectContaining({
            type: 'project-space-task-context-failed',
            details: expect.objectContaining({ taskId: 'unmounted-task', active: false }),
          })
        )
      })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      unmount()
      log.mockRestore()
      warn.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  test('context discovery waits for optimistic task creation to finish', async () => {
    const task = { deviceId: 'creation-context-device', taskId: 'pending-context' }
    let accept!: () => void
    const pending = new Promise<void>(resolve => {
      accept = resolve
    })
    trackRuntimeTaskCreation(task, pending)
    const targetProject = project('created-space', 'local')
    const findCloudContextForTask = vi
      .fn()
      .mockResolvedValue({ project: targetProject, loop_item: null })
    const api = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      findCloudContextForTask,
    }
    const services = { projectSpaceApis: { local: api } } as unknown as WorkbenchServices
    const { result, unmount } = renderHook(() =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask: task,
        defaultProjectSpace: null,
        paneKey: 'creation-context-pane',
        runtimeTaskTitle: 'Task',
        services,
      })
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(findCloudContextForTask).not.toHaveBeenCalled()
    await act(async () => {
      accept()
      await pending
    })
    await waitFor(() => expect(result.current.boundCloudProject).toEqual(targetProject))
    expect(findCloudContextForTask).toHaveBeenCalledOnce()
    unmount()
  })
  test.each(['local', 'backend'] as const)(
    'opens an explicit %s Issue execution before optional context resolves',
    projectStore => {
      const navigate = vi.spyOn(navigation, 'navigateTo').mockImplementation(() => {})
      const issueExecution = { projectId: 'source-project', issueId: 'source-issue' }
      try {
        const { result } = renderHook(() =>
          useWorkbenchCloudProjectContext({
            active: true,
            currentRuntimeTask: {
              deviceId: 'execution-device',
              taskId: 'execution-task',
              issueExecution,
              ...(projectStore === 'backend' ? { projectSession: issueExecution } : {}),
            },
            defaultProjectSpace: null,
            paneKey: 'execution-pane',
            runtimeTaskTitle: 'Execution',
          })
        )
        expect(result.current.boundCloudProject).toBeNull()
        expect(result.current.boundCloudItem).toBeNull()
        act(() => result.current.openBoundProjectSpaceTask())
        expect(navigate).toHaveBeenCalledWith(
          '/todo?projectStore=' + projectStore + '&projectId=source-project&itemId=source-issue'
        )
      } finally {
        navigate.mockRestore()
      }
    }
  )

  test('keeps a late association in its owning task while another task is loading', async () => {
    const targetProject = project('late-association-space', 'local')
    const item = loopItem(targetProject.id)
    let finishBinding!: () => void
    const api = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [targetProject] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [item] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      findCloudContextForTask: vi.fn(() => new Promise(() => {})),
      bindTask: vi.fn(() => new Promise<void>(resolve => (finishBinding = resolve))),
    }
    const { result, rerender } = renderHook(
      ({ taskId }) =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask: { deviceId: 'device-retained', taskId },
          defaultProjectSpace: null,
          paneKey: 'late-association-pane',
          runtimeTaskTitle: 'Task A',
          services: { projectSpaceApis: { local: api } } as unknown as WorkbenchServices,
        }),
      { initialProps: { taskId: 'retained-task' } }
    )
    await waitFor(() => expect(result.current.cloudProjects).toEqual([targetProject]))
    act(() => result.current.handleSelectCloudProject(targetProject))
    await waitFor(() => expect(result.current.taskBoardAssociation?.loading).toBe(false))
    act(() => result.current.associateRuntimeTaskWithExistingItem(item))
    expect(api.bindTask).toHaveBeenCalledOnce()
    rerender({ taskId: 'different-task' })
    await act(async () => finishBinding())

    expect(result.current.boundCloudProject).toBeNull()
    expect(result.current.boundCloudItem).toBeNull()
    expect(result.current.taskBoardAssociation).toBeNull()
    expect(result.current.prepareSubmission('Continue task B')).toMatchObject({
      additionalContext: undefined,
      origin: undefined,
      cloudProjectId: undefined,
    })
    rerender({ taskId: 'retained-task' })
    expect(result.current.taskBoardAssociation).toBeNull()
  })

  test('retains the same task binding across hidden tabs and failed refreshes', async () => {
    const targetProject = project('retained-space', 'local')
    const item = loopItem(targetProject.id)
    const findCloudContextForTask = vi.fn().mockResolvedValue({
      project: targetProject,
      loop_item: item,
    })
    const api = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [targetProject] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      findCloudContextForTask,
    }
    const services = { projectSpaceApis: { local: api } } as unknown as WorkbenchServices
    const { result, rerender } = renderHook(
      ({ active, taskId }) =>
        useWorkbenchCloudProjectContext({
          active,
          currentRuntimeTask: { deviceId: 'device-retained', taskId },
          defaultProjectSpace: null,
          paneKey: 'retained-pane',
          runtimeTaskTitle: 'Retained task',
          services,
        }),
      { initialProps: { active: true, taskId: 'retained-task' } }
    )
    await waitFor(() => expect(result.current.boundCloudItem).toEqual(item))
    await act(async () => rerender({ active: false, taskId: 'retained-task' }))
    expect(result.current.boundCloudItem).toEqual(item)
    expect(findCloudContextForTask).toHaveBeenCalledOnce()

    findCloudContextForTask.mockRejectedValue(new Error('Context lookup timed out'))
    await act(async () => rerender({ active: true, taskId: 'retained-task' }))
    expect(findCloudContextForTask).toHaveBeenCalledTimes(2)
    expect(result.current.boundCloudItem).toEqual(item)
    expect(result.current.boundCloudProject).toEqual(targetProject)
    expect(
      result.current.prepareSubmission('Continue after a failed refresh').origin
    ).toMatchObject({
      cloudProjectId: targetProject.id,
      loopItemId: item.id,
    })
    expect(findCloudContextForTask).toHaveBeenCalledTimes(2)

    await act(async () => rerender({ active: false, taskId: 'different-task' }))
    expect(result.current.boundCloudItem).toBeNull()
    expect(result.current.boundCloudProject).toBeNull()
    expect(result.current.prepareSubmission('A different conversation').origin).toBeUndefined()
    expect(findCloudContextForTask).toHaveBeenCalledTimes(2)
  })

  afterEach(() => {
    const { result, unmount } = renderCloudContext()
    act(() => result.current.clearPendingProjectContext())
    unmount()
    for (const address of [
      { deviceId: 'device-1', taskId: 'runtime-1' },
      { deviceId: 'device-1', taskId: 'runtime-2' },
      { deviceId: 'device-retained', taskId: 'retained-task' },
      { deviceId: 'device-retained', taskId: 'different-task' },
      { deviceId: 'cloud-device', taskId: 'claude-task' },
      { deviceId: 'local-device', taskId: 'runtime-existing' },
    ]) {
      const binding = projectSpaceForRuntimeTask(address)
      if (binding) forgetProjectSpaceTaskBinding(address, binding)
    }
  })

  test('prepares a pending backend project and task for runtime creation', async () => {
    const cloudProject = project('space-cloud')
    const item = loopItem(cloudProject.id)
    const runtimeTask = {
      deviceId: 'device-1',
      taskId: 'runtime-1',
    }
    const legacyBindTask = vi.fn().mockResolvedValue(undefined)
    const runtimeBindTask = vi.fn().mockResolvedValue(undefined)
    const deliveryApi = {
      bindTask: legacyBindTask,
      findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not bound yet')),
      listCloudProjects: vi.fn().mockResolvedValue({ items: [cloudProject] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [item] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
    }
    const services = {
      deliveryApi,
      workspaceRuntimePort: cloudRuntimePort({
        ...deliveryApi,
        bindTask: runtimeBindTask,
      }),
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
    const reference = submission?.additionalContext?.cloudCollaboration.value
    expect(reference).toContain(
      JSON.stringify({ project_store: 'backend', space_id: cloudProject.id, item_id: item.id })
    )
    expect(reference).toContain('get_board_item')
    expect(reference).not.toContain(item.title)
    expect(reference).not.toContain(item.description)
    expect(reference).not.toContain(cloudProject.name)
    expect(result.current.pendingCloudProject).toEqual(cloudProject)
    expect(result.current.pendingTodoItem).toEqual(item)

    act(() => submission?.onRuntimeTaskCreated(runtimeTask))
    rerender({ currentRuntimeTask: runtimeTask })

    await waitFor(() =>
      expect(runtimeBindTask).toHaveBeenCalledWith(
        item.id,
        runtimeTask,
        'Implement the selected task'
      )
    )
    expect(legacyBindTask).not.toHaveBeenCalled()
  })

  test('does not reload task context when only the address object identity changes', async () => {
    const findCloudContextForTask = vi.fn().mockRejectedValue(new Error('Not bound yet'))
    const services = {
      deliveryApi: {
        findCloudContextForTask,
      },
      workspaceRuntimePort: cloudRuntimePort({ findCloudContextForTask }),
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
      projectSpaceApis: {
        local: {
          findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not bound yet')),
          listCloudProjects: vi.fn().mockResolvedValue({ items: [firstProject] }),
          listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
          listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
          listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
          trackProjectTask: firstTrackProjectTask,
        },
        defaultLocation: 'local',
      },
    } as unknown as WorkbenchServices
    const secondServices = {
      projectSpaceApis: {
        local: {
          findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not bound yet')),
          listCloudProjects: vi.fn().mockResolvedValue({ items: [secondProject] }),
          listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
          listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
          listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
          trackProjectTask: secondTrackProjectTask,
        },
        defaultLocation: 'local',
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

  test.each([
    { store: 'local' as const, defaultProject: false },
    { store: 'backend' as const, defaultProject: false },
    { store: 'local' as const, defaultProject: true },
  ])(
    'prepares follow-ups without querying pending or loaded context ($store, default=$defaultProject)',
    async ({ store, defaultProject }) => {
      const targetProject = defaultProject
        ? {
            ...project(DEFAULT_WORK_ITEM_PROJECT_ID, store),
            project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
          }
        : project(`space-target-${store}`, store)
      const enrichedItem = {
        ...loopItem(targetProject.id),
        title: 'Updated acceptance criteria',
        has_additional_context: !defaultProject,
      }
      const runtimeTask = {
        deviceId: 'device-1',
        taskId: 'runtime-1',
      }
      let resolveInitialLookup:
        | ((value: { project: CloudProject; loop_item: CloudLoopItem | null }) => void)
        | undefined
      const findCloudContextForTask = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<{ project: CloudProject; loop_item: CloudLoopItem | null }>(resolve => {
              resolveInitialLookup = resolve
            })
        )
        .mockResolvedValue({
          project: targetProject,
          loop_item: enrichedItem,
        })
      const api = {
        listCloudProjects: vi.fn().mockResolvedValue({ items: [targetProject] }),
        listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
        listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
        listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
        findCloudContextForTask,
      }
      const services = {
        projectSpaceApis: {
          ...(store === 'local' ? { local: api } : { cloud: api }),
        },
        ...(store === 'backend' ? { workspaceRuntimePort: cloudRuntimePort(api) } : {}),
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

      await waitFor(() => expect(findCloudContextForTask).toHaveBeenCalledOnce())
      expect(result.current.boundCloudProject).toBeNull()

      const pendingSubmission = result.current.prepareSubmission('Continue while context loads')
      expect(pendingSubmission).not.toBeInstanceOf(Promise)
      expect(pendingSubmission.additionalContext).toBeUndefined()
      expect(findCloudContextForTask).toHaveBeenCalledOnce()

      await act(async () => {
        resolveInitialLookup?.({ project: targetProject, loop_item: enrichedItem })
      })
      await waitFor(() => expect(result.current.boundCloudItem).toEqual(enrichedItem))
      const submission = result.current.prepareSubmission('Apply the updated criteria')
      expect(submission).not.toBeInstanceOf(Promise)
      expect(findCloudContextForTask).toHaveBeenCalledOnce()
      const reference = submission.additionalContext?.cloudCollaboration.value
      expect(reference).toContain(
        JSON.stringify({
          project_store: store,
          space_id: targetProject.id,
          item_id: enrichedItem.id,
        })
      )
      expect(reference).not.toContain(enrichedItem.title)
      expect(reference).not.toContain(enrichedItem.description)
      expect(reference).toContain('current details before relying on them')
      expect(submission.origin).toEqual(
        defaultProject
          ? undefined
          : {
              type: 'board_task',
              projectStore: targetProject.project_store,
              cloudProjectId: targetProject.id,
              loopItemId: enrichedItem.id,
            }
      )
    }
  )

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

    const submission = await result.current.prepareSubmission('继续发送')

    expect(submission.cloudProjectId).toBeUndefined()
    expect(submission.additionalContext).toBeUndefined()

    act(() => submission.onRuntimeTaskCreated(runtimeTask))
    rerender({ currentRuntimeTask: runtimeTask })
    await waitFor(() => expect(localApi.listCloudProjects).toHaveBeenCalledOnce())
    await act(async () => resolveLocalProjects?.({ items: [defaultBoard] }))

    await waitFor(() => expect(result.current.pendingCloudProject).toEqual(defaultBoard))
    expect(localApi.trackProjectTask).not.toHaveBeenCalled()
  })

  test('recovers when the first context lookup races with a pending project binding', async () => {
    const bindingProject = project('binding-race-project', 'local')
    const trackedItem = loopItem(bindingProject.id)
    const runtimeTask = {
      deviceId: 'device-1',
      taskId: 'runtime-1',
    }
    const findCloudContextForTask = vi
      .fn()
      .mockRejectedValueOnce(new Error('Binding has not committed yet'))
      .mockResolvedValue({
        id: 1,
        cloud_project_id: bindingProject.id,
        loop_item_id: trackedItem.id,
        project: bindingProject,
        loop_item: trackedItem,
      })
    const localApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [bindingProject] }),
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
          defaultProjectSpace: projectSpaceRef(bindingProject),
          paneKey: 'project:42',
          runtimeTaskTitle: null,
          services,
          userId: 1,
        }),
      { initialProps: { currentRuntimeTask: null } }
    )

    await waitFor(() => expect(result.current.pendingCloudProject).toEqual(bindingProject))
    let submission: Awaited<ReturnType<typeof result.current.prepareSubmission>> | undefined
    await act(async () => {
      submission = await result.current.prepareSubmission('验证绑定竞态')
    })
    act(() => submission?.onRuntimeTaskCreated(runtimeTask))
    rerender({ currentRuntimeTask: runtimeTask })

    await waitFor(() => expect(result.current.boundCloudItem).toEqual(trackedItem))
    expect(localApi.trackProjectTask).toHaveBeenCalledOnce()
    expect(findCloudContextForTask).toHaveBeenCalledTimes(2)
    expect(result.current.boundCloudProject).toEqual(bindingProject)
    expect(result.current.pendingCloudProject).toBeNull()
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

  test('creates and binds a board item for an existing runtime task', async () => {
    const targetProject = project('space-target', 'local')
    const createdItem = {
      ...loopItem(targetProject.id),
      status: 'pending' as const,
    }
    const currentRuntimeTask = {
      deviceId: 'local-device',
      taskId: 'runtime-existing',
      runtime: 'codex' as const,
      threadId: 'thread-existing',
      workspacePath: '/tmp/existing-worktree',
      workspaceKind: 'worktree' as const,
      worktreeId: 'worktree-existing',
    }
    const localApi = {
      findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not bound yet')),
      listCloudProjects: vi.fn().mockResolvedValue({ items: [targetProject] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      trackProjectTask: vi.fn().mockResolvedValue({ item: createdItem }),
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
        runtimeTaskTitle: '已有任务',
        services,
        userId: 1,
      })
    )

    await waitFor(() => expect(result.current.cloudProjects).toEqual([targetProject]))
    act(() => result.current.handleSelectCloudProject(targetProject))
    await waitFor(() => expect(result.current.taskBoardAssociation?.loading).toBe(false))

    act(() => result.current.associateRuntimeTaskWithNewItem())

    await waitFor(() => expect(result.current.boundCloudItem).toEqual(createdItem))
    expect(localApi.trackProjectTask).toHaveBeenCalledWith(
      targetProject.id,
      currentRuntimeTask,
      '已有任务',
      '完成已有任务的看板关联'
    )
  })

  test('finishes an existing-task association when its inventory resolves during the write', async () => {
    const targetProject = project('space-target', 'local')
    const createdItem = {
      ...loopItem(targetProject.id),
      status: 'pending' as const,
    }
    const currentRuntimeTask = {
      deviceId: 'local-device',
      taskId: 'runtime-existing',
      runtime: 'codex' as const,
      threadId: 'thread-existing',
      workspacePath: '/tmp/existing-worktree',
      workspaceKind: 'worktree' as const,
      worktreeId: 'worktree-existing',
    }
    let finishInventory!: (value: { items: CloudLoopItem[] }) => void
    let finishAssociation!: (value: { item: CloudLoopItem }) => void
    const inventory = new Promise<{ items: CloudLoopItem[] }>(resolve => {
      finishInventory = resolve
    })
    const association = new Promise<{ item: CloudLoopItem }>(resolve => {
      finishAssociation = resolve
    })
    const localApi = {
      findCloudContextForTask: vi.fn().mockRejectedValue(new Error('Not bound yet')),
      listCloudProjects: vi.fn().mockResolvedValue({ items: [targetProject] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockReturnValue(inventory),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      trackProjectTask: vi.fn().mockReturnValue(association),
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
        runtimeTaskTitle: '已有任务',
        services,
        userId: 1,
      })
    )

    await waitFor(() => expect(result.current.cloudProjects).toEqual([targetProject]))
    act(() => result.current.handleSelectCloudProject(targetProject))
    expect(result.current.taskBoardAssociation?.loading).toBe(true)

    act(() => result.current.associateRuntimeTaskWithNewItem())
    expect(result.current.taskBoardAssociation?.pending).toBe(true)
    await act(async () => finishInventory({ items: [] }))
    await act(async () => finishAssociation({ item: createdItem }))

    await waitFor(() => expect(result.current.boundCloudItem).toEqual(createdItem))
    expect(result.current.taskBoardAssociation).toBeNull()
    expect(localApi.trackProjectTask).toHaveBeenCalledWith(
      targetProject.id,
      currentRuntimeTask,
      '已有任务',
      '完成已有任务的看板关联'
    )
  })
})

describe('current project binding context ownership', () => {
  const tasks: RuntimeTaskAddress[] = []
  const task = (id: string, deviceId = 'local-device'): RuntimeTaskAddress => {
    const address = { deviceId, taskId: `context-owner-${id}` }
    tasks.push(address)
    return address
  }
  const sources = (id: string) => {
    const makeApi = (target: CloudProject) => ({
      listCloudProjects: vi.fn().mockResolvedValue({ items: [target] }),
      listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
      findCloudContextForTask: vi.fn().mockResolvedValue({
        project: target,
        loop_item: loopItem(target.id),
      }),
    })
    const projects = {
      local: project(`${id}-local`, 'local'),
      backend: project(`${id}-backend`, 'backend'),
    }
    const apis = { local: makeApi(projects.local), backend: makeApi(projects.backend) }
    const services = {
      projectSpaceApis: { local: apis.local, cloud: apis.backend },
      workspaceRuntimePort: cloudRuntimePort(apis.backend),
    } as unknown as WorkbenchServices
    return { projects, apis, services }
  }
  const renderContext = (address: RuntimeTaskAddress, services: WorkbenchServices) =>
    renderHook(() =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask: address,
        defaultProjectSpace: null,
        paneKey: address.taskId,
        runtimeTaskTitle: 'Current task',
        services,
      })
    )

  afterEach(() => {
    for (const address of tasks.splice(0)) {
      const binding = projectSpaceForRuntimeTask(address)
      if (binding) forgetProjectSpaceTaskBinding(address, binding)
    }
  })

  test.each([
    ['local', 'local-device'],
    ['local', 'remote-device'],
    ['backend', 'local-device'],
    ['backend', 'remote-device'],
  ] as const)('uses the known %s owner on %s for load and send', async (store, deviceId) => {
    const address = task(`${store}-${deviceId}`, deviceId)
    const { projects, apis, services } = sources(address.taskId)
    rememberProjectSpaceTaskBinding(address, projectSpaceRef(projects[store]))
    const other = store === 'local' ? 'backend' : 'local'
    const { result } = renderContext(address, services)

    await waitFor(() => expect(result.current.boundCloudProject).toEqual(projects[store]))
    expect(apis[store].findCloudContextForTask).toHaveBeenCalledOnce()
    expect(apis[other].findCloudContextForTask).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.prepareSubmission('Continue current work')
    })
    expect(apis[store].findCloudContextForTask).toHaveBeenCalledOnce()
    expect(apis[other].findCloudContextForTask).not.toHaveBeenCalled()
  })

  test.each([undefined, 'local', 'backend'] as const)(
    'retains concurrent discovery when only origin %s is available',
    async originStore => {
      const address = {
        ...task(`unknown-${originStore}`),
        runtimeHandle: { origin: { type: 'board_task', projectStore: originStore } },
      }
      const { apis, services } = sources(address.taskId)
      const { result } = renderContext(address, services)
      await waitFor(() => expect(result.current.boundCloudProject).not.toBeNull())
      expect(apis.local.findCloudContextForTask).toHaveBeenCalledOnce()
      expect(apis.backend.findCloudContextForTask).toHaveBeenCalledOnce()
    }
  )

  test('keeps project-session authorization ahead of a local binding and origin', async () => {
    const address = {
      ...task('cloud-session'),
      projectSession: { projectId: 'authorized-project', issueId: 'authorized-issue' },
      runtimeHandle: { origin: { projectStore: 'local' } },
    }
    const { projects, apis, services } = sources(address.taskId)
    rememberProjectSpaceTaskBinding(address, projectSpaceRef(projects.local))
    const { result } = renderContext(address, services)
    await waitFor(() => expect(result.current.boundCloudProject).toEqual(projects.backend))
    expect(apis.local.findCloudContextForTask).not.toHaveBeenCalled()
    const submission = result.current.prepareSubmission('Continue authorized work')
    expect(submission.origin).toMatchObject({
      projectStore: 'backend',
      cloudProjectId: 'authorized-project',
      loopItemId: 'authorized-issue',
    })
    expect(apis.backend.findCloudContextForTask).toHaveBeenCalledOnce()
    expect(apis.local.findCloudContextForTask).not.toHaveBeenCalled()
  })

  test.each(['local', 'backend'] as const)(
    'refreshes a %s binding after moving stores and rejects its late response',
    async store => {
      const other = store === 'local' ? 'backend' : 'local'
      const address = task(`move-${store}`)
      const { projects, apis, services } = sources(address.taskId)
      let resolveInitial!: (value: { project: CloudProject; loop_item: CloudLoopItem }) => void
      apis[store].findCloudContextForTask.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveInitial = resolve
          })
      )
      rememberProjectSpaceTaskBinding(address, projectSpaceRef(projects[store]))
      const { result } = renderContext(address, services)
      await waitFor(() => expect(apis[store].findCloudContextForTask).toHaveBeenCalledOnce())
      expect(apis[other].findCloudContextForTask).not.toHaveBeenCalled()

      act(() =>
        publishProjectSpaceTaskBindingChanged({
          task: address,
          project: projectSpaceRef(projects[other]),
          type: 'bound',
        })
      )
      await waitFor(() => expect(result.current.boundCloudProject).toEqual(projects[other]))
      await act(async () => {
        resolveInitial({ project: projects[store], loop_item: loopItem(projects[store].id) })
      })
      expect(result.current.boundCloudProject).toEqual(projects[other])
      expect(projectSpaceForRuntimeTask(address)).toEqual(projectSpaceRef(projects[other]))
    }
  )

  test('invalidates an unbound owner and discovers the actual new binding', async () => {
    const address = task('unbound')
    const { projects, apis, services } = sources(address.taskId)
    rememberProjectSpaceTaskBinding(address, projectSpaceRef(projects.local))
    const { result } = renderContext(address, services)
    await waitFor(() => expect(result.current.boundCloudProject).toEqual(projects.local))
    expect(apis.backend.findCloudContextForTask).not.toHaveBeenCalled()
    apis.local.findCloudContextForTask.mockRejectedValue(new Error('No local binding'))

    act(() =>
      publishProjectSpaceTaskBindingChanged({
        task: address,
        project: projectSpaceRef(projects.local),
        type: 'unbound',
      })
    )
    await waitFor(() => expect(result.current.boundCloudProject).toEqual(projects.backend))
    expect(apis.local.findCloudContextForTask).toHaveBeenCalledTimes(2)
    expect(apis.backend.findCloudContextForTask).toHaveBeenCalledOnce()
    expect(projectSpaceForRuntimeTask(address)).toEqual(projectSpaceRef(projects.backend))
  })

  test('uses a confirmed context change for refresh and the latest cache before send', async () => {
    const address = task('context-event')
    const { projects, apis, services } = sources(address.taskId)
    rememberProjectSpaceTaskBinding(address, projectSpaceRef(projects.local))
    const { result } = renderContext(address, services)
    await waitFor(() => expect(result.current.boundCloudProject).toEqual(projects.local))
    act(() =>
      publishProjectSpaceTaskContextChanged({
        task: address,
        project: projectSpaceRef(projects.backend),
      })
    )
    await waitFor(() => expect(result.current.boundCloudProject).toEqual(projects.backend))

    rememberProjectSpaceTaskBinding(address, projectSpaceRef(projects.local))
    const submission = result.current.prepareSubmission('Read the current binding')
    expect(submission).not.toBeInstanceOf(Promise)
    expect(submission.additionalContext?.cloudCollaboration.value).toContain(projects.local.id)
    expect(submission.additionalContext?.cloudCollaboration.value).not.toContain(
      projects.backend.id
    )
    expect(submission.origin).toBeUndefined()
    expect(result.current.boundCloudProject).toEqual(projects.backend)
    expect(apis.local.findCloudContextForTask).toHaveBeenCalledOnce()
    expect(apis.backend.findCloudContextForTask).toHaveBeenCalledOnce()
  })

  test('replaces a stale cached project with the actual returned project', async () => {
    const address = task('actual-project')
    const { projects, apis, services } = sources(address.taskId)
    const actualProject = project('actual-local-context', 'local')
    rememberProjectSpaceTaskBinding(address, projectSpaceRef(projects.local))
    apis.local.findCloudContextForTask.mockResolvedValue({
      project: actualProject,
      loop_item: loopItem(actualProject.id),
    })
    const { result } = renderContext(address, services)
    await waitFor(() => expect(result.current.boundCloudProject).toEqual(actualProject))
    expect(projectSpaceForRuntimeTask(address)).toEqual(projectSpaceRef(actualProject))
    expect(apis.local.findCloudContextForTask).toHaveBeenCalledTimes(2)
    expect(apis.backend.findCloudContextForTask).toHaveBeenCalledOnce()
  })

  test('publishes confirmed discovered bindings once without reloading its own read', async () => {
    const address = task('confirmed-event')
    const { apis, services } = sources(address.taskId)
    const observed = vi.fn()
    const unsubscribe = subscribeProjectSpaceTaskBindingChanged(observed)
    try {
      const { result } = renderContext(address, services)
      await waitFor(() => expect(result.current.boundCloudProject).not.toBeNull())
      expect(observed).toHaveBeenCalledOnce()
      expect(observed).toHaveBeenCalledWith({
        task: address,
        project: projectSpaceRef(result.current.boundCloudProject!),
        type: 'bound',
      })
      expect(apis.local.findCloudContextForTask).toHaveBeenCalledOnce()
      expect(apis.backend.findCloudContextForTask).toHaveBeenCalledOnce()
    } finally {
      unsubscribe()
    }
  })

  test.each([true, false])(
    'reports an unavailable known owner with other APIs present: %s',
    async hasOtherApi => {
      const address = task(`unavailable-owner-${hasOtherApi}`)
      const { projects, apis, services } = sources(address.taskId)
      const unavailableServices = hasOtherApi
        ? { ...services, workspaceRuntimePort: undefined }
        : {}
      rememberProjectSpaceTaskBinding(address, projectSpaceRef(projects.backend))
      const { result, rerender } = renderHook(
        ({ currentServices }) =>
          useWorkbenchCloudProjectContext({
            active: true,
            currentRuntimeTask: address,
            defaultProjectSpace: null,
            paneKey: address.taskId,
            runtimeTaskTitle: 'Current task',
            services: currentServices,
          }),
        { initialProps: { currentServices: unavailableServices as WorkbenchServices } }
      )
      await waitFor(() => expect(result.current.todoBindingError).not.toBeNull())
      expect(result.current.boundCloudProject).toBeNull()
      expect(apis.local.findCloudContextForTask).not.toHaveBeenCalled()
      const submission = result.current.prepareSubmission('Continue')
      expect(submission).not.toBeInstanceOf(Promise)
      expect(submission.cloudProjectId).toBe(projects.backend.id)
      expect(submission.additionalContext?.cloudCollaboration.value).toContain(projects.backend.id)
      expect(submission.additionalContext?.cloudCollaboration.value).not.toContain(
        projects.local.id
      )
      expect(result.current.todoBindingError).not.toBeNull()
      expect(apis.local.findCloudContextForTask).not.toHaveBeenCalled()
      rerender({ currentServices: services })
      await waitFor(() => expect(result.current.boundCloudProject).toEqual(projects.backend))
      expect(result.current.todoBindingError).toBeNull()
    }
  )
})

test('standalone default-board tasks do not poll nonexistent bindings and still accept a later binding event', async () => {
  const defaultBoard = {
    ...project(DEFAULT_WORK_ITEM_PROJECT_ID, 'local'),
    project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
    name: '我的任务',
  }
  const task = { deviceId: 'default-no-binding-device', taskId: 'standalone-default-task' }
  const item = loopItem(defaultBoard.id)
  const findCloudContextForTask = vi.fn().mockRejectedValue(new Error('Task is not linked'))
  const trackProjectTask = vi.fn()
  const localApi = {
    listCloudProjects: vi.fn().mockResolvedValue({ items: [defaultBoard] }),
    listCloudFiles: vi.fn().mockResolvedValue({ items: [] }),
    listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
    listDeliveries: vi.fn().mockResolvedValue({ items: [] }),
    findCloudContextForTask,
    trackProjectTask,
  }
  const services = {
    projectSpaceApis: { local: localApi, defaultLocation: 'local' },
  } as unknown as WorkbenchServices
  const { result, rerender, unmount } = renderHook(
    ({ currentRuntimeTask }: { currentRuntimeTask: RuntimeTaskAddress | null }) =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask,
        currentProjectId: 42,
        defaultProjectSpace: null,
        paneKey: 'default-no-binding',
        runtimeTaskTitle: null,
        services,
        userId: 1,
      }),
    { initialProps: { currentRuntimeTask: null } }
  )
  try {
    await waitFor(() => expect(result.current.pendingCloudProject).toEqual(defaultBoard))
    let submission!: Awaited<ReturnType<typeof result.current.prepareSubmission>>
    await act(async () => {
      submission = await result.current.prepareSubmission('Standalone task')
    })
    vi.useFakeTimers()
    await act(async () => {
      submission.onRuntimeTaskCreated(task)
      rerender({ currentRuntimeTask: task })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(trackProjectTask).not.toHaveBeenCalled()
    expect(findCloudContextForTask).toHaveBeenCalledOnce()
    expect(result.current.pendingCloudProject).toEqual(defaultBoard)
    findCloudContextForTask.mockResolvedValue({ project: defaultBoard, loop_item: item })
    await act(async () => {
      publishProjectSpaceTaskBindingChanged({
        task,
        project: projectSpaceRef(defaultBoard),
        type: 'bound',
      })
    })
    expect(findCloudContextForTask).toHaveBeenCalledTimes(2)
    expect(result.current.boundCloudItem).toEqual(item)
  } finally {
    unmount()
    vi.useRealTimers()
    forgetProjectSpaceTaskBinding(task)
  }
})
