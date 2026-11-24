import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { CloudLoopItem } from '@/api/deliveries'
import {
  findProjectSpaceContextSourceForTask,
  projectSpaceRef,
  publishProjectSpaceTaskContextChanged,
} from '@/features/todo/projectSpaceSelection'
import type { DeliveryApi } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'
import { cloudRuntimePort, loopItem, project } from './workbenchCloudProjectContextTestFixtures'
import { useWorkbenchCloudProjectContext } from './useWorkbenchCloudProjectContext'

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
