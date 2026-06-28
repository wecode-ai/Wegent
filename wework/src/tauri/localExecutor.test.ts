import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  LOCAL_EXECUTOR_COMMANDS,
  LOCAL_EXECUTOR_EVENT,
  connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend,
  ensureLocalExecutorStarted,
  getLocalExecutorStatus,
  requestLocalExecutor,
  restartLocalExecutor,
  subscribeLocalExecutorEvents,
} from './localExecutor'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}))

const invokeMock = vi.mocked(invoke)
const listenMock = vi.mocked(listen)

describe('localExecutor', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
  })

  test('ensures the local executor through the native app command', async () => {
    invokeMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    await expect(ensureLocalExecutorStarted()).resolves.toEqual({
      running: true,
      ready: true,
      deviceId: 'local-device',
    })
    expect(invokeMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.ensure)
  })

  test('reads local executor status through the native app command', async () => {
    invokeMock.mockResolvedValue({ running: false, ready: false, error: 'missing binary' })

    await expect(getLocalExecutorStatus()).resolves.toEqual({
      running: false,
      ready: false,
      error: 'missing binary',
    })
    expect(invokeMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.status)
  })

  test('restarts the local executor through the native app command', async () => {
    invokeMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    await expect(restartLocalExecutor()).resolves.toEqual({
      running: true,
      ready: true,
      deviceId: 'local-device',
    })
    expect(invokeMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.restart)
  })

  test('connects the local executor to backend through the native app command', async () => {
    invokeMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    await expect(
      connectLocalExecutorToBackend({
        backendUrl: 'https://cloud.example.com',
        authToken: 'wg-token',
      })
    ).resolves.toEqual({
      running: true,
      ready: true,
      deviceId: 'local-device',
    })
    expect(invokeMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.connectBackend, {
      backendUrl: 'https://cloud.example.com',
      authToken: 'wg-token',
    })
  })

  test('disconnects the local executor from backend through the native app command', async () => {
    invokeMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    await expect(disconnectLocalExecutorFromBackend()).resolves.toEqual({
      running: true,
      ready: true,
      deviceId: 'local-device',
    })
    expect(invokeMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.disconnectBackend)
  })

  test('sends local executor requests through the native app command', async () => {
    invokeMock.mockResolvedValue({ projects: [], chats: [], totalLocalTasks: 0 })

    await expect(
      requestLocalExecutor('runtime.tasks.list', { includeArchived: false })
    ).resolves.toEqual({
      projects: [],
      chats: [],
      totalLocalTasks: 0,
    })
    expect(invokeMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.request, {
      method: 'runtime.tasks.list',
      params: { includeArchived: false },
    })
  })

  test('subscribes to local executor native events', async () => {
    const unlisten = vi.fn()
    listenMock.mockResolvedValue(unlisten)
    const handler = vi.fn()

    const cleanup = await subscribeLocalExecutorEvents(handler)
    const [, callback] = listenMock.mock.calls[0]
    callback({
      event: LOCAL_EXECUTOR_EVENT,
      id: 1,
      payload: {
        event: 'response.completed',
        payload: { localTaskId: 'task-1' },
      },
    })
    cleanup()

    expect(listenMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_EVENT, expect.any(Function))
    expect(handler).toHaveBeenCalledWith({
      event: 'response.completed',
      payload: { localTaskId: 'task-1' },
    })
    expect(unlisten).toHaveBeenCalled()
  })
})
