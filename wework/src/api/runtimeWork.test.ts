// @vitest-environment node

import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, expect, test, vi } from 'vitest'
import type { HttpClient } from './http'
import { createRuntimeWorkApi } from './runtimeWork'

describe('createRuntimeWorkApi', () => {
  test('lists only the explicitly addressed computer and preserves cancellation', async () => {
    const get = vi.fn().mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
    const api = createRuntimeWorkApi({ get } as unknown as HttpClient)
    const signal = new AbortController().signal
    await api.listRuntimeWork({ deviceId: 'app-record-22', signal })
    expect(get).toHaveBeenCalledExactlyOnceWith('/runtime-work?device_id=app-record-22', { signal })
  })

  test('forwards cancellation separately from the serialized transcript request', async () => {
    const controller = new AbortController()
    const post = vi.fn().mockResolvedValue({ messages: [], turns: [] })
    const api = createRuntimeWorkApi({ post } as unknown as HttpClient)
    const request = { deviceId: 'cloud-device', taskId: 'task-1' }
    await api.getRuntimeTranscript(request, { signal: controller.signal })
    expect(post).toHaveBeenCalledExactlyOnceWith(
      '/runtime-work/transcript',
      {
        ...request,
        transcriptProtocolVersion: 2,
      },
      { signal: controller.signal }
    )
  })
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
})
