import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, expect, test, vi } from 'vitest'
import { createRuntimeWorkApi } from './runtimeWork'
import type { HttpClient } from './http'

describe('createRuntimeWorkApi', () => {
  test('assembles canonical HTTP history while preserving project scope on every chunk', async () => {
    const content = Array.from({ length: 18_000 }, (_, index) =>
      createHash('sha256').update(String(index)).digest('hex')
    ).join('')
    const transcript = {
      taskId: 'task-1',
      runtime: 'codex',
      workspacePath: '/repo',
      messages: [],
      turns: [{ id: 'turn-1', items: [{ id: 'text-1', type: 'assistant_text', content }] }],
      beforeCursor: 'older',
      hasMoreBefore: true,
    }
    const bytes = gzipSync(JSON.stringify({ transcript, strings: [], references: [] }))
    const snapshotId = createHash('sha256').update(bytes).digest('hex')
    const chunkSize = 360 * 1024
    expect(bytes.length).toBeGreaterThan(chunkSize)
    const post = vi.fn(
      async (_path: string, query: { transcriptTransfer?: { offset: number } }) => {
        const offset = query.transcriptTransfer?.offset ?? 0
        const end = Math.min(offset + chunkSize, bytes.length)
        return {
          success: true,
          transcriptProtocolVersion: 2,
          transfer: {
            snapshotId,
            encoding: 'gzip+base64+json',
            offset,
            nextOffset: end < bytes.length ? end : null,
            totalBytes: bytes.length,
            payload: bytes.subarray(offset, end).toString('base64'),
          },
        }
      }
    )
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)
    const request = {
      deviceId: 'cloud-device',
      taskId: 'task-1',
      projectSession: { projectId: 'project-1', issueId: 'issue-1' },
      beforeCursor: 'search-match',
      limit: 5,
      refresh: true,
      navigationOnly: false,
    }

    await expect(api.getRuntimeTranscript(request)).resolves.toEqual(transcript)

    const chunkCount = Math.ceil(bytes.length / chunkSize)
    expect(post).toHaveBeenCalledTimes(chunkCount)
    for (let index = 0; index < chunkCount; index++) {
      expect(post).toHaveBeenNthCalledWith(index + 1, '/runtime-work/transcript', {
        ...request,
        transcriptProtocolVersion: 2,
        ...(index > 0 ? { transcriptTransfer: { snapshotId, offset: index * chunkSize } } : {}),
      })
    }
  })

  test('preserves unversioned HTTP transcript responses from older executors', async () => {
    const transcript = { messages: [], turns: [] }
    const post = vi.fn().mockResolvedValue(transcript)
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)

    await expect(
      api.getRuntimeTranscript({ deviceId: 'cloud-device', taskId: 'task-1' })
    ).resolves.toBe(transcript)
    expect(post).toHaveBeenCalledExactlyOnceWith('/runtime-work/transcript', {
      deviceId: 'cloud-device',
      taskId: 'task-1',
      transcriptProtocolVersion: 2,
    })
  })

  test('never sends qualified local sidebar mutations through the backend transport', async () => {
    const post = vi.fn()
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)
    const options = {
      localSidebarIdentity: {
        deviceId: 'electron',
        runtimeInstanceId: 'runtime',
        provenance: 'local-ipc' as const,
      },
    }
    await expect(
      Promise.resolve().then(() =>
        api.syncRuntimeRemoteProjects({ deviceId: 'electron', projects: [] }, options)
      )
    ).rejects.toThrow('local-sidebar-ipc-required')
    await expect(
      Promise.resolve().then(() =>
        api.activateRuntimeProject(
          { deviceId: 'electron', projectKey: 'key', workspacePath: '/repo' },
          options
        )
      )
    ).rejects.toThrow('local-sidebar-ipc-required')
    expect(post).not.toHaveBeenCalled()
  })
  test('waits for the delivery fence and never posts if it is rejected', async () => {
    const post = vi.fn().mockResolvedValue({ accepted: true })
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)
    const request = { runtime: 'codex' as const, message: 'run' }
    const beforeDispatch = vi.fn(async () => {
      expect(post).not.toHaveBeenCalled()
      throw new Error('Execution is no longer dispatchable')
    })
    await expect(api.createRuntimeTask(request, beforeDispatch)).rejects.toThrow(
      'no longer dispatchable'
    )
    expect(beforeDispatch).toHaveBeenCalledOnce()
    expect(post).not.toHaveBeenCalled()
    await api.createRuntimeTask(request, async () => {
      expect(post).not.toHaveBeenCalled()
    })
    expect(post).toHaveBeenCalledOnce()
  })
  test('loads the addressed board goal through the shared runtime API', async () => {
    const response = { accepted: true, taskId: 'task-1', goal: null }
    const post = vi.fn().mockResolvedValue(response)
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)
    const request = { address: { deviceId: 'device-1', taskId: 'task-1' } }

    await expect(api.getRuntimeGoal(request)).resolves.toEqual(response)
    expect(post).toHaveBeenCalledWith('/runtime-work/goal/get', request)
  })
  test('uses the canonical create endpoint for Team execution', async () => {
    const post = vi.fn().mockResolvedValue({ accepted: true })
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)
    const request = {
      schemaVersion: 3 as const,
      wegentTeamId: 42,
      deviceId: 'cloud-device-1',
      workspacePath: '/repo',
      runtime: 'codex' as const,
      message: 'run with team',
    }

    await api.createRuntimeTask(request)

    expect(post).toHaveBeenCalledWith('/runtime-work/create', request)
  })

  test('materializes a Team request without dispatching it', async () => {
    const response = {
      payload: {
        schemaVersion: 2,
        runtime: 'codex',
        message: 'continue',
        title: 'continue',
        executionRequest: { team_id: 42 },
      },
      runtimeHandle: { wegentTeam: { id: 42 } },
    }
    const post = vi.fn().mockResolvedValue(response)
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)
    const request = {
      schemaVersion: 3 as const,
      wegentTeamId: 42,
      newSession: false,
      deviceId: 'local-device-1',
      workspacePath: '/repo',
      taskId: 'task-1',
      runtime: 'codex' as const,
      message: 'continue',
    }

    await expect(api.materializeRuntimeTask(request)).resolves.toEqual(response)
    expect(post).toHaveBeenCalledWith('/runtime-work/materialize', request)
  })

  test('lists runtime work without client origin query', async () => {
    const get = vi.fn().mockResolvedValue({
      projects: [],
      chats: [],
      totalTasks: 0,
    })
    const api = createRuntimeWorkApi({ get } as unknown as HttpClient)

    await expect(api.listRuntimeWork()).resolves.toEqual({
      projects: [],
      chats: [],
      totalTasks: 0,
    })

    expect(get).toHaveBeenCalledWith('/runtime-work')
  })

  test('searches paths in a device runtime workspace', async () => {
    const post = vi.fn().mockResolvedValue({ files: [] })
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)
    const request = {
      deviceId: 'device-1',
      root: '/repo/Wegent',
      query: 'auth',
      cancellationToken: 'composer-1',
    }

    await expect(api.searchRuntimeWorkspace(request)).resolves.toEqual({ files: [] })

    expect(post).toHaveBeenCalledWith('/runtime-work/workspace/search', request)
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

  test('reads Worktree capabilities for a target device', async () => {
    const response = {
      success: true,
      deviceId: 'device-1',
      runtimeWorktrees: {
        version: 1,
        managed: true,
        deferredPrepare: true,
        snapshots: true,
        restore: true,
        preflight: true,
      },
    }
    const post = vi.fn().mockResolvedValue(response)
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)

    await expect(api.getWorktreeCapabilities({ deviceId: 'device-1' })).resolves.toEqual(response)

    expect(post).toHaveBeenCalledWith('/runtime-work/worktrees/capabilities', {
      deviceId: 'device-1',
    })
  })

  test('preflights a Worktree source path on a target device', async () => {
    const response = {
      success: true,
      deviceId: 'device-1',
      supported: true,
      sourcePath: '/repo/Wegent',
      sourceExists: true,
      sourceDirectory: true,
      gitRepository: true,
      gitCommonDirValid: true,
      gitCommonDirWritable: true,
      writable: true,
      repoRoot: '/repo/Wegent',
      repoRootFingerprint: 'repo-fingerprint',
      resolvedWorktreeRoot: '/runtime/worktrees',
    }
    const post = vi.fn().mockResolvedValue(response)
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)

    await expect(
      api.preflightWorktree({
        deviceId: 'device-1',
        sourcePath: '/repo/Wegent',
      })
    ).resolves.toEqual(response)

    expect(post).toHaveBeenCalledWith('/runtime-work/worktrees/preflight', {
      deviceId: 'device-1',
      sourcePath: '/repo/Wegent',
    })
  })

  test('forks a runtime task by runtime addresses', async () => {
    const post = vi.fn().mockResolvedValue({
      accepted: true,
      source: {
        deviceId: 'source-device',
        workspacePath: '/repo/Wegent',
        taskId: 'codex-1',
      },
      target: {
        deviceId: 'target-device',
        workspacePath: '/repo/Wegent-copy',
        taskId: 'runtime-copy',
      },
      runtime: 'codex',
    })
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)

    await expect(
      api.forkRuntimeTask({
        source: {
          deviceId: 'source-device',
          workspacePath: '/repo/Wegent',
          taskId: 'codex-1',
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
        taskId: 'codex-1',
      },
      target: {
        deviceId: 'target-device',
        workspacePath: '/repo/Wegent-copy',
        taskId: 'runtime-copy',
      },
      runtime: 'codex',
    })

    expect(post).toHaveBeenCalledWith('/runtime-work/fork', {
      source: {
        deviceId: 'source-device',
        workspacePath: '/repo/Wegent',
        taskId: 'codex-1',
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
      taskId: 'codex-1',
      workspacePath: '/repo/Wegent',
    })
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)

    await expect(
      api.cancelRuntimeTask({
        deviceId: 'device-1',
        workspacePath: '/repo/Wegent',
        taskId: 'codex-1',
      })
    ).resolves.toEqual({
      accepted: true,
      taskId: 'codex-1',
      workspacePath: '/repo/Wegent',
    })

    expect(post).toHaveBeenCalledWith('/runtime-work/cancel', {
      deviceId: 'device-1',
      workspacePath: '/repo/Wegent',
      taskId: 'codex-1',
    })
  })

  test('searches runtime work transcripts', async () => {
    const post = vi.fn().mockResolvedValue({
      items: [
        {
          address: {
            deviceId: 'device-1',
            workspacePath: '/repo/Wegent',
            taskId: 'codex-1',
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

  test('starts a supervisor review immediately', async () => {
    const response = {
      accepted: true,
      taskId: 'codex-1',
      supervisor: {
        mode: 'auto' as const,
        status: 'active' as const,
        instructions: '',
        suggestions: [],
      },
    }
    const post = vi.fn().mockResolvedValue(response)
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)
    const request = {
      address: {
        deviceId: 'device-1',
        taskId: 'codex-1',
      },
    }

    await expect(api.runRuntimeSupervisorNow(request)).resolves.toEqual(response)

    expect(post).toHaveBeenCalledWith('/runtime-work/supervisor/run-now', request)
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
        taskId: 'runtime-1',
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
          taskId: 'runtime-1',
        },
        taskTitle: '修复 IM 通知标题',
        sessionKeys: ['session-a', 'session-b'],
        modelSelection: {
          modelName: 'gpt-5.6-luna',
          modelType: 'public',
          options: { reasoningEffort: 'low' },
        },
      })
    ).resolves.toEqual({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-1',
      },
      boundSessionKeys: ['session-a', 'session-b'],
      notifiedCount: 2,
    })

    expect(post).toHaveBeenCalledWith('/runtime-work/im-sessions', {
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-1',
      },
      taskTitle: '修复 IM 通知标题',
      sessionKeys: ['session-a', 'session-b'],
      modelSelection: {
        modelName: 'gpt-5.6-luna',
        modelType: 'public',
        options: { reasoningEffort: 'low' },
      },
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
        taskId: 'codex-1',
      },
      subscribed: true,
      sessionKeys: ['session-a'],
    })
    const post = vi.fn().mockResolvedValue({
      address: {
        deviceId: 'device-1',
        taskId: 'codex-1',
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
    await api.updateImNotificationPresence({ clientId: 'desktop-client-1', away: false })
    await api.subscribeRuntimeTaskNotifications({
      address: {
        deviceId: 'device-1',
        taskId: 'codex-1',
      },
      sessionKeys: ['session-a'],
    })
    await api.unsubscribeRuntimeTaskNotifications({
      deviceId: 'device-1',
      taskId: 'codex-1',
    })

    expect(get).toHaveBeenCalledWith('/runtime-work/im-notifications')
    expect(put).toHaveBeenNthCalledWith(1, '/runtime-work/im-notifications/global', {
      enabled: true,
      sessionKey: 'session-a',
    })
    expect(put).toHaveBeenNthCalledWith(2, '/runtime-work/im-notifications/presence', {
      clientId: 'desktop-client-1',
      away: false,
    })
    expect(put).toHaveBeenNthCalledWith(3, '/runtime-work/im-notifications/runtime-task', {
      address: {
        deviceId: 'device-1',
        taskId: 'codex-1',
      },
      sessionKeys: ['session-a'],
    })
    expect(post).toHaveBeenCalledWith('/runtime-work/im-notifications/runtime-task/unsubscribe', {
      deviceId: 'device-1',
      taskId: 'codex-1',
    })
  })
})
