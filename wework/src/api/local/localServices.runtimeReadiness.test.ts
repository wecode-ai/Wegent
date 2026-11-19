import { createDefaultLocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'
import {
  clearLocalModelConfigs,
  saveLocalModelConfig,
} from '@/features/model-settings/localModelSettings'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createLocalAppServices, resetLocalRuntimeChatStreamsForTests } from './localServices'

const status = {
  running: true,
  ready: true,
  deviceId: 'local-device',
  runtimeInstanceId: 'local-runtime',
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
    '%s preserves stored history when model preparation is unavailable',
    async operation => {
      const ensure = vi.fn(async () => {
        throw new Error('Model preparation unavailable')
      })
      const expected =
        operation === 'read'
          ? { messages: [{ content: 'persisted' }] }
          : { matches: [], totalMatches: 0, isCapped: false }
      const request = vi.fn().mockResolvedValue(expected)
      const services = createLocalAppServices({
        subscribe: vi.fn().mockResolvedValue(vi.fn()),
        available: async () => status,
        ensure,
        request,
      })
      const address = { deviceId: status.deviceId, taskId: 'persisted-task', runtime: 'codex' }
      const response =
        operation === 'read'
          ? await services.runtimeWorkApi!.getRuntimeTranscript(address)
          : await services.runtimeWorkApi!.searchRuntimeTranscript({
              ...address,
              query: 'persisted',
            })
      expect(response).toEqual(expected)
      expect(ensure).not.toHaveBeenCalled()
      expect(request).toHaveBeenCalledWith(
        operation === 'read' ? 'runtime.tasks.transcript' : 'runtime.tasks.transcript.search',
        expect.objectContaining(address)
      )
    }
  )

  test('does not rewrite the model catalog or restart Codex to read stored history', async () => {
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
    const request = vi.fn().mockResolvedValue({ messages: [] })
    const services = createLocalAppServices({
      subscribe: vi.fn().mockResolvedValue(vi.fn()),
      available: async () => status,
      ensure: async () => status,
      request,
    })
    await services.runtimeWorkApi!.getRuntimeTranscript({
      deviceId: status.deviceId,
      taskId: 'persisted-task',
    })
    expect(request.mock.calls.map(([method]) => method)).toEqual(['runtime.tasks.transcript'])
  })

  test('preserves transport initialization failures on stored history reads', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Proxy initialization failed'))
    const services = createLocalAppServices({
      subscribe: vi.fn().mockResolvedValue(vi.fn()),
      available: async () => status,
      request,
    })
    await expect(
      services.runtimeWorkApi!.getRuntimeTranscript({
        deviceId: status.deviceId,
        taskId: 'persisted-task',
      })
    ).rejects.toThrow('Proxy initialization failed')
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
