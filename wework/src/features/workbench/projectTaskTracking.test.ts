import { describe, expect, test, vi } from 'vitest'

import type { RuntimeTaskLifecycleSnapshot } from './runtimeTaskLifecycle'
import type { WorkbenchServices } from './workbenchServices'
import {
  projectTaskTrackingApi,
  reconcileProjectTaskTrackingStatus,
  rememberProjectTaskStore,
  runtimeTaskTrackingStatus,
} from './projectTaskTracking'

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

  test.each([
    [{ isQueued: true, isRunning: false }, null, 'queued'],
    [{ isQueued: false, isRunning: true }, null, 'running'],
    [{ isQueued: false, isRunning: false }, 'succeeded', 'succeeded'],
    [{ isQueued: false, isRunning: false }, 'failed', 'failed'],
    [{ isQueued: false, isRunning: false }, 'cancelled', 'cancelled'],
  ] as const)(
    'projects lifecycle state through the canonical mapper',
    (derived, outcome, expected) => {
      const lifecycle = {
        derived: {
          ...derived,
        },
        turn: {
          active: false,
          outcome,
        },
        task: null,
      } as RuntimeTaskLifecycleSnapshot

      expect(runtimeTaskTrackingStatus(lifecycle)).toBe(expected)
    }
  )

  test('projects authoritative completed snapshots as succeeded', () => {
    const lifecycle = {
      derived: {
        isQueued: false,
        isRunning: false,
      },
      turn: {
        active: false,
        outcome: null,
      },
      task: {
        running: false,
        completedAt: 1_787_563_200_000,
      },
    } as RuntimeTaskLifecycleSnapshot

    expect(runtimeTaskTrackingStatus(lifecycle)).toBe('succeeded')
  })

  test('persists status and publishes through the single reconciler', async () => {
    const item = { id: 'WORK-1' }
    const updateTaskTrackingStatus = vi.fn().mockResolvedValue(item)
    const services = {
      projectSpaceApis: {
        local: { updateTaskTrackingStatus },
        defaultLocation: 'local',
      },
    } as unknown as WorkbenchServices
    const address = {
      deviceId: 'local-device',
      taskId: 'runtime-1',
    }

    await expect(reconcileProjectTaskTrackingStatus(services, address, 'running')).resolves.toBe(
      item
    )
    expect(updateTaskTrackingStatus).toHaveBeenCalledWith(address, 'running')
  })
})
