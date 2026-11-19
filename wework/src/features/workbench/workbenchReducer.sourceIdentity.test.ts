import { expect, test } from 'vitest'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'
import type { WorkbenchState } from '@/types/workbench'
import { getWorkbenchPaneKey } from '@/components/layout/workbenchPaneIdentity'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

const address = { deviceId: 'electron-home', taskId: 'restored-task' }
const registered: DeviceInfo = {
  id: 75,
  device_id: 'app-record-75',
  socket_device_id: address.deviceId,
  runtime_instance_id: 'native-epoch',
  device_type: 'app',
  name: 'Registered desktop',
  status: 'online',
  is_default: false,
}
const cloudWork: RuntimeWorkListResponse = {
  projects: [],
  chats: [
    {
      deviceId: registered.device_id,
      workspacePath: 'D:/repo',
      available: true,
      tasks: [{ taskId: address.taskId, title: 'Restored', workspacePath: 'D:/repo' }],
    },
  ],
  totalTasks: 1,
}

test.each(
  (
    ['runtime_work_refreshed', 'lists_refreshed', 'devices_refreshed', 'bootstrapped'] as const
  ).flatMap(type => ['app', 'local'].map(deviceType => ({ type, deviceType })))
)(
  '$type preserves the native owner despite unverified $deviceType registration',
  ({ type, deviceType }) => {
    const user = { id: 1, user_name: 'Owner', email: 'owner@example.test' }
    const state: WorkbenchState = {
      ...initialWorkbenchState,
      user,
      currentRuntimeTask: address,
      runtimeWork: type === 'devices_refreshed' ? cloudWork : null,
    }
    const devices = [{ ...registered, device_type: deviceType }]
    const action =
      type === 'runtime_work_refreshed'
        ? { type, runtimeWork: cloudWork }
        : type === 'devices_refreshed'
          ? { type, devices }
          : type === 'bootstrapped'
            ? { type, user, projects: [], devices, runtimeWork: cloudWork }
            : { type, projects: [], devices, runtimeWork: cloudWork }
    const refreshed = workbenchReducer(state, action)
    expect(refreshed.currentRuntimeTask).toEqual(address)
    expect(
      getWorkbenchPaneKey({
        currentRuntimeTask: refreshed.currentRuntimeTask,
        currentProject: refreshed.currentProject,
      })
    ).toBe('runtime:electron-home:restored-task')

    const path = 'D:\\repo'
    const hydrated = workbenchReducer(refreshed, {
      type: 'runtime_work_refreshed',
      runtimeWork: {
        ...cloudWork,
        chats: [
          {
            ...cloudWork.chats[0],
            deviceId: address.deviceId,
            workspacePath: path,
            tasks: [{ taskId: address.taskId, title: 'Restored', workspacePath: path }],
          },
        ],
      },
    })
    expect(hydrated.currentRuntimeTask).toEqual({ ...address, workspacePath: path })
  }
)
