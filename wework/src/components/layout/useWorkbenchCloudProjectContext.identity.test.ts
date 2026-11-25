import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  DEFAULT_WORK_ITEM_PROJECT_ID,
  DEFAULT_WORK_ITEM_PROJECT_KEY,
  type CloudLoopItem,
} from '@/api/deliveries'
import { ApiError } from '@/api/http'
import {
  findProjectSpaceContextSourceForTask,
  projectSpaceRef,
  publishProjectSpaceTaskContextChanged,
} from '@/features/todo/projectSpaceSelection'
import type { DeliveryApi } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'
import * as navigation from '@/lib/navigation'
import { cloudRuntimePort, loopItem, project } from './workbenchCloudProjectContextTestFixtures'
import { useWorkbenchCloudProjectContext } from './useWorkbenchCloudProjectContext'

const systemProject = {
  ...project(DEFAULT_WORK_ITEM_PROJECT_ID, 'local'),
  project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
}

test('defers project context lookup until optimistic task creation is accepted', async () => {
  const board = project('creation-board')
  const item = loopItem(board.id)
  const findCloudContextForTask = vi.fn(async () => ({ project: board, loop_item: item }))
  const services = { workspaceRuntimePort: cloudRuntimePort({ findCloudContextForTask }) }
  const address = { deviceId: 'creation-device', taskId: 'creation-task' }
  const { result, rerender } = renderHook(
    ({ creating }) =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask: address,
        runtimeTaskCreationPending: creating,
        defaultProjectSpace: null,
        paneKey: 'runtime:creation-device:creation-task',
        runtimeTaskTitle: 'New task',
        services,
        userId: 1,
      }),
    { initialProps: { creating: true } }
  )

  expect(findCloudContextForTask).not.toHaveBeenCalled()
  rerender({ creating: false })
  await waitFor(() => expect(result.current.boundCloudItem?.id).toBe(item.id))
  expect(findCloudContextForTask).toHaveBeenCalledTimes(1)
})

test('resolves an Issue binding that returns after the project selection window', async () => {
  vi.useFakeTimers()
  try {
    const board = project('slow-binding-board')
    const context = { project: board, loop_item: loopItem(board.id) }
    const response = Promise.withResolvers<typeof context>()
    const api = { findCloudContextForTask: () => response.promise }
    const lookup = findProjectSpaceContextSourceForTask(
      [api],
      { deviceId: 'local-device', taskId: 'bound-task' },
      5_000
    )
    const assertion = expect(lookup).resolves.toEqual({ api, context })
    await vi.advanceTimersByTimeAsync(5_001)
    response.resolve(context)
    await assertion
  } finally {
    vi.useRealTimers()
  }
})

// A discovery refresh must not blank a bound project while its new address is loading.
test('retains the same owner binding during alias refresh but isolates another device', async () => {
  const board = project('picker-board')
  const item = loopItem(board.id)
  let refresh = false
  const findCloudContextForTask = vi.fn(async () => {
    if (refresh) return new Promise<never>(() => {})
    return { project: board, loop_item: item }
  })
  const services = { workspaceRuntimePort: cloudRuntimePort({ findCloudContextForTask }) }
  const devices: DeviceInfo[] = [
    {
      id: 79,
      device_id: 'electron-local',
      socket_device_id: 'app-record-79',
      name: 'Local',
      status: 'online',
      device_type: 'local',
      is_default: true,
    },
  ]
  const address = (deviceId: string): RuntimeTaskAddress => ({ deviceId, taskId: 'task' })
  const { result, rerender } = renderHook(
    ({ task, knownDevices }) =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask: task,
        devices: knownDevices,
        defaultProjectSpace: null,
        paneKey: `runtime:${task.deviceId}:${task.taskId}`,
        runtimeTaskTitle: 'Picker task',
        services,
        userId: 1,
      }),
    { initialProps: { task: address('app-record-79'), knownDevices: [] as DeviceInfo[] } }
  )
  await waitFor(() => expect(result.current.boundCloudProject?.id).toBe(board.id))
  refresh = true
  rerender({ task: address('electron-local'), knownDevices: devices })
  expect(result.current.boundCloudProject?.id).toBe(board.id)
  expect(result.current.boundCloudItem?.id).toBe(item.id)
  rerender({ task: address('another-device'), knownDevices: devices })
  expect(result.current.boundCloudProject).toBeNull()
  expect(result.current.boundCloudItem).toBeNull()
})

