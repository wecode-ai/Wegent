import { describe, expect, test, vi } from 'vitest'

import type { WorkbenchServices } from './workbenchServices'
import { projectTaskTrackingApi, rememberProjectTaskStore } from './projectTaskTracking'

describe('projectTaskTrackingApi', () => {
  test('routes backend task ownership through the shared cloud runtime port', async () => {
    const updateTrackedTaskStatus = vi.fn().mockResolvedValue(null)
    const services = {
      projectSpaceApis: {
        local: { updateTaskTrackingStatus: vi.fn() },
        defaultLocation: 'cloud',
      },
      workspaceRuntimePort: {
        updateTrackedTaskStatus,
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

    await resolved?.updateTaskTrackingStatus(
      { deviceId: 'local-device', taskId: 'runtime-1' },
      'running'
    )

    expect(updateTrackedTaskStatus).toHaveBeenCalledOnce()
  })

  test('routes local task ownership to the local DeliveryApi', () => {
    const local = { updateTaskTrackingStatus: vi.fn() }
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
    const cloud = { updateTaskTrackingStatus: vi.fn() }
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
    const local = { updateTaskTrackingStatus: vi.fn() }
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
