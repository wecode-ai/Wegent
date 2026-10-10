import { describe, expect, test, vi } from 'vitest'
import type { WeworkWorkspaceRuntimePort } from '@wegent/collaboration'

import type { WorkbenchServices } from './workbenchServices'
import {
  createCloudProjectTaskRuntimeApi,
  projectTaskTrackingApi,
  rememberProjectTaskStore,
} from './projectTaskTracking'

describe('projectTaskTrackingApi', () => {
  test('preserves the assigned Team through the cloud runtime binding port', async () => {
    const bindTask = vi.fn().mockResolvedValue(undefined)
    const api = createCloudProjectTaskRuntimeApi({
      bindTask,
    } as unknown as WeworkWorkspaceRuntimePort)
    await api.bindTask(
      'ISSUE-1',
      {
        deviceId: 'local-device',
        taskId: 'runtime-team',
        runtimeHandle: { wegentTeam: { id: 1880 } },
      },
      'Team task'
    )
    expect(bindTask).toHaveBeenCalledWith(
      'ISSUE-1',
      {
        deviceId: 'local-device',
        taskId: 'runtime-team',
        wegentTeamId: 1880,
      },
      'Team task'
    )
  })
  test('maps the runtime model identity into the shared task binding and tracking contract', async () => {
    const bindTask = vi.fn().mockResolvedValue(undefined)
    const trackProjectTask = vi.fn().mockResolvedValue({ issue: {} })
    const port = { bindTask, trackProjectTask } as unknown as WeworkWorkspaceRuntimePort
    const api = createCloudProjectTaskRuntimeApi(port)
    const modelSelection = {
      modelName: 'deepseek-v4-pro-responses',
      modelType: 'public' as const,
      options: { reasoning: 'high' },
    }
    const task = {
      deviceId: 'remote-device',
      taskId: 'runtime-model-task',
      runtimeHandle: { modelSelection },
    }
    const sharedTask = {
      deviceId: task.deviceId,
      taskId: task.taskId,
      modelSelection,
    }

    await api.bindTask('ISSUE-1', task, 'Task')
    await api.trackProjectTask('project-1', task, 'Task', 'Description')

    expect(bindTask).toHaveBeenCalledWith('ISSUE-1', sharedTask, 'Task')
    expect(trackProjectTask).toHaveBeenCalledWith('project-1', sharedTask, 'Task', 'Description')
  })

  test('routes backend task ownership through the shared cloud runtime port', async () => {
    const updateTrackedTaskTitle = vi.fn().mockResolvedValue(null)
    const services = {
      projectSpaceApis: {
        local: { updateTaskTrackingTitle: vi.fn() },
        defaultLocation: 'cloud',
      },
      workspaceRuntimePort: {
        updateTrackedTaskTitle,
      },
    } as unknown as WorkbenchServices

    const resolved = projectTaskTrackingApi(services, {
      deviceId: 'local-device',
      taskId: 'runtime-1',
      runtimeHandle: {
        origin: {
          projectStore: 'backend',
        },
      },
    })

    await resolved?.updateTaskTrackingTitle(
      { deviceId: 'local-device', taskId: 'runtime-1' },
      'Renamed task'
    )

    expect(updateTrackedTaskTitle).toHaveBeenCalledOnce()
  })

  test('routes local task ownership to the local DeliveryApi', () => {
    const local = { updateTaskTrackingTitle: vi.fn() }
    const services = {
      projectSpaceApis: {
        local,
        defaultLocation: 'cloud',
      },
    } as unknown as WorkbenchServices

    const resolved = projectTaskTrackingApi(services, {
      deviceId: 'local-device',
      taskId: 'runtime-1',
      runtimeHandle: {
        origin: {
          projectStore: 'local',
        },
      },
    })

    expect(resolved).toBe(local)
  })

  test('does not fall back to the cloud legacy DeliveryApi', () => {
    const cloud = { updateTaskTrackingTitle: vi.fn() }
    const services = {
      projectSpaceApis: {
        cloud,
        defaultLocation: 'cloud',
      },
      deliveryApi: cloud,
    } as unknown as WorkbenchServices

    expect(
      projectTaskTrackingApi(services, {
        deviceId: 'local-device',
        taskId: 'runtime-cloud',
        runtimeHandle: { projectStore: 'backend' },
      })
    ).toBeNull()
  })

  test('routes a task through the store recorded by its completed binding', () => {
    const local = { updateTaskTrackingTitle: vi.fn() }
    const services = {
      projectSpaceApis: {
        local,
        defaultLocation: 'cloud',
      },
    } as unknown as WorkbenchServices
    const address = {
      deviceId: 'local-device',
      taskId: 'runtime-bound-locally',
    }

    rememberProjectTaskStore(address, 'local')

    expect(projectTaskTrackingApi(services, address)).toBe(local)
  })
})