test.each([false, true])(
  'recovers a persisted task association after a transient lookup timeout (system Issue: %s)',
  async hasSystemIssue => {
    vi.useFakeTimers()
    const board = project('persisted-board')
    const item = loopItem(board.id)
    const response = Promise.withResolvers<{ project: typeof board; loop_item: CloudLoopItem }>()
    try {
      const findCloudContextForTask = vi
        .fn()
        .mockReturnValueOnce(response.promise)
        .mockResolvedValue({ project: board, loop_item: item })
      const services = {
        workspaceRuntimePort: cloudRuntimePort({ findCloudContextForTask }),
        ...(hasSystemIssue
          ? {
              projectSpaceApis: {
                local: {
                  findCloudContextForTask: async () => ({
                    project: systemProject,
                    loop_item: loopItem(systemProject.id),
                  }),
                } as DeliveryApi,
              },
            }
          : {}),
      }
      const { result, unmount } = renderHook(() =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask: {
            deviceId: 'persisted-device',
            taskId: `persisted-task-${hasSystemIssue}`,
          },
          defaultProjectSpace: null,
          paneKey: 'runtime:persisted-device:persisted-task',
          runtimeTaskTitle: 'Persisted task',
          services,
          userId: 1,
        })
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_200)
      })
      expect(result.current.boundCloudProject?.id).toBe(board.id)
      expect(result.current.boundCloudItem?.id).toBe(item.id)
      await act(async () => {
        response.resolve({ project: systemProject, loop_item: loopItem(systemProject.id) })
      })
      expect(result.current.boundCloudProject?.id).toBe(board.id)
      expect(result.current.boundCloudItem?.id).toBe(item.id)
      unmount()
    } finally {
      response.resolve({ project: board, loop_item: item })
      vi.useRealTimers()
    }
  }
)

test('reopening a task resolves its remote Issue even when the system Issue was remembered', async () => {
  const board = project('reopened-board')
  const item = { ...loopItem(board.id), id: 'REMOTE-42' }
  let linked = false
  const services = {
    projectSpaceApis: {
      local: {
        findCloudContextForTask: async () => ({
          project: systemProject,
          loop_item: loopItem(systemProject.id),
        }),
      } as DeliveryApi,
    },
    workspaceRuntimePort: cloudRuntimePort({
      async findCloudContextForTask() {
        if (!linked) throw new ApiError('Not bound to a cloud project', 404)
        return { project: board, loop_item: item }
      },
    }),
  }
  const options = {
    active: true,
    currentRuntimeTask: { deviceId: 'reopened-device', taskId: 'reopened-task' },
    defaultProjectSpace: null,
    paneKey: 'runtime:reopened-device:reopened-task',
    runtimeTaskTitle: 'Reopened task',
    services,
    userId: 1,
  }
  const original = renderHook(() => useWorkbenchCloudProjectContext(options))
  await waitFor(() => expect(original.result.current.boundCloudProject?.id).toBe(systemProject.id))
  original.unmount()

  linked = true
  const navigate = vi.spyOn(navigation, 'navigateTo').mockImplementation(() => {})
  try {
    const reopened = renderHook(() => useWorkbenchCloudProjectContext(options))
    await waitFor(() => expect(reopened.result.current.boundCloudItem?.id).toBe(item.id))
    expect(reopened.result.current.boundCloudProject?.id).toBe(board.id)
    act(() => reopened.result.current.openBoundProjectSpaceTask())
    expect(navigate).toHaveBeenCalledWith(
      `/todo?projectStore=backend&projectId=${board.id}&itemId=${item.id}`
    )
    reopened.unmount()
  } finally {
    navigate.mockRestore()
  }
})

test.each(['changed', 'missing', 'failed'] as const)(
  'retries an incomplete cloud association after the Issue read is %s',
  async issueRead => {
    vi.useFakeTimers()
    const previous = project('previous-board')
    const latest = project('changed-board')
    const latestItem = { ...loopItem(latest.id), id: 'CHANGED-42' }
    const expectedItem = issueRead === 'missing' ? null : latestItem
    const issueReadStarted = Promise.withResolvers<void>()
    const issueResponse = Promise.withResolvers<CloudLoopItem>()
    try {
      let context: { project: typeof previous; loop_item: CloudLoopItem | null } = {
        project: previous,
        loop_item: loopItem(previous.id),
      }
      const port = cloudRuntimePort({ findCloudContextForTask: async () => context })
      vi.spyOn(port, 'findIssueForTask').mockImplementationOnce(() => {
        issueReadStarted.resolve()
        return issueResponse.promise
      })
      const services = {
        projectSpaceApis: {
          local: {
            findCloudContextForTask: async () => ({
              project: systemProject,
              loop_item: loopItem(systemProject.id),
            }),
          } as DeliveryApi,
        },
        workspaceRuntimePort: port,
      }
      const { result, unmount } = renderHook(() =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask: { deviceId: 'changed-device', taskId: `changed-task-${issueRead}` },
          defaultProjectSpace: null,
          paneKey: `runtime:changed-device:changed-task-${issueRead}`,
          runtimeTaskTitle: 'Changed task',
          services,
        })
      )
      await act(async () => {
        await issueReadStarted.promise
        context = { project: latest, loop_item: expectedItem }
        if (issueRead === 'changed') issueResponse.resolve(latestItem)
        else if (issueRead === 'missing') issueResponse.reject(new ApiError('Issue not found', 404))
        else issueResponse.reject(new Error('Issue read failed'))
      })
      expect(result.current.boundCloudProject).toBeNull()
      await act(async () => vi.advanceTimersByTimeAsync(100))
      expect(result.current.boundCloudProject?.id).toBe(latest.id)
      expect(result.current.boundCloudItem?.id ?? null).toBe(expectedItem?.id ?? null)
      unmount()
    } finally {
      issueResponse.resolve(latestItem)
      vi.useRealTimers()
    }
  }
)

