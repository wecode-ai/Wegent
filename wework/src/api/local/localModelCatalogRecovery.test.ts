import { beforeEach, expect, test, vi } from 'vitest'
import { DshExecutorTransportError } from '@/api/dsh/executorTransport'
import { createDefaultLocalModelCatalogEntry } from '@/features/model-settings/localModelCatalog'
import {
  clearLocalModelConfigs,
  listLocalModelConfigs,
  saveLocalModelConfig,
} from '@/features/model-settings/localModelSettings'
import { createLocalAppServices, resetLocalRuntimeChatStreamsForTests } from './localServices'

beforeEach(() => {
  localStorage.clear()
  clearLocalModelConfigs()
  resetLocalRuntimeChatStreamsForTests()
})

test.each(['runtime.codex.catalog.custom.write', 'runtime.codex.app_server.restart'])(
  'reconciles the catalog on the next read after a retryable interruption of %s',
  async interruptedMethod => {
    const catalogEntry = createDefaultLocalModelCatalogEntry({
      id: 'recovery',
      displayName: 'Recovery',
      toolProfile: 'native',
    })
    saveLocalModelConfig({
      id: 'recovery',
      displayName: 'Recovery',
      modelId: 'recovery',
      baseUrl: 'http://model.test/v1',
      catalogEntry,
      catalogReady: false,
    })
    let interrupted = false
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === interruptedMethod && !interrupted) {
        interrupted = true
        throw new DshExecutorTransportError('runtime_unavailable', 'write EPIPE', true)
      }
      if (method === 'runtime.codex.app_server.restart') return { restarted: true }
      return { success: true, runtimeWorktrees: null }
    })
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({
        running: true,
        ready: true,
        deviceId: 'local-device',
        runtimeInstanceId: 'runtime-1',
      }),
      request,
      subscribe: vi.fn(),
    })

    await services.deviceApi.listDevices()
    expect(listLocalModelConfigs()[0].catalogReady).toBe(false)
    await services.deviceApi.listDevices()

    expect(listLocalModelConfigs()[0].catalogReady).toBe(true)
    expect(
      request.mock.calls.filter(([method]) => method === 'runtime.codex.catalog.custom.write')
    ).toHaveLength(2)
  }
)
