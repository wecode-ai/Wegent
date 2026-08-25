import { describe, expect, test, vi } from 'vitest'

import type { WorkbenchServices } from './workbenchServices'
import { projectTaskTrackingApi, rememberProjectTaskStore } from './projectTaskTracking'

describe('projectTaskTrackingApi', () => {
  test.each([
    ['backend', 'cloud'],
    ['local', 'local'],
  ] as const)('routes %s task ownership to the %s API', (projectStore, expectedLocation) => {
    const local = { updateTaskTrackingStatus: vi.fn() }
    const cloud = { updateTaskTrackingStatus: vi.fn() }
    const services = {
      projectSpaceApis: {
        local,
        cloud,
        defaultLocation: 'cloud',
      },
    } as unknown as WorkbenchServices

    const resolved = projectTaskTrackingApi(services, {
      deviceId: 'local-device',
      taskId: 'runtime-1',
      runtimeHandle: {
        origin: {
          projectStore,
        },
      },
    })

    expect(resolved).toBe(expectedLocation === 'cloud' ? cloud : local)
  })

  test('routes a task through the store recorded by its completed binding', () => {
    const local = { updateTaskTrackingStatus: vi.fn() }
    const cloud = { updateTaskTrackingStatus: vi.fn() }
    const services = {
      projectSpaceApis: {
        local,
        cloud,
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
