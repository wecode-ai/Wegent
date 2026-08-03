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

describe('localModelSettings credential persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    runtimeMocks.invoke.mockReset()
    runtimeMocks.isTauriRuntime.mockReturnValue(true)
    vi.resetModules()
  })

  test('persists API keys in local storage without accessing the native credential store', async () => {
    const settings = await import('./localModelSettings')

    settings.saveLocalModelConfig({
      id: 'restart-model',
      displayName: 'Restart model',
      modelId: 'restart-model',
      baseUrl: 'https://models.example/v1',
      apiKey: 'restart-secret',
    })

    expect(localStorage.getItem(settings.LOCAL_MODEL_SETTINGS_STORAGE_KEY)).toContain(
      'restart-secret'
    )
    expect(settings.listLocalModelConfigs()[0].apiKey).toBe('restart-secret')
    expect(runtimeMocks.invoke).not.toHaveBeenCalled()
  })

  test('moves a keychain API key back to local storage before the first workbench request', async () => {
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
    runtimeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'read_local_model_api_keys') {
        return { 'cold-start-model': 'cold-start-secret' }
      }
      return undefined
    })
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

    expect(runtimeMocks.invoke).toHaveBeenNthCalledWith(1, 'read_local_model_api_keys', {
      configIds: ['cold-start-model'],
    })
    await vi.waitFor(() => {
      expect(runtimeMocks.invoke).toHaveBeenCalledWith('delete_local_model_api_keys', {
        configIds: ['cold-start-model'],
      })
    })
    expect(localStorage.getItem('wework.localModelSettings.v1')).toContain('cold-start-secret')
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

  test('does not access the native credential store after the API key is in local storage', async () => {
    localStorage.setItem(
      'wework.localModelSettings.v1',
      JSON.stringify([
        {
          id: 'stored-model',
          displayName: 'Stored model',
          modelId: 'stored-model',
          baseUrl: 'https://models.example/v1',
          apiKey: 'stored-secret',
          apiKeyConfigured: true,
          enabled: true,
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ])
    )
    const settings = await import('./localModelSettings')

    await settings.ensureLocalModelApiKeysHydrated()

    expect(runtimeMocks.invoke).not.toHaveBeenCalled()
    expect(settings.listLocalModelConfigs()[0].apiKey).toBe('stored-secret')
  })

  test('reads only configured credentials missing from local storage', async () => {
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
          id: 'stored-key',
          displayName: 'Stored key',
          modelId: 'stored-key',
          baseUrl: 'https://models.example/v1',
          apiKey: 'already-local',
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
    runtimeMocks.invoke.mockResolvedValue({})
    const settings = await import('./localModelSettings')

    await settings.ensureLocalModelApiKeysHydrated()

    expect(runtimeMocks.invoke).toHaveBeenCalledOnce()
    expect(runtimeMocks.invoke).toHaveBeenCalledWith('read_local_model_api_keys', {
      configIds: ['saved-key'],
    })
  })

  test('does not repeatedly reopen the native credential store after migration fails', async () => {
    localStorage.setItem(
      'wework.localModelSettings.v1',
      JSON.stringify([
        {
          id: 'denied-key',
          displayName: 'Denied key',
          modelId: 'denied-key',
          baseUrl: 'https://models.example/v1',
          apiKeyConfigured: true,
          enabled: true,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ])
    )
    runtimeMocks.invoke.mockRejectedValue(new Error('denied'))
    const settings = await import('./localModelSettings')

    await expect(settings.ensureLocalModelApiKeysHydrated()).rejects.toThrow('denied')
    await expect(settings.ensureLocalModelApiKeysHydrated()).rejects.toThrow('denied')

    expect(runtimeMocks.invoke).toHaveBeenCalledOnce()
  })
})
