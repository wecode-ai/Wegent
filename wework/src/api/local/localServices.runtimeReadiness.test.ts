import { createDefaultLocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'
import {
  clearLocalModelConfigs,
  saveLocalModelConfig,
} from '@/features/model-settings/localModelSettings'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createLocalAppServices,
  createRuntimeWorkApiFromIpc,
  resetLocalRuntimeChatStreamsForTests,
} from './localServices'

const status = {
  running: true,
  ready: true,
  deviceId: 'local-device',
  runtimeInstanceId: 'local-runtime',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('local transcript startup ordering', () => {
  test('preserves advertised event support when adding worktree capabilities', async () => {
    const runtimeFeatures = { schemaVersion: 4, connectionEvents: { protocolVersion: 1 } }
    const ready = { ...status, runtimeFeatures }
    const services = createLocalAppServices({
      subscribe: vi.fn().mockResolvedValue(vi.fn()),
      available: async () => ready,
      ensure: async () => ready,
      request: vi.fn().mockResolvedValue({ runtimeWorktrees: { version: 1, managed: true } }),
    })
    const devices = await services.deviceApi!.listDevices()
    expect(devices[0].runtime_features).toMatchObject({
      ...runtimeFeatures,
      worktrees: { version: 1, managed: true },
    })
  })

  beforeEach(() => {
    localStorage.clear()
    clearLocalModelConfigs()
    resetLocalRuntimeChatStreamsForTests()
  })

  test('logs transcript identities and lifecycle only when debugging is enabled', async () => {
    const response = {
      threadId: 'thread',
      running: true,
      messages: [{ content: 'PRIVATE_MESSAGE' }],
      turns: [
        {
          id: 'turn',
          status: 'cancelled',
          clientUserMessageId: 'user',
          error: 'PRIVATE_ERROR',
          items: [
            {
              id: 'item',
              type: 'assistant_text',
              content: 'PRIVATE_CONTENT',
              credentials: 'PRIVATE_CREDENTIALS',
            },
          ],
        },
      ],
    }
    const services = createLocalAppServices({
      subscribe: vi.fn().mockResolvedValue(vi.fn()),
      available: async () => status,
      ensure: async () => status,
      request: vi.fn().mockResolvedValue(response),
    })
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const address = { deviceId: status.deviceId, taskId: 'persisted-task', runtime: 'codex' }
    try {
      await services.runtimeWorkApi!.getRuntimeTranscript(address)
      expect(debug).not.toHaveBeenCalled()
      localStorage.setItem('wework:debug-runtime', '1')

      await services.runtimeWorkApi!.getRuntimeTranscript(address)

      expect(debug).toHaveBeenCalledWith(
        '[Wework] Local runtime IPC transcript response',
        expect.objectContaining({
          threadId: 'thread',
          running: true,
          messageCount: 1,
          turns: [
            {
              id: 'turn',
              status: 'cancelled',
              clientUserMessageId: 'user',
              items: [{ id: 'item', type: 'assistant_text', blockType: null }],
            },
          ],
        })
      )
      expect(JSON.stringify(debug.mock.calls)).not.toContain('PRIVATE_')
    } finally {
      debug.mockRestore()
    }
  })

  test.each(['read', 'search'] as const)(
    '%s waits for executor availability without preparing model execution',
    async operation => {
      const startup = deferred<typeof status>()
      const available = vi.fn(() => startup.promise)
      const ensure = vi.fn()
      const request = vi.fn().mockResolvedValue({ messages: [] })
      const services = createLocalAppServices({
        subscribe: vi.fn().mockResolvedValue(vi.fn()),
        available,
        ensure,
        request,
      })
      const address = { deviceId: status.deviceId, taskId: 'persisted-task', runtime: 'codex' }
      const pending =
        operation === 'read'
          ? services.runtimeWorkApi!.getRuntimeTranscript(address)
          : services.runtimeWorkApi!.searchRuntimeTranscript({ ...address, query: 'persisted' })

      await vi.waitFor(() => expect(available).toHaveBeenCalledOnce())
      expect(ensure).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
      startup.resolve(status)
      await pending
      expect(request).toHaveBeenCalledWith(
        operation === 'read' ? 'runtime.tasks.transcript' : 'runtime.tasks.transcript.search',
        expect.objectContaining(address)
      )
    }
  )

  test('persisted transcript reads do not prepare or restart a pending model catalog', async () => {
    saveLocalModelConfig({
      id: 'restored-model',
      displayName: 'Restored model',
      baseUrl: 'https://models.example.com/v1',
      apiKey: 'test-key',
      modelId: 'restored-model',
      catalogEntry: createDefaultLocalModelCatalogEntry({
        id: 'restored-model',
        displayName: 'Restored model',
        toolProfile: 'custom',
      }),
      catalogReady: false,
    })
    const ensure = vi.fn(() => new Promise<typeof status>(() => {}))
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.codex.app_server.restart') return new Promise(() => {})
      return { messages: [] }
    })
    const services = createLocalAppServices({
      subscribe: vi.fn().mockResolvedValue(vi.fn()),
      available: async () => status,
      ensure,
      request,
    })
    const pending = services.runtimeWorkApi!.getRuntimeTranscript({
      deviceId: status.deviceId,
      taskId: 'persisted-task',
    })
    await pending
    expect(ensure).not.toHaveBeenCalled()
    expect(request.mock.calls.map(([method]) => method)).toEqual(['runtime.tasks.transcript'])
  })

  test('unavailable executor errors are returned before any transcript is dispatched', async () => {
    const request = vi.fn()
    const services = createLocalAppServices({
      subscribe: vi.fn().mockResolvedValue(vi.fn()),
      available: async () => {
        throw new Error('Executor unavailable')
      },
      ensure: vi.fn(),
      request,
    })
    await expect(
      services.runtimeWorkApi!.getRuntimeTranscript({
        deviceId: status.deviceId,
        taskId: 'persisted-task',
      })
    ).rejects.toThrow('Executor unavailable')
    expect(request).not.toHaveBeenCalled()
  })
})

