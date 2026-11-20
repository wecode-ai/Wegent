import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { CloudLoopItem } from '@/api/deliveries'
import type { DeliveryApi } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'
import { cloudRuntimePort, loopItem, project } from './workbenchCloudProjectContextTestFixtures'
import { useWorkbenchCloudProjectContext } from './useWorkbenchCloudProjectContext'

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
