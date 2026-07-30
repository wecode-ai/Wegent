import { beforeEach, describe, expect, test, vi } from 'vitest'

const runtimeMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriRuntime: vi.fn(() => true),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: runtimeMocks.invoke,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: runtimeMocks.isTauriRuntime,
}))

describe('localModelSettings secure credentials', () => {
  beforeEach(() => {
    localStorage.clear()
    runtimeMocks.invoke.mockReset()
    runtimeMocks.isTauriRuntime.mockReturnValue(true)
    vi.resetModules()
  })

  test('restores an API key from the native credential store after a renderer restart', async () => {
    runtimeMocks.invoke.mockResolvedValue(undefined)
    const firstSession = await import('./localModelSettings')
    firstSession.saveLocalModelConfig({
      id: 'restart-model',
      displayName: 'Restart model',
      modelId: 'restart-model',
      baseUrl: 'https://models.example/v1',
      apiKey: 'restart-secret',
    })
    await firstSession.flushLocalModelSecretWrites()

    expect(runtimeMocks.invoke).toHaveBeenCalledWith('update_local_model_api_key', {
      configId: 'restart-model',
      apiKey: 'restart-secret',
    })
    expect(localStorage.getItem(firstSession.LOCAL_MODEL_SETTINGS_STORAGE_KEY)).not.toContain(
      'restart-secret'
    )

    vi.resetModules()
    runtimeMocks.invoke.mockResolvedValue({ 'restart-model': 'restart-secret' })
    const restartedSession = await import('./localModelSettings')
    await restartedSession.hydrateLocalModelApiKeys()

    expect(runtimeMocks.invoke).toHaveBeenCalledWith('read_local_model_api_keys', {
      configIds: ['restart-model'],
    })
    expect(restartedSession.listLocalModelConfigs()[0].apiKey).toBe('restart-secret')
  })
})
