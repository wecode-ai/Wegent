import { describe, expect, test, vi } from 'vitest'
import { createRuntimeWorkApi } from './runtimeWork'
import type { HttpClient } from './http'

describe('createRuntimeWorkApi', () => {
  test('lists runtime work without client origin query', async () => {
    const get = vi.fn().mockResolvedValue({
      projects: [],
      chats: [],
      totalLocalTasks: 0,
    })
    const api = createRuntimeWorkApi({ get } as unknown as HttpClient)

    await expect(api.listRuntimeWork()).resolves.toEqual({
      projects: [],
      chats: [],
      totalLocalTasks: 0,
    })

    expect(get).toHaveBeenCalledWith('/runtime-work')
  })

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

  test('cancels a runtime task by address', async () => {
    const post = vi.fn().mockResolvedValue({
      accepted: true,
      localTaskId: 'codex-1',
      workspacePath: '/repo/Wegent',
    })
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)

    await expect(
      api.cancelRuntimeTask({
        deviceId: 'device-1',
        workspacePath: '/repo/Wegent',
        localTaskId: 'codex-1',
      })
    ).resolves.toEqual({
      accepted: true,
      localTaskId: 'codex-1',
      workspacePath: '/repo/Wegent',
    })

    expect(post).toHaveBeenCalledWith('/runtime-work/cancel', {
      deviceId: 'device-1',
      workspacePath: '/repo/Wegent',
      localTaskId: 'codex-1',
    })
  })

  test('searches runtime work transcripts', async () => {
    const post = vi.fn().mockResolvedValue({
      items: [
        {
          address: {
            deviceId: 'device-1',
            workspacePath: '/repo/Wegent',
            localTaskId: 'codex-1',
          },
          runtime: 'codex',
          title: '执行 pwd',
          snippet: '执行 pwd',
          matchStart: 3,
          matchEnd: 6,
          messageId: 'm1',
          messageRole: 'user',
          messageCreatedAt: '2026-06-21T12:00:00Z',
          updatedAt: '2026-06-21T12:00:01Z',
          deviceName: 'MacBook',
          workspacePath: '/repo/Wegent',
          project: { id: 1, name: 'Wegent' },
        },
      ],
    })
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)

    await expect(api.searchRuntimeWork({ query: 'pwd', limit: 20 })).resolves.toEqual({
      items: [
        expect.objectContaining({
          title: '执行 pwd',
          snippet: '执行 pwd',
        }),
      ],
    })

    expect(post).toHaveBeenCalledWith('/runtime-work/search', {
      query: 'pwd',
      limit: 20,
    })
  })

  test('opens a runtime workspace without creating a task', async () => {
    const post = vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      workspacePath: '/Users/crystal/Documents/hello-0',
      runtime: 'codex',
    })
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)

    await expect(
      api.openRuntimeWorkspace({
        deviceId: 'device-1',
        workspacePath: '/Users/crystal/Documents/hello-0',
        runtime: 'codex',
        label: 'Hello project',
      })
    ).resolves.toEqual({
      accepted: true,
      deviceId: 'device-1',
      workspacePath: '/Users/crystal/Documents/hello-0',
      runtime: 'codex',
    })

    expect(post).toHaveBeenCalledWith('/runtime-work/workspaces/open', {
      deviceId: 'device-1',
      workspacePath: '/Users/crystal/Documents/hello-0',
      runtime: 'codex',
      label: 'Hello project',
    })
  })

  test('renames a runtime workspace project', async () => {
    const post = vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      workspacePath: '/Users/crystal/Documents/hello-0',
      runtime: 'codex',
    })
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)

    await expect(
      api.renameRuntimeWorkspace({
        deviceId: 'device-1',
        workspacePath: '/Users/crystal/Documents/hello-0',
        runtime: 'codex',
        name: 'Hello project',
      })
    ).resolves.toEqual({
      accepted: true,
      deviceId: 'device-1',
      workspacePath: '/Users/crystal/Documents/hello-0',
      runtime: 'codex',
    })

    expect(post).toHaveBeenCalledWith('/runtime-work/workspaces/rename', {
      deviceId: 'device-1',
      workspacePath: '/Users/crystal/Documents/hello-0',
      runtime: 'codex',
      name: 'Hello project',
    })
  })

  test('removes a runtime workspace project', async () => {
    const post = vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
      workspacePath: '/Users/crystal/Documents/hello-0',
      runtime: 'codex',
    })
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)

    await expect(
      api.removeRuntimeWorkspace({
        deviceId: 'device-1',
        workspacePath: '/Users/crystal/Documents/hello-0',
        runtime: 'codex',
      })
    ).resolves.toEqual({
      accepted: true,
      deviceId: 'device-1',
      workspacePath: '/Users/crystal/Documents/hello-0',
      runtime: 'codex',
    })

    expect(post).toHaveBeenCalledWith('/runtime-work/workspaces/remove', {
      deviceId: 'device-1',
      workspacePath: '/Users/crystal/Documents/hello-0',
      runtime: 'codex',
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