test.each(['issue read', 'timeout'] as const)(
  'exposes a retry after exhausted association lookup failures (%s)',
  async failure => {
    vi.useFakeTimers()
    const board = project('retry-board')
    const item = { ...loopItem(board.id), id: 'RETRY-42' }
    const delayed = Promise.withResolvers<{ project: typeof board; loop_item: CloudLoopItem }>()
    let recovered = false
    const findCloudContextForTask = vi.fn(async () =>
      !recovered && failure === 'timeout' ? delayed.promise : { project: board, loop_item: item }
    )
    const port = cloudRuntimePort({ findCloudContextForTask })
    const readIssue = port.findIssueForTask
    if (failure === 'issue read')
      vi.spyOn(port, 'findIssueForTask').mockImplementation(async task => {
        if (!recovered) throw new ApiError('Issue not found', 404)
        return readIssue(task)
      })
    const services = {
      projectSpaceApis: {
        local: {
          findCloudContextForTask: async () => ({
            project: systemProject,
            loop_item: loopItem(systemProject.id),
          }),
        } as DeliveryApi,
      },
      workspaceRuntimePort: port,
    }
    const task = { deviceId: 'retry-device', taskId: `retry-task-${failure}` }
    const { result, unmount } = renderHook(() =>
      useWorkbenchCloudProjectContext({
        active: true,
        currentRuntimeTask: task,
        defaultProjectSpace: null,
        paneKey: `runtime:retry-device:${task.taskId}`,
        runtimeTaskTitle: 'Retry task',
        services,
      })
    )
    try {
      await act(async () =>
        vi.advanceTimersByTimeAsync(51 * 100 + (failure === 'timeout' ? 51 * 5_000 : 0))
      )
      expect(findCloudContextForTask).toHaveBeenCalledTimes(51)
      expect(result.current.boundCloudProject).toBeNull()
      expect(result.current.todoBindingError).toBeTruthy()
      const retry = result.current.projectSpaceContextRetryAction
      expect(retry?.onClick).toBeTypeOf('function')

      recovered = true
      await act(async () => {
        retry?.onClick()
        retry?.onClick()
      })
      expect(findCloudContextForTask).toHaveBeenCalledTimes(52)
      expect(result.current.boundCloudProject?.id).toBe(board.id)
      expect(result.current.boundCloudItem?.id).toBe(item.id)
      expect(result.current.todoBindingError).toBeNull()
      expect(result.current.projectSpaceContextRetryAction).toBeUndefined()

      await act(async () => {
        delayed.resolve({ project: systemProject, loop_item: loopItem(systemProject.id) })
      })
      expect(result.current.boundCloudProject?.id).toBe(board.id)
    } finally {
      unmount()
      delayed.resolve({ project: board, loop_item: item })
      vi.useRealTimers()
    }
  }
)