test('model picker reads do not wait for runtime preparation or restart the app server', async () => {
  localStorage.clear()
  clearLocalModelConfigs()
  resetLocalRuntimeChatStreamsForTests()
  saveLocalModelConfig({
    id: 'startup-read',
    displayName: 'Startup read',
    modelId: 'startup-read',
    baseUrl: 'https://models.example.com/v1',
    catalogEntry: createDefaultLocalModelCatalogEntry({
      id: 'startup-read',
      displayName: 'Startup read',
      toolProfile: 'custom',
    }),
    catalogReady: false,
  })
  const ensure = vi.fn(() => new Promise<typeof status>(() => {}))
  const request = vi.fn().mockResolvedValue({ data: [], models: [] })
  const services = createLocalAppServices({
    available: async () => status,
    ensure,
    request,
    subscribe: vi.fn(),
  })
  const models = await services.modelApi.listModels()
  expect(models.data).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'local-model:startup-read' })])
  )
  expect(ensure).not.toHaveBeenCalled()
  expect(request.mock.calls.map(([method]) => method)).not.toContain(
    'runtime.codex.catalog.custom.write'
  )
  expect(request.mock.calls.map(([method]) => method)).not.toContain(
    'runtime.codex.app_server.restart'
  )
})

test('execution prepares a pending local catalog before publishing creation profiles', async () => {
  localStorage.clear()
  clearLocalModelConfigs()
  resetLocalRuntimeChatStreamsForTests()
  saveLocalModelConfig({
    id: 'execution-pending',
    displayName: 'Execution pending',
    modelId: 'execution-pending',
    baseUrl: 'https://models.example.com/v1',
    catalogEntry: createDefaultLocalModelCatalogEntry({
      id: 'execution-pending',
      displayName: 'Execution pending',
      toolProfile: 'custom',
    }),
    catalogReady: false,
  })
  const ensure = vi.fn(async () => status)
  const request = vi.fn().mockImplementation(async (method: string) => {
    if (method === 'runtime.codex.app_server.restart') return { restarted: true }
    return { data: [], models: [] }
  })
  const services = createLocalAppServices({
    available: async () => status,
    ensure,
    request,
    subscribe: vi.fn(),
  })
  await services.modelApi.listModels()
  expect(ensure).not.toHaveBeenCalled()
  expect(
    request.mock.calls.some(([method]) => method === 'runtime.codex.catalog.custom.write')
  ).toBe(false)
  request.mockClear()

  await services.runtimeWorkApi!.prepareRuntimeModel({
    deviceId: status.deviceId,
    modelId: 'local-model:execution-pending',
  })

  expect(ensure).toHaveBeenCalled()
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'runtime.codex.catalog.custom.write',
    'runtime.codex.app_server.restart',
    'runtime.models.sync_creation_profiles',
  ])
  expect(request).toHaveBeenCalledWith('runtime.models.sync_creation_profiles', {
    deviceId: status.deviceId,
    profiles: expect.arrayContaining([
      expect.objectContaining({ runtime: 'codex', modelName: 'local-model:execution-pending' }),
    ]),
  })
})

test('work reads use their proven owner without a default-device lookup and reject owner replacement', async () => {
  for (const replaced of [false, true]) {
    const identity = {
      deviceId: 'native-device',
      runtimeInstanceId: 'native-instance',
      provenance: 'local-ipc' as const,
    }
    const api = createRuntimeWorkApiFromIpc(
      vi.fn().mockResolvedValue({ projects: [], chats: [], totalTasks: 0 }),
      () => new Promise<string>(() => {}),
      {
        getLocalRuntimeSidebarIdentity: vi
          .fn()
          .mockResolvedValueOnce(identity)
          .mockResolvedValueOnce(
            replaced ? { ...identity, runtimeInstanceId: 'replacement-instance' } : identity
          ),
      }
    )
    if (replaced) {
      await expect(api.listRuntimeWork()).rejects.toThrow('local-sidebar-runtime-changed')
    } else {
      await expect(api.listRuntimeWork()).resolves.toMatchObject({
        projects: [],
        chats: [],
        totalTasks: 0,
      })
    }
  }
})
