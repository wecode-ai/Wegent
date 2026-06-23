import { describe, expect, test, vi } from 'vitest'
import { createRuntimeWorkApi } from './runtimeWork'
import type { HttpClient } from './http'

describe('createRuntimeWorkApi', () => {
  test('deletes a device workspace mapping', async () => {
    const del = vi.fn().mockResolvedValue({ deleted: true })
    const api = createRuntimeWorkApi({ delete: del } as unknown as HttpClient)

    await expect(
      api.deleteDeviceWorkspace({
        projectId: 3,
        deviceId: 'device-1',
        workspacePath: '/repo/Wegent',
      })
    ).resolves.toEqual({ deleted: true })

    expect(del).toHaveBeenCalledWith(
      '/runtime-work/device-workspaces?project_id=3&device_id=device-1&workspace_path=%2Frepo%2FWegent'
    )
  })

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

  test('manages runtime IM notification settings', async () => {
    const get = vi.fn().mockResolvedValue({
      global: {
        enabled: false,
        sessionKey: null,
        session: null,
      },
      runtimeTaskSubscriptions: [],
    })
    const put = vi.fn().mockResolvedValue({
      address: {
        deviceId: 'device-1',
        localTaskId: 'codex-1',
      },
      subscribed: true,
      sessionKeys: ['session-a'],
    })
    const post = vi.fn().mockResolvedValue({
      address: {
        deviceId: 'device-1',
        localTaskId: 'codex-1',
      },
      subscribed: false,
      sessionKeys: [],
    })
    const api = createRuntimeWorkApi({ get, put, post } as unknown as HttpClient)

    await expect(api.getImNotificationSettings()).resolves.toEqual({
      global: {
        enabled: false,
        sessionKey: null,
        session: null,
      },
      runtimeTaskSubscriptions: [],
    })
    await api.updateGlobalImNotification({ enabled: true, sessionKey: 'session-a' })
    await api.subscribeRuntimeTaskNotifications({
      address: {
        deviceId: 'device-1',
        localTaskId: 'codex-1',
      },
      sessionKeys: ['session-a'],
    })
    await api.unsubscribeRuntimeTaskNotifications({
      deviceId: 'device-1',
      localTaskId: 'codex-1',
    })

    expect(get).toHaveBeenCalledWith('/runtime-work/im-notifications')
    expect(put).toHaveBeenNthCalledWith(1, '/runtime-work/im-notifications/global', {
      enabled: true,
      sessionKey: 'session-a',
    })
    expect(put).toHaveBeenNthCalledWith(2, '/runtime-work/im-notifications/runtime-task', {
      address: {
        deviceId: 'device-1',
        localTaskId: 'codex-1',
      },
      sessionKeys: ['session-a'],
    })
    expect(post).toHaveBeenCalledWith('/runtime-work/im-notifications/runtime-task/unsubscribe', {
      deviceId: 'device-1',
      localTaskId: 'codex-1',
    })
  })
})