test.each(['local', 'backend'] as const)(
  'opens the current association while an explicit %s execution can return to its source',
  async projectStore => {
    const execution = { projectId: 'source-project', issueId: 'source-issue' }
    const board = project('latest-board')
    const item = { ...loopItem(board.id), id: 'LATEST-42' }
    const response = Promise.withResolvers<{ project: typeof board; loop_item: CloudLoopItem }>()
    const services = {
      workspaceRuntimePort: cloudRuntimePort({ findCloudContextForTask: () => response.promise }),
    }
    const navigate = vi.spyOn(navigation, 'navigateTo').mockImplementation(() => {})
    try {
      const { result, unmount } = renderHook(() =>
        useWorkbenchCloudProjectContext({
          active: true,
          currentRuntimeTask: {
            deviceId: 'execution-device',
            taskId: `execution-task-${projectStore}`,
            issueExecution: execution,
            ...(projectStore === 'backend' ? { projectSession: execution } : {}),
          },
          defaultProjectSpace: null,
          paneKey: `execution-pane-${projectStore}`,
          runtimeTaskTitle: 'Execution',
          services,
        })
      )
      const sourceRoute = `/todo?projectStore=${projectStore}&projectId=source-project&itemId=source-issue`
      act(() => result.current.openIssueExecutionSource())
      expect(navigate).toHaveBeenLastCalledWith(sourceRoute)
      act(() => result.current.openBoundProjectSpaceTask())
      expect(navigate).toHaveBeenLastCalledWith(sourceRoute)

      await act(async () => response.resolve({ project: board, loop_item: item }))
      expect(result.current.boundCloudItem?.id).toBe(item.id)
      act(() => result.current.openBoundProjectSpaceTask())
      expect(navigate).toHaveBeenLastCalledWith(
        `/todo?projectStore=backend&projectId=${board.id}&itemId=${item.id}`
      )

      act(() => result.current.openIssueExecutionSource())
      expect(navigate).toHaveBeenLastCalledWith(sourceRoute)
      unmount()
    } finally {
      response.resolve({ project: board, loop_item: item })
      navigate.mockRestore()
    }
  }
)

test('completes task association when the board items load during tracking', async () => {
  const board = project('tracking-board')
  const item = loopItem(board.id)
  const items = Promise.withResolvers<{ items: CloudLoopItem[] }>()
  const tracking = Promise.withResolvers<{ item: CloudLoopItem }>()
  const services = {
    deliveryApi: { listLoopItems: () => items.promise } as DeliveryApi,
    workspaceRuntimePort: cloudRuntimePort({ trackProjectTask: () => tracking.promise }),
  }
  const { result } = renderHook(() =>
    useWorkbenchCloudProjectContext({
      active: true,
      currentRuntimeTask: { deviceId: 'tracking-device', taskId: 'tracking-task' },
      defaultProjectSpace: null,
      paneKey: 'runtime:tracking-device:tracking-task',
      runtimeTaskTitle: 'Tracking task',
      services,
      userId: 1,
    })
  )

  act(() => result.current.handleSelectCloudProject(board))
  act(() => result.current.associateRuntimeTaskWithNewItem())
  await act(async () => items.resolve({ items: [item] }))
  expect(result.current.taskBoardAssociation).toMatchObject({ items: [item], pending: true })

  await act(async () => tracking.resolve({ item }))

  expect(result.current.taskBoardAssociation).toBeNull()
  expect(result.current.boundCloudItem?.id).toBe(item.id)
})

test('loads mention candidates once when the same project and issue are resolved again', async () => {
  const task = { deviceId: 'mention-device', taskId: 'mention-task' }
  const board = project('mention-board', 'local')
  let item = loopItem(board.id)
  const listLoopItems = vi.fn(async () => ({ items: [item] }))
  const services = {
    projectSpaceApis: {
      local: {
        listCloudFiles: async () => ({ items: [] }),
        listLoopItems,
        listDeliveries: async () => ({ items: [] }),
        findCloudContextForTask: async () => ({ project: { ...board }, loop_item: { ...item } }),
      } as DeliveryApi,
    },
  }
  const { result } = renderHook(() =>
    useWorkbenchCloudProjectContext({
      active: true,
      currentRuntimeTask: task,
      defaultProjectSpace: null,
      paneKey: 'runtime:mention-device:mention-task',
      runtimeTaskTitle: 'Mention task',
      services,
      userId: 1,
    })
  )
  await waitFor(() =>
    expect(result.current.visibleCloudMentionCandidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: `cloud-todo:${item.id}` })])
    )
  )

  item = { ...item, title: 'Updated issue title' }
  await act(async () =>
    publishProjectSpaceTaskContextChanged({ task, project: projectSpaceRef(board) })
  )
  expect(result.current.boundCloudItem?.title).toBe(item.title)
  expect(listLoopItems).toHaveBeenCalledTimes(1)

  item = { ...item, id: 'todo-2' }
  await act(async () =>
    publishProjectSpaceTaskContextChanged({ task, project: projectSpaceRef(board) })
  )
  expect(result.current.visibleCloudMentionCandidates).toEqual(
    expect.arrayContaining([expect.objectContaining({ key: `cloud-todo:${item.id}` })])
  )
  expect(listLoopItems).toHaveBeenCalledTimes(2)
})
