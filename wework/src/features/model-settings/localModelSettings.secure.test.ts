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
    await firstSession.flushLocalModelConfigWrites()

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
    const changed = vi.fn()
    window.addEventListener(restartedSession.LOCAL_MODEL_SETTINGS_CHANGED_EVENT, changed)
    await restartedSession.hydrateLocalModelApiKeys()

    expect(runtimeMocks.invoke).toHaveBeenCalledWith('read_local_model_api_keys', {
      configIds: ['restart-model'],
    })
    expect(changed).toHaveBeenCalledOnce()
    expect(restartedSession.listLocalModelConfigs()[0].apiKey).toBe('restart-secret')
    window.removeEventListener(restartedSession.LOCAL_MODEL_SETTINGS_CHANGED_EVENT, changed)
  })

  test('hydrates a persisted API key before the first workbench request', async () => {
    localStorage.setItem(
      'wework.localModelSettings.v1',
      JSON.stringify([
        {
          id: 'cold-start-model',
          displayName: 'Cold start model',
          modelId: 'cold-start-model',
          baseUrl: 'https://models.example/v1',
          apiKeyConfigured: true,
          catalogReady: true,
          enabled: true,
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ])
    )
    runtimeMocks.invoke.mockResolvedValue({ 'cold-start-model': 'cold-start-secret' })
    const request = vi.fn().mockResolvedValue({ accepted: true })
    const { createLocalAppServices } = await import('@/api/local/localServices')
    const services = createLocalAppServices({
      ensure: vi.fn().mockResolvedValue({
        running: true,
        ready: true,
        deviceId: 'local-device',
      }),
      request,
      subscribe: vi.fn(),
    })

    await services.runtimeWorkApi?.createRuntimeTask({
      teamId: 0,
      deviceId: 'local-device',
      workspacePath: '/Users/me/project',
      taskId: 'task-1',
      runtime: 'codex',
      message: 'hello',
      title: 'Hello',
      modelId: 'local-model:cold-start-model',
    })

    expect(runtimeMocks.invoke).toHaveBeenCalledWith('read_local_model_api_keys', {
      configIds: ['cold-start-model'],
    })
    const createCall = request.mock.calls.find(([method]) => method === 'runtime.tasks.create')
    expect(createCall?.[1]).toEqual(
      expect.objectContaining({
        executionRequest: expect.objectContaining({
          model_config: expect.objectContaining({
            api_key: 'cold-start-secret',
          }),
        }),
      })
    )
    expect(runtimeMocks.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[0]
    )
  })

  test('migrates a legacy persisted API key into the native credential store', async () => {
    localStorage.setItem(
      'wework.localModelSettings.v1',
      JSON.stringify([
        {
          id: 'legacy-secret',
          displayName: 'Legacy secret',
          modelId: 'legacy-model',
          baseUrl: 'https://models.local/v1',
          apiKey: 'legacy-api-key',
          enabled: true,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ])
    )
    runtimeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'read_local_model_api_keys') return {}
      return undefined
    })
    const settings = await import('./localModelSettings')

    await settings.hydrateLocalModelApiKeys()

    expect(runtimeMocks.invoke).toHaveBeenCalledWith('update_local_model_api_key', {
      configId: 'legacy-secret',
      apiKey: 'legacy-api-key',
    })
    expect(localStorage.getItem(settings.LOCAL_MODEL_SETTINGS_STORAGE_KEY)).not.toContain(
      'legacy-api-key'
    )
    expect(settings.listLocalModelConfigs()[0].apiKey).toBe('legacy-api-key')
  })

  test('does not access the native credential store when no model has a saved API key', async () => {
    localStorage.setItem(
      'wework.localModelSettings.v1',
      JSON.stringify([
        {
          id: 'keyless-model',
          displayName: 'Keyless model',
          modelId: 'keyless-model',
          baseUrl: 'http://localhost:11434/v1',
          apiKeyConfigured: false,
          enabled: true,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ])
    )
    const settings = await import('./localModelSettings')

    await settings.hydrateLocalModelApiKeys()

    expect(runtimeMocks.invoke).not.toHaveBeenCalled()
  })

  test('reads only credentials marked as configured', async () => {
    localStorage.setItem(
      'wework.localModelSettings.v1',
      JSON.stringify([
        {
          id: 'saved-key',
          displayName: 'Saved key',
          modelId: 'saved-key',
          baseUrl: 'https://models.example/v1',
          apiKeyConfigured: true,
          enabled: true,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'keyless-model',
          displayName: 'Keyless model',
          modelId: 'keyless-model',
          baseUrl: 'http://localhost:11434/v1',
          apiKeyConfigured: false,
          enabled: true,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ])
    )
    runtimeMocks.invoke.mockResolvedValue({ 'saved-key': 'restart-secret' })
    const settings = await import('./localModelSettings')

    await settings.hydrateLocalModelApiKeys()

    expect(runtimeMocks.invoke).toHaveBeenCalledWith('read_local_model_api_keys', {
      configIds: ['saved-key'],
    })
  })
})
