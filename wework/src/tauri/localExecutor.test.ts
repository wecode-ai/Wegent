import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  LOCAL_EXECUTOR_COMMANDS,
  LOCAL_EXECUTOR_EVENT,
  connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend,
  ensureBundledPluginMarketplaceRegistered,
  ensureLocalExecutorStarted,
  getLocalExecutorStatus,
  getInitializedBundledPluginMarketplace,
  requestLocalExecutor,
  resetLocalExecutorStateForTests,
  subscribeLocalExecutorEvents,
} from './localExecutor'
import { saveLocalProxyUrl } from '@/features/model-settings/localProxySettings'

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
    localStorage.clear()
    resetLocalExecutorStateForTests()
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
          codexInitializeElapsedMs: 57,
        })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.request) {
        return Promise.resolve({ marketplaceName: 'wework-personal' })
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    await expect(ensureLocalExecutorStarted()).resolves.toEqual({
      running: true,
      ready: true,
      deviceId: 'local-device',
      runtimeInstanceId: 'runtime-1',
      codexInitializeElapsedMs: 57,
    })
    expect(getInitializedBundledPluginMarketplace()).toEqual({
      id: 'wework-personal',
      path: '/Users/test/.wegent-executor/capabilities/bundled-marketplaces/wework-personal',
      pluginCount: 0,
    })
    expect(invokeMock.mock.calls).toEqual([
      [LOCAL_EXECUTOR_COMMANDS.initializeBundledPluginMarketplace],
      [LOCAL_EXECUTOR_COMMANDS.ensure, { proxyUrl: null }],
    ])
  })

  test('passes the configured proxy into the executor startup barrier', async () => {
    saveLocalProxyUrl('http://127.0.0.1:7890')
    invokeMock.mockImplementation(command => {
      if (command === LOCAL_EXECUTOR_COMMANDS.initializeBundledPluginMarketplace) {
        return Promise.resolve({
          id: 'wework-personal',
          path: '/Users/test/.wegent-executor/capabilities/bundled-marketplaces/wework-personal',
          pluginCount: 0,
        })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.ensure) {
        return Promise.resolve({
          running: true,
          ready: true,
          deviceId: 'local-device',
          runtimeInstanceId: 'runtime-proxy',
        })
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    await ensureLocalExecutorStarted()

    expect(invokeMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.ensure, {
      proxyUrl: 'http://127.0.0.1:7890',
    })
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
        return Promise.resolve({ marketplaceName: 'wework-personal' })
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    await ensureLocalExecutorStarted()

    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  test('does not start bundled marketplace registration before reporting ready', async () => {
    const path =
      '/Users/test/.wegent-executor/capabilities/bundled-marketplaces/wework-personal-background'
    let finishMarketplaceRegistration: (value: { marketplaceName: string }) => void = () =>
      undefined
    const marketplaceRegistration = new Promise<{ marketplaceName: string }>(resolve => {
      finishMarketplaceRegistration = resolve
    })
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
          runtimeInstanceId: 'runtime-background',
        })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.status) {
        return Promise.resolve({
          running: true,
          ready: true,
          runtimeInstanceId: 'runtime-background',
        })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.request) {
        const request = invokeMock.mock.calls.at(-1)?.[1] as
          | { params?: { method?: string } }
          | undefined
        if (request?.params?.method === 'marketplace/add') {
          return marketplaceRegistration
        }
        return Promise.resolve(undefined)
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    await expect(ensureLocalExecutorStarted()).resolves.toMatchObject({
      running: true,
      ready: true,
      runtimeInstanceId: 'runtime-background',
    })

    expect(invokeMock).not.toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.request, {
      method: 'codex.app_server_request',
      params: expect.anything(),
    })
    const registration = ensureBundledPluginMarketplaceRegistered()
    finishMarketplaceRegistration({ marketplaceName: 'wework-personal' })
    await registration
  })

  test('repairs a stale bundled marketplace using local-only discovery', async () => {
    const path =
      '/Users/test/.wegent-executor/capabilities/bundled-marketplaces/wework-personal-repaired'
    let addAttempts = 0
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
          runtimeInstanceId: 'runtime-repaired',
        })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.status) {
        return Promise.resolve({
          running: true,
          ready: true,
          runtimeInstanceId: 'runtime-repaired',
        })
      }
      if (command === LOCAL_EXECUTOR_COMMANDS.request) {
        const request = invokeMock.mock.calls.at(-1)?.[1] as
          | { params?: { method?: string } }
          | undefined
        if (request?.params?.method === 'marketplace/add') {
          addAttempts += 1
          return addAttempts === 1
            ? Promise.reject(new Error('marketplace name already exists'))
            : Promise.resolve({ marketplaceName: 'wework-personal' })
        }
        if (request?.params?.method === 'plugin/list') {
          return Promise.resolve({
            marketplaces: [{ name: 'wework-personal', path: '/Users/test/old-marketplace' }],
          })
        }
        if (request?.params?.method === 'marketplace/remove') {
          return Promise.resolve(undefined)
        }
        return Promise.resolve(undefined)
      }
      return Promise.reject(new Error(`Unexpected command: ${String(command)}`))
    })

    await ensureLocalExecutorStarted()
    await ensureBundledPluginMarketplaceRegistered()
    expect(addAttempts).toBe(2)

    expect(invokeMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.request, {
      method: 'codex.app_server_request',
      params: {
        method: 'plugin/list',
        params: {
          cwds: null,
          marketplaceKinds: ['local'],
        },
      },
    })
  })

  test('defers bundled marketplace registration until it is explicitly requested', async () => {
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
      if (command === LOCAL_EXECUTOR_COMMANDS.status) {
        return Promise.resolve({
          running: true,
          ready: true,
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

    expect(invokeMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.ensure, {
      proxyUrl: null,
    })
    expect(invokeMock).not.toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.request, {
      method: 'codex.app_server_request',
      params: expect.anything(),
    })

    shouldPromptMigration = false
    await ensureBundledPluginMarketplaceRegistered()

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
        socketBaseUrl: 'wss://socket.example.com',
        authToken: 'wg-token',
        runtimeAuthToken: 'task-token',
      })
    ).resolves.toEqual({
      running: true,
      ready: true,
      deviceId: 'local-device',
    })
    expect(invokeMock).toHaveBeenCalledWith(LOCAL_EXECUTOR_COMMANDS.connectBackend, {
      backendUrl: 'https://cloud.example.com',
      socketUrl: 'wss://socket.example.com',
      authToken: 'wg-token',
      runtimeAuthToken: 'task-token',
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
