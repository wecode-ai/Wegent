import { describe, expect, test } from 'vitest'
import type { RuntimeSupervisorState, RuntimeWorkListResponse } from '@/types/api'
import { RuntimeSupervisorSnapshots } from './runtimeSupervisorSnapshots'

const address = { deviceId: 'cloud-device', taskId: 'task-a', workspacePath: '/workspace' }
const active: RuntimeSupervisorState = {
  mode: 'auto',
  status: 'active',
  instructions: 'Keep the task focused',
  intervalSeconds: 30,
  lastEvaluatedAt: 100,
  suggestions: [],
}

function work(supervisor: RuntimeSupervisorState | null): RuntimeWorkListResponse {
  return {
    projects: [],
    chats: [
      {
        deviceId: address.deviceId,
        deviceName: 'Cloud device',
        workspacePath: address.workspacePath,
        tasks: [
          {
            taskId: address.taskId,
            title: 'Task',
            runtime: 'codex',
            createdAt: 1,
            updatedAt: 1,
            status: 'done',
            supervisor,
          },
        ],
      },
    ],
    totalTasks: 1,
  }
}

describe('RuntimeSupervisorSnapshots', () => {
  test('preserves completed checks across overlapping stale snapshots', () => {
    const snapshots = new RuntimeSupervisorSnapshots()
    const first = snapshots.capture()
    snapshots.update(address, { ...active, status: 'checking' })
    const second = snapshots.capture()
    snapshots.update(address, active)

    for (const revision of [second, first]) {
      expect(
        snapshots.preserve(work({ ...active, status: 'checking' }), revision).chats[0].tasks[0]
          .supervisor
      ).toEqual(active)
    }
  })

  test('allows a later authoritative snapshot to replace earlier events', () => {
    const snapshots = new RuntimeSupervisorSnapshots()
    snapshots.update(address, active)
    const request = snapshots.capture()
    const next = work({ ...active, status: 'checking', lastEvaluatedAt: 200 })

    expect(snapshots.preserve(next, request)).toBe(next)
  })

  test('preserves disabling supervision while a snapshot is pending', () => {
    const snapshots = new RuntimeSupervisorSnapshots()
    const request = snapshots.capture()
    snapshots.update(address, null)

    expect(snapshots.preserve(work(active), request).chats[0].tasks[0].supervisor).toBeNull()
  })

  test('clears events when the account changes', () => {
    const snapshots = new RuntimeSupervisorSnapshots()
    const request = snapshots.capture()
    snapshots.update(address, active)
    snapshots.clear()
    const next = work(null)

    expect(snapshots.preserve(next, request)).toBe(next)
  })
})
