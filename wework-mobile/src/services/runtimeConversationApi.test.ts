import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeApi } from './runtimeApi'

const config = {
  apiBaseUrl: 'https://example.com/api',
  backendUrl: 'https://example.com',
  socketBaseUrl: 'https://example.com',
  socketPath: '/socket.io',
  accessToken: 'test-token',
}
const address = {
  deviceId: 'cloud-owner',
  taskId: 'task-1',
  runtime: 'codex',
  workspacePath: '/worktrees/task-1/repo',
  workspaceKind: 'worktree',
  worktreeId: 'tree-1',
}
afterEach(() => vi.unstubAllGlobals())

describe('Mobile conversation mutations follow PC backend-relay contracts', () => {
  it('pins by owning device and thread identity, preserving optional order', async () => {
    const result = { accepted: true, deviceId: address.deviceId, error: null }
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)))
    vi.stubGlobal('fetch', fetch)
    const input = {
      deviceId: address.deviceId,
      threadId: 'thread-1',
      pinned: true,
      beforeThreadId: 'thread-2',
    }
    await expect(new RuntimeApi(config).setRuntimeTaskPinned(input)).resolves.toEqual(result)
    expect(fetch.mock.calls[0]![0]).toBe(`${config.apiBaseUrl}/runtime-work/sidebar/tasks/pin`)
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(input)
  })

  it('renames the addressed cloud conversation without dropping workspace metadata', async () => {
    const result = { accepted: true, taskId: address.taskId, workspacePath: address.workspacePath }
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)))
    vi.stubGlobal('fetch', fetch)
    await expect(
      new RuntimeApi(config).renameRuntimeTask({ address, title: 'New title' })
    ).resolves.toEqual(result)
    expect(fetch.mock.calls[0]![0]).toBe(`${config.apiBaseUrl}/runtime-work/rename`)
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ address, title: 'New title' })
  })

  it('archives the conversation through the archive catalog without invoking runtime task deletion', async () => {
    const result = { accepted: true, taskId: address.taskId, workspacePath: address.workspacePath }
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)))
    vi.stubGlobal('fetch', fetch)
    await expect(new RuntimeApi(config).archiveConversation(address)).resolves.toEqual(result)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `${config.apiBaseUrl}/runtime-work/archived-conversations/archive`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify(address) })
    )
  })

  it('preserves rejected business outcomes for the caller and never retries failed mutations', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ accepted: false, deviceId: address.deviceId, error: 'Read only' })
        )
      )
      .mockResolvedValueOnce(new Response('{"detail":"Device unavailable"}', { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    const api = new RuntimeApi(config)
    await expect(
      api.setRuntimeTaskPinned({ deviceId: address.deviceId, threadId: 'thread-1', pinned: false })
    ).resolves.toEqual({ accepted: false, deviceId: address.deviceId, error: 'Read only' })
    await expect(api.archiveConversation(address)).rejects.toThrow('Device unavailable')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
