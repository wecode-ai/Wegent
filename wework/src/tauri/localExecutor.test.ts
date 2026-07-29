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
  getInitializedBundledPluginMarketplace,
  requestLocalExecutor,
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
    invokeMock.mockImplementation(command => {
      if (command === LOCAL_EXECUTOR_COMMANDS.initializeBundledPluginMarketplace) {
        return Promise.resolve({
          id: 'wework-personal',
          path: '/Users/test/.wegent-executor/capabilities/bundled-marketplaces/wework-personal',
          pluginCount: 0,
        })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.codexHomeMigrationStatus) {
        return Promise.resolve({ shouldPromptMigration: false })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.ensure) {
        return Promise.resolve({
          running: true,
          ready: true,
          deviceId: 'local-device',
          runtimeInstanceId: 'runtime-1',
        })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.request) {
        const request = invokeMock.mock.calls.at(-1)?.[1] as
          | { params?: { method?: string } }
          | undefined
        if (request?.params?.method === 'plugin/list') {
          return Promise.resolve({ marketplaces: [] })
        }
        return Promise.resolve({ marketplaceName: 'wework-personal' })
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    await expect(ensureLocalExecutorStarted()).resolves.toEqual({
      running: true,
      ready: true,
      deviceId: 'local-device',
      runtimeInstanceId: 'runtime-1',
    })
    expect(getInitializedBundledPluginMarketplace()).toEqual({
      id: 'wework-personal',
      path: '/Users/test/.wegent-executor/capabilities/bundled-marketplaces/wework-personal',
      pluginCount: 0,
    })
    expect(invokeMock.mock.calls).toEqual([
      [LOCAL_EXECUTOR_COMMANDS.initializeBundledPluginMarketplace],
      [LOCAL_EXECUTOR_COMMANDS.codexHomeMigrationStatus],
      [LOCAL_EXECUTOR_COMMANDS.ensure],
      [
        LOCAL_EXECUTOR_COMMANDS.request,
        {
          method: 'codex.app_server_request',
          params: {
            method: 'plugin/list',
            params: { cwds: null },
          },
        },
      ],
      [
        LOCAL_EXECUTOR_COMMANDS.request,
        {
          method: 'codex.app_server_request',
          params: {
            method: 'marketplace/add',
            params: {
              source:
                '/Users/test/.wegent-executor/capabilities/bundled-marketplaces/wework-personal',
              refName: null,
              sparsePaths: null,
            },
          },
        },
      ],
    ])
  })

  test('keeps an initialized bundled marketplace without adding it again', async () => {
    const path = '/Users/test/.wegent-executor/capabilities/bundled-marketplaces/wework-personal'
    invokeMock.mockImplementation(command => {
      if (command === LOCAL_EXECUTOR_COMMANDS.initializeBundledPluginMarketplace) {
        return Promise.resolve({ id: 'wework-personal', path, pluginCount: 0 })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.codexHomeMigrationStatus) {
        return Promise.resolve({ shouldPromptMigration: false })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.ensure) {
        return Promise.resolve({
          running: true,
          ready: true,
          deviceId: 'local-device',
          runtimeInstanceId: 'runtime-2',
        })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.request) {
        return Promise.resolve({
          marketplaces: [{ name: 'wework-personal', path: `${path}/` }],
        })
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    await ensureLocalExecutorStarted()

    expect(invokeMock).toHaveBeenCalledTimes(4)
  })

  test('defers bundled marketplace registration until Codex home initialization finishes', async () => {
    const path =
      '/Users/test/.wegent-executor/capabilities/bundled-marketplaces/wework-personal-deferred'
    let shouldPromptMigration = true
    invokeMock.mockImplementation(command => {
      if (command === LOCAL_EXECUTOR_COMMANDS.initializeBundledPluginMarketplace) {
        return Promise.resolve({ id: 'wework-personal', path, pluginCount: 0 })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.codexHomeMigrationStatus) {
        return Promise.resolve({ shouldPromptMigration })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.ensure) {
        return Promise.resolve({
          running: true,
          ready: true,
          deviceId: 'local-device',
          runtimeInstanceId: 'runtime-deferred',
        })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.request) {
        const request = invokeMock.mock.calls.at(-1)?.[1] as
          | { params?: { method?: string } }
          | undefined
        if (request?.params?.method === 'plugin/list') {
          return Promise.resolve({ marketplaces: [] })
        }
        return Promise.resolve({ marketplaceName: 'wework-personal' })
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    await ensureLocalExecutorStarted()

    expect(invokeMock).not.toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.request, expect.anything())

    shouldPromptMigration = false
    await ensureLocalExecutorStarted()

    expect(invokeMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.request, {
      method: 'codex.app_server_request',
      params: {
        method: 'marketplace/add',
        params: {
          source: path,
          refName: null,
          sparsePaths: null,
        },
      },
    })
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
    invokeMock.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })

    await expect(
      requestLocalExecutor('runtime.tasks.list', { includeArchived: false })
    ).resolves.toEqual({
      projects: [],
      chats: [],
      totalTasks: 0,
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
        payload: { taskId: 'task-1' },
      },
    })
    cleanup()

    expect(listenMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_EVENT, expect.any(Function))
    expect(handler).toHaveBeenCalledWith({
      event: 'response.completed',
      payload: { taskId: 'task-1' },
    })
    expect(unlisten).toHaveBeenCalled()
  })
})
