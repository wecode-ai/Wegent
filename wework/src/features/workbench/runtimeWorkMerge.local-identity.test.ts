import { expect, test } from 'vitest'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'
import { qualifyLocalRuntimeWork } from '@/lib/local-runtime-sidebar-identity'
import { getRuntimeWorkbenchPaneKeys } from '@/components/layout/workbenchPaneIdentity'
import { mergeRuntimeWorkLists } from './runtimeWorkMerge'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

test('retains the native task and pane address while cloud registration inventory changes', () => {
  const identity = {
    deviceId: 'electron-home',
    runtimeInstanceId: 'executor-instance',
    provenance: 'local-ipc' as const,
  }
  const address = { deviceId: identity.deviceId, taskId: 'task-1', workspacePath: '/repo' }
  const native = qualifyLocalRuntimeWork(
    {
      projects: [],
      chats: [
        {
          deviceId: identity.deviceId,
          workspacePath: '/repo',
          available: true,
          tasks: [
            { taskId: address.taskId, title: 'Task', runtime: 'codex', workspacePath: '/repo' },
          ],
        },
      ],
      totalTasks: 1,
    },
    identity
  )
  const registration: DeviceInfo = {
    id: 75,
    device_id: 'app-record-75',
    socket_device_id: identity.deviceId,
    runtime_instance_id: identity.runtimeInstanceId,
    device_type: 'app',
    name: 'Registered desktop',
    status: 'online',
    is_default: false,
  }
  const empty: RuntimeWorkListResponse = { projects: [], chats: [], totalTasks: 0 }
  let state: WorkbenchState = { ...initialWorkbenchState, currentRuntimeTask: address }
  for (const devices of [[registration], [], [registration], []]) {
    const runtimeWork = mergeRuntimeWorkLists(native, empty, { devices })
    expect(getRuntimeWorkbenchPaneKeys(runtimeWork)).toEqual(['runtime:electron-home:task-1'])
    state = workbenchReducer(state, { type: 'lists_refreshed', projects: [], devices, runtimeWork })
    expect(state.currentRuntimeTask).toMatchObject(address)
  }
})

test('still canonicalizes unqualified relay addresses through the registered device', () => {
  const work: RuntimeWorkListResponse = {
    projects: [],
    chats: [
      { deviceId: 'relay', workspacePath: '/repo', mapped: true, available: true, tasks: [] },
    ],
    totalTasks: 0,
  }
  const devices: DeviceInfo[] = [
    {
      id: 1,
      device_id: 'registered-device',
      socket_device_id: 'relay',
      runtime_instance_id: 'remote-instance',
      device_type: 'remote',
      name: 'Remote',
      status: 'online',
      is_default: false,
    },
  ]
  expect(mergeRuntimeWorkLists(work, work, { devices }).chats[0].deviceId).toBe('registered-device')
})
