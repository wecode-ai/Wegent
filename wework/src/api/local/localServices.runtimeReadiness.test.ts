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
    '%s waits for startup before dispatching',
    async operation => {
      const startup = deferred<typeof status>()
      const ensure = vi.fn(() => startup.promise)
      const request = vi.fn().mockResolvedValue({ messages: [] })
      const services = createLocalAppServices({
        subscribe: vi.fn().mockResolvedValue(vi.fn()),
        available: async () => status,
        ensure,
        request,
      })
      const address = { deviceId: status.deviceId, taskId: 'persisted-task', runtime: 'codex' }
      const pending =
        operation === 'read'
          ? services.runtimeWorkApi!.getRuntimeTranscript(address)
          : services.runtimeWorkApi!.searchRuntimeTranscript({ ...address, query: 'persisted' })

      await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce())
      expect(request).not.toHaveBeenCalled()
      startup.resolve(status)
      await pending
      expect(request).toHaveBeenCalledWith(
        operation === 'read' ? 'runtime.tasks.transcript' : 'runtime.tasks.transcript.search',
        expect.objectContaining(address)
      )
    }
  )

  test('default Codex reads wait for the startup catalog restart as well', async () => {
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
    const restart = deferred<{ restarted: boolean }>()
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'runtime.codex.app_server.restart') return restart.promise
      return { messages: [] }
    })
    const services = createLocalAppServices({
      subscribe: vi.fn().mockResolvedValue(vi.fn()),
      available: async () => status,
      ensure: async () => status,
      request,
    })
    const pending = services.runtimeWorkApi!.getRuntimeTranscript({
      deviceId: status.deviceId,
      taskId: 'persisted-task',
    })
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('runtime.codex.app_server.restart', { ifIdle: true })
    )
    expect(request.mock.calls.some(([method]) => method === 'runtime.tasks.transcript')).toBe(false)
    restart.resolve({ restarted: true })
    await pending
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'runtime.codex.catalog.custom.write',
      'runtime.codex.app_server.restart',
      'runtime.tasks.transcript',
    ])
  })

  test('startup failure is returned before any transcript is dispatched', async () => {
    const request = vi.fn()
    const services = createLocalAppServices({
      subscribe: vi.fn().mockResolvedValue(vi.fn()),
      available: async () => status,
      ensure: async () => {
        throw new Error('Proxy initialization failed')
      },
      request,
    })
    await expect(
      services.runtimeWorkApi!.getRuntimeTranscript({
        deviceId: status.deviceId,
        taskId: 'persisted-task',
      })
    ).rejects.toThrow('Proxy initialization failed')
    expect(request).not.toHaveBeenCalled()
  })
})
