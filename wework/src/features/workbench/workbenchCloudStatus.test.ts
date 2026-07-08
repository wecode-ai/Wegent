import { describe, expect, test } from 'vitest'
import type { DeviceInfo, RuntimeDeviceWorkspace, RuntimeWorkListResponse } from '@/types/api'
import {
  EMPTY_CLOUD_RUNTIME_STATE,
  finishCloudRuntimeSync,
  mergeRuntimeWorkLists,
  selectRuntimeWorkView,
  selectVisibleDevices,
  startCloudRuntimeSync,
} from './workbenchCloudStatus'

function workspace(
  deviceId: string,
  tasks: Array<{ taskId: string; title?: string }> = [{ taskId: 'task-1' }]
): RuntimeDeviceWorkspace {
  return {
    deviceId,
    deviceName: deviceId,
    deviceStatus: 'online',
    available: true,
    mapped: true,
    workspacePath: '/workspace/repo',
    workspaceKind: 'workspace',
    projectId: 7,
    tasks: tasks.map(task => ({
      taskId: task.taskId,
      workspacePath: '/workspace/repo',
      workspaceKind: 'workspace',
      title: task.title ?? task.taskId,
      runtime: 'codex',
    })),
  }
}

function runtimeWork(deviceId: string): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { id: 7, name: 'Repo' },
        deviceWorkspaces: [workspace(deviceId)],
        totalTasks: 1,
      },
    ],
    chats: [],
    totalTasks: 1,
  }
}

describe('mergeRuntimeWorkLists', () => {
  test('is idempotent when the same cloud snapshot is merged repeatedly', () => {
    const localWork = runtimeWork('local-device')
    const cloudWork = runtimeWork('remote-device')

    const once = mergeRuntimeWorkLists(localWork, cloudWork)
    const twice = mergeRuntimeWorkLists(once, cloudWork)

    expect(once.totalTasks).toBe(1)
    expect(twice.totalTasks).toBe(1)
    expect(twice.projects).toHaveLength(1)
    expect(twice.projects[0].deviceWorkspaces).toHaveLength(1)
    expect(twice.projects[0].deviceWorkspaces[0].tasks.map(task => task.taskId)).toEqual(['task-1'])
  })

  test('keeps distinct tasks from different devices in the same project', () => {
    const localWork = {
      ...runtimeWork('local-device'),
      projects: [
        {
          project: { id: 7, name: 'Repo' },
          deviceWorkspaces: [workspace('local-device', [{ taskId: 'task-local' }])],
          totalTasks: 1,
        },
      ],
    }
    const cloudWork = {
      ...runtimeWork('remote-device'),
      projects: [
        {
          project: { id: 7, name: 'Repo' },
          deviceWorkspaces: [workspace('remote-device', [{ taskId: 'task-remote' }])],
          totalTasks: 1,
        },
      ],
    }

    const merged = mergeRuntimeWorkLists(localWork, cloudWork)

    expect(merged.totalTasks).toBe(2)
    expect(merged.projects).toHaveLength(1)
    expect(merged.projects[0].deviceWorkspaces).toHaveLength(2)
    expect(
      merged.projects[0].deviceWorkspaces.flatMap(deviceWorkspace =>
        deviceWorkspace.tasks.map(task => task.taskId)
      )
    ).toEqual(['task-local', 'task-remote'])
  })
})

function device(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'cloud-device',
    name: 'Cloud Device',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
    ...overrides,
  }
}

describe('cloud runtime sync state', () => {
  test('keeps last good devices when a later sync fails', () => {
    const started = startCloudRuntimeSync(EMPTY_CLOUD_RUNTIME_STATE, 'bootstrap', ['devices'])
    const ready = finishCloudRuntimeSync(started, started.inFlightRevision ?? 0, {
      devices: { status: 'fulfilled', value: [device()] },
    })
    const retry = startCloudRuntimeSync(ready, 'manual-refresh', ['devices'])
    const failed = finishCloudRuntimeSync(retry, retry.inFlightRevision ?? 0, {
      devices: { status: 'rejected', reason: new Error('network down') },
    })

    expect(selectVisibleDevices([], failed).map(item => item.device_id)).toEqual(['cloud-device'])
    expect(failed.availability).toBe('partial')
    expect(failed.current?.checks.devices.status).toBe('failed')
  })

  test('drops stale revisions that complete after a newer sync starts', () => {
    const first = startCloudRuntimeSync(EMPTY_CLOUD_RUNTIME_STATE, 'bootstrap', ['devices'])
    const second = startCloudRuntimeSync(first, 'manual-refresh', ['devices'])
    const stale = finishCloudRuntimeSync(second, first.inFlightRevision ?? 0, {
      devices: { status: 'fulfilled', value: [device({ device_id: 'stale-device' })] },
    })

    expect(stale).toBe(second)
    expect(selectVisibleDevices([], stale)).toEqual([])
  })

  test('derives runtime work from last good cloud snapshot without duplicating tasks', () => {
    const started = startCloudRuntimeSync(EMPTY_CLOUD_RUNTIME_STATE, 'bootstrap', ['runtimeWork'])
    const ready = finishCloudRuntimeSync(started, started.inFlightRevision ?? 0, {
      runtimeWork: { status: 'fulfilled', value: runtimeWork('remote-device') },
    })
    const once = selectRuntimeWorkView(runtimeWork('local-device'), ready)
    const twice = selectRuntimeWorkView(once, ready)

    expect(once.totalTasks).toBe(1)
    expect(twice.totalTasks).toBe(1)
  })
})
