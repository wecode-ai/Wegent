import { describe, expect, it, vi } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/runtime'
import { runtimeTaskRunning } from './mobileRuntimeHelpers'

vi.mock('expo-crypto', () => ({ randomUUID: () => 'random-id' }))

const address = { deviceId: 'device', taskId: 'second-task', runtime: 'codex' as const }
const work: RuntimeWorkListResponse = {
  projects: [],
  totalTasks: 2,
  chats: [
    {
      deviceId: 'device',
      deviceName: 'Device',
      deviceStatus: 'online',
      available: true,
      workspacePath: '/first',
      tasks: [
        {
          taskId: 'first-task',
          title: 'First',
          runtime: 'codex',
          workspacePath: '/first',
          running: false,
        },
      ],
    },
    {
      deviceId: 'device',
      deviceName: 'Device',
      deviceStatus: 'online',
      available: true,
      workspacePath: '/second',
      tasks: [
        {
          taskId: 'second-task',
          title: 'Second',
          runtime: 'codex',
          workspacePath: '/second',
          running: true,
        },
      ],
    },
  ],
}

describe('runtime task running state', () => {
  it('finds a task in a later workspace on the addressed device', () => {
    expect(runtimeTaskRunning(address, work, new Map())).toBe(true)
  })

  it('keeps an explicit running override authoritative', () => {
    expect(
      runtimeTaskRunning(
        address,
        work,
        new Map([[JSON.stringify(['device', 'second-task']), false]])
      )
    ).toBe(false)
  })
})
