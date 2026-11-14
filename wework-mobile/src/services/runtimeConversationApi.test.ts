import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const request = vi.fn()
const fetch = vi.fn()
const runtime = { executeCommand: vi.fn(), request }
const api = () => new RuntimeApi(config, undefined, undefined, runtime)

beforeEach(() => {
  request.mockReset()
  fetch.mockReset()
  vi.stubGlobal('fetch', fetch)
})
afterEach(() => vi.unstubAllGlobals())

describe('Mobile conversation mutations follow PC cloud Runtime contracts', () => {
  it('pins by the owning device and thread identity, preserving optional order', async () => {
    const result = { accepted: true, deviceId: address.deviceId, error: null }
    request.mockResolvedValue(result)
    const input = {
      deviceId: address.deviceId,
      threadId: 'thread-1',
      pinned: true,
      beforeThreadId: 'thread-2',
    }
    await expect(api().setRuntimeTaskPinned(input)).resolves.toEqual(result)
    expect(request).toHaveBeenCalledExactlyOnceWith(
      'runtime.sidebar.tasks.pin',
      input,
      address.deviceId
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('renames the addressed cloud conversation without dropping workspace metadata', async () => {
    const result = { accepted: true, taskId: address.taskId, workspacePath: address.workspacePath }
    request.mockResolvedValue(result)
    const input = { address, title: 'New title' }
    await expect(api().renameRuntimeTask(input)).resolves.toEqual(result)
    expect(request).toHaveBeenCalledExactlyOnceWith('runtime.tasks.rename', input, address.deviceId)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('archives through the same Runtime operation used by the PC cloud archive catalog', async () => {
    const result = { accepted: true, taskId: address.taskId, workspacePath: address.workspacePath }
    request.mockResolvedValue(result)
    await expect(api().archiveConversation(address)).resolves.toEqual(result)
    expect(request).toHaveBeenCalledExactlyOnceWith(
      'runtime.tasks.archive',
      address,
      address.deviceId
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves business rejection and transport errors without repeating a mutation', async () => {
    const rejected = { accepted: false, deviceId: address.deviceId, error: 'Read only' }
    request.mockResolvedValueOnce(rejected).mockRejectedValueOnce(new Error('Device unavailable'))
    const client = api()
    await expect(
      client.setRuntimeTaskPinned({
        deviceId: address.deviceId,
        threadId: 'thread-1',
        pinned: false,
      })
    ).resolves.toEqual(rejected)
    await expect(client.archiveConversation(address)).rejects.toThrow('Device unavailable')
    expect(request).toHaveBeenCalledTimes(2)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('requires the existing Runtime connection instead of trying an absent REST endpoint', async () => {
    const client = new RuntimeApi(config)
    await expect(
      client.setRuntimeTaskPinned({
        deviceId: address.deviceId,
        threadId: 'thread-1',
        pinned: true,
      })
    ).rejects.toThrow('Runtime connection is unavailable')
    await expect(client.renameRuntimeTask({ address, title: 'New title' })).rejects.toThrow(
      'Runtime connection is unavailable'
    )
    await expect(client.archiveConversation(address)).rejects.toThrow(
      'Runtime connection is unavailable'
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})
