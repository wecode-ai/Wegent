import { describe, expect, test, vi } from 'vitest'
import { createRuntimeWorkApi } from './runtimeWork'
import type { HttpClient } from './http'

describe('createRuntimeWorkApi', () => {
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
