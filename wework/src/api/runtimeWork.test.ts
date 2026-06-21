import { describe, expect, test, vi } from 'vitest'
import { createRuntimeWorkApi } from './runtimeWork'
import type { HttpClient } from './http'

describe('createRuntimeWorkApi', () => {
  test('forks a runtime task by runtime addresses', async () => {
    const post = vi.fn().mockResolvedValue({
      accepted: true,
      source: {
        deviceId: 'source-device',
        workspacePath: '/repo/Wegent',
        localTaskId: 'codex-1',
      },
      target: {
        deviceId: 'target-device',
        workspacePath: '/repo/Wegent-copy',
        localTaskId: 'runtime-copy',
      },
      runtime: 'codex',
    })
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)

    await expect(
      api.forkRuntimeTask({
        source: {
          deviceId: 'source-device',
          workspacePath: '/repo/Wegent',
          localTaskId: 'codex-1',
        },
        target: {
          deviceId: 'target-device',
          workspacePath: '/repo/Wegent-copy',
        },
      })
    ).resolves.toEqual({
      accepted: true,
      source: {
        deviceId: 'source-device',
        workspacePath: '/repo/Wegent',
        localTaskId: 'codex-1',
      },
      target: {
        deviceId: 'target-device',
        workspacePath: '/repo/Wegent-copy',
        localTaskId: 'runtime-copy',
      },
      runtime: 'codex',
    })

    expect(post).toHaveBeenCalledWith('/runtime-work/fork', {
      source: {
        deviceId: 'source-device',
        workspacePath: '/repo/Wegent',
        localTaskId: 'codex-1',
      },
      target: {
        deviceId: 'target-device',
        workspacePath: '/repo/Wegent-copy',
      },
    })
  })

  test('binds private IM sessions to a runtime task address', async () => {
    const post = vi.fn().mockResolvedValue({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        localTaskId: 'runtime-1',
      },
      boundSessionKeys: ['session-a', 'session-b'],
      notifiedCount: 2,
    })
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)

    await expect(
      api.bindRuntimeTaskImSessions({
        address: {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          localTaskId: 'runtime-1',
        },
        sessionKeys: ['session-a', 'session-b'],
      })
    ).resolves.toEqual({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        localTaskId: 'runtime-1',
      },
      boundSessionKeys: ['session-a', 'session-b'],
      notifiedCount: 2,
    })

    expect(post).toHaveBeenCalledWith('/runtime-work/im-sessions', {
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        localTaskId: 'runtime-1',
      },
      sessionKeys: ['session-a', 'session-b'],
    })
  })
})
