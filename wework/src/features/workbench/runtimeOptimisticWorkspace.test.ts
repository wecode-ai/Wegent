import { expect, test } from 'vitest'
import type { DeviceInfo, RuntimeDeviceWorkspace, RuntimeWorkListResponse } from '@/types/api'
import {
  getLocalRuntimeSourceIdentity,
  qualifyLocalRuntimeSource,
} from '@/lib/local-runtime-sidebar-identity'
import { getRuntimeWorkbenchPaneKeys } from '@/components/layout/workbenchPaneIdentity'
import { buildOptimisticRuntimeWorkspace } from './runtimeOptimisticWorkspace'
import { mergeRuntimeWorkLists } from './runtimeWorkMerge'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

const identity = {
  deviceId: 'electron-home',
  runtimeInstanceId: 'native-epoch',
  provenance: 'local-ipc' as const,
}
const local: DeviceInfo = qualifyLocalRuntimeSource(
  {
    id: 0,
    device_id: identity.deviceId,
    device_type: 'local',
    runtime_instance_id: identity.runtimeInstanceId,
    name: 'Native',
    status: 'online',
    is_default: true,
  },
  identity
)
const registration: DeviceInfo = {
  id: 75,
  device_id: 'app-record-75',
  socket_device_id: identity.deviceId,
  runtime_instance_id: identity.runtimeInstanceId,
  device_type: 'app',
  name: 'Registered',
  status: 'online',
  is_default: false,
}
const address = { deviceId: identity.deviceId, taskId: 'created-task', workspacePath: 'D:/repo' }
const empty: RuntimeWorkListResponse = { projects: [], chats: [], totalTasks: 0 }
const build = (devices: DeviceInfo[], baseWorkspace?: RuntimeDeviceWorkspace) =>
  buildOptimisticRuntimeWorkspace({
    devices,
    baseWorkspace,
    deviceId: address.deviceId,
    workspacePath: address.workspacePath,
    projectId: null,
  })

test('a newly created native chat retains its pane while cloud inventory refreshes', () => {
  const created = workbenchReducer(
    { ...initialWorkbenchState, currentRuntimeTask: address },
    {
      type: 'runtime_task_optimistic_upserted',
      project: null,
      workspace: build([local, registration]),
      task: {
        taskId: address.taskId,
        title: 'Created',
        runtime: 'codex',
        optimistic: true,
        workspacePath: address.workspacePath,
        status: 'running',
      },
    }
  )
  for (const devices of [[registration], [], [registration]]) {
    const view = mergeRuntimeWorkLists(created.runtimeWork!, empty, { devices })
    expect(getRuntimeWorkbenchPaneKeys(view)).toEqual(['runtime:electron-home:created-task'])
  }
  expect(getLocalRuntimeSourceIdentity(created.runtimeWork!.chats[0])).toEqual(identity)
})

test('serialized cloud inventory cannot grant native provenance to optimistic work', () => {
  const serialized = JSON.parse(JSON.stringify(local)) as DeviceInfo
  expect(getLocalRuntimeSourceIdentity(build([serialized, registration]))).toBeUndefined()
})

test.each([{ remoteHostId: 'remote' }, { workspaceSource: 'remote' as const }])(
  'remote workspace metadata does not acquire native provenance: %j',
  metadata => {
    expect(
      getLocalRuntimeSourceIdentity(
        build([local], { ...address, ...metadata, available: true, tasks: [] })
      )
    ).toBeUndefined()
  }
)
