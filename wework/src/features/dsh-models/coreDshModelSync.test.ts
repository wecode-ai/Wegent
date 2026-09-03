import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import {
  coreDshProviderId,
  coreDshProviderProfile,
  resetCoreDshModelSyncForTests,
  scheduleCoreDshModelSync,
  syncCoreDshModels,
  type CoreDshModelSyncApi,
} from './coreDshModelSync'

function modelOption(
  key: string,
  label: string,
  overrides: Partial<LocalHarnessModelOption['model']> = {}
): LocalHarnessModelOption {
  return {
    key,
    label,
    source: 'cloud',
    options: {},
    model: {
      name: key,
      type: 'public',
      namespace: 'default',
      resourceUserId: 1,
      ...overrides,
    },
  }
}

describe('Core DSH model sync', () => {
  beforeEach(() => {
    resetCoreDshModelSyncForTests()
  })

  test('publishes Wework models without replacing user-managed DSH providers', async () => {
    const first = modelOption('model-a', 'Model A', {
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      modelCapabilities: { supportsImage: true },
    })
    const second = modelOption('model-b', 'Model B')
    const staleProvider = coreDshProviderId('stale-model')
    const mutations: Array<{ ns: string; ops: Array<Record<string, unknown>> }> = []
    const api: CoreDshModelSyncApi = {
      resolveLaunch: vi.fn(async option => ({
        modelId: 'wework-selected',
        proxyToken: `token-${option.key}`,
        baseUrl: `http://127.0.0.1:1234/v1/harness-router/token-${option.key}`,
        env: {},
      })),
      unregisterProxy: vi.fn(async () => undefined),
      request: vi.fn(async (method, payload) => {
        if (method === 'settings.describe') {
          return {
            namespaces: [
              {
                ns: 'llm-pi-ai',
                user: {
                  providers: {
                    custom: { displayName: 'Custom' },
                    [staleProvider]: { displayName: 'Stale' },
                  },
                },
              },
              { ns: 'agent-default-model', user: {} },
            ],
          }
        }
        if (method === 'settings.mutate') {
          mutations.push(payload as (typeof mutations)[number])
          return {}
        }
        throw new Error(`Unexpected method: ${method}`)
      }),
    }

    await syncCoreDshModels(
      {
        options: [first, second],
      },
      api
    )

    expect(mutations[0]).toMatchObject({
      ns: 'llm-pi-ai',
      ops: expect.arrayContaining([
        { op: 'unset', path: ['providers', staleProvider] },
        {
          op: 'set',
          path: ['providers', coreDshProviderId(first.key)],
          value: expect.objectContaining({
            displayName: 'Model A',
            api: 'anthropic-messages',
            models: [
              expect.objectContaining({
                id: 'wework-selected',
                input: ['text', 'image'],
                contextWindow: 128_000,
                maxTokens: 16_000,
              }),
            ],
          }),
        },
      ]),
    })
    expect(mutations[0].ops).not.toContainEqual({
      op: 'unset',
      path: ['providers', 'custom'],
    })
    expect(mutations[1]).toEqual({
      ns: 'agent-default-model',
      ops: [
        {
          op: 'set',
          path: ['provider'],
          value: coreDshProviderId(first.key),
        },
        { op: 'set', path: ['model'], value: 'wework-selected' },
      ],
    })
    expect(api.resolveLaunch).toHaveBeenNthCalledWith(
      1,
      first,
      `core-dsh:${coreDshProviderId(first.key)}`
    )
  })

  test('releases registrations created before a later model fails', async () => {
    const unregisterProxy = vi.fn(async () => undefined)
    const api: CoreDshModelSyncApi = {
      resolveLaunch: vi.fn(async option => {
        if (option.key === 'model-b') throw new Error('registration failed')
        return {
          modelId: 'wework-selected',
          proxyToken: 'token-model-a',
          baseUrl: 'http://127.0.0.1:1234/v1/harness-router/token-model-a',
          env: {},
        }
      }),
      unregisterProxy,
      request: vi.fn(async method => {
        if (method === 'settings.describe') {
          return {
            namespaces: [{ ns: 'llm-pi-ai', user: {} }],
          }
        }
        throw new Error(`Unexpected method: ${method}`)
      }),
    }

    await expect(
      syncCoreDshModels(
        {
          options: [modelOption('model-a', 'Model A'), modelOption('model-b', 'Model B')],
        },
        api
      )
    ).rejects.toThrow('registration failed')
    expect(unregisterProxy).toHaveBeenCalledWith('token-model-a')
  })

  test('clears a stale Wework default when no executable models remain', async () => {
    const mutations: Array<{ ns: string; ops: Array<Record<string, unknown>> }> = []
    const provider = coreDshProviderId('removed-model')
    const api: CoreDshModelSyncApi = {
      resolveLaunch: vi.fn(),
      unregisterProxy: vi.fn(async () => undefined),
      request: vi.fn(async (method, payload) => {
        if (method === 'settings.describe') {
          return {
            namespaces: [
              {
                ns: 'llm-pi-ai',
                user: { providers: { [provider]: { displayName: 'Removed' } } },
              },
              {
                ns: 'agent-default-model',
                user: { provider, model: 'wework-selected' },
              },
            ],
          }
        }
        if (method === 'settings.mutate') {
          mutations.push(payload as (typeof mutations)[number])
          return {}
        }
        throw new Error(`Unexpected method: ${method}`)
      }),
    }

    await syncCoreDshModels({ options: [] }, api)

    expect(mutations).toEqual([
      {
        ns: 'llm-pi-ai',
        ops: [{ op: 'unset', path: ['providers', provider] }],
      },
      {
        ns: 'agent-default-model',
        ops: [
          { op: 'unset', path: ['provider'] },
          { op: 'unset', path: ['model'] },
        ],
      },
    ])
  })

  test('preserves a valid Core DSH default when the exposed catalog changes', async () => {
    const first = modelOption('model-a', 'Model A')
    const second = modelOption('model-b', 'Model B')
    const mutations: Array<{ ns: string; ops: Array<Record<string, unknown>> }> = []
    const api: CoreDshModelSyncApi = {
      resolveLaunch: vi.fn(async option => ({
        modelId: 'wework-selected',
        proxyToken: `token-${option.key}`,
        baseUrl: `http://127.0.0.1:1234/v1/harness-router/token-${option.key}`,
        env: {},
      })),
      unregisterProxy: vi.fn(async () => undefined),
      request: vi.fn(async (method, payload) => {
        if (method === 'settings.describe') {
          return {
            namespaces: [
              { ns: 'llm-pi-ai', user: {} },
              {
                ns: 'agent-default-model',
                user: {
                  provider: coreDshProviderId(first.key),
                  model: 'wework-selected',
                },
              },
            ],
          }
        }
        if (method === 'settings.mutate') {
          mutations.push(payload as (typeof mutations)[number])
          return {}
        }
        throw new Error(`Unexpected method: ${method}`)
      }),
    }

    await syncCoreDshModels({ options: [first, second] }, api)

    expect(mutations.filter(mutation => mutation.ns === 'agent-default-model')).toHaveLength(0)
  })

  test('builds stable provider ids and text-only profiles by default', () => {
    const option = modelOption('model-a', 'Model A')
    expect(coreDshProviderId(option.key)).toBe(coreDshProviderId(option.key))
    expect(
      coreDshProviderProfile(option, {
        modelId: 'wework-selected',
        proxyToken: 'token',
        baseUrl: 'http://127.0.0.1:1234/router/',
        env: {},
      })
    ).toMatchObject({
      apiKeyEnv: 'WEWORK_HARNESS_API_KEY',
      baseURL: 'http://127.0.0.1:1234/router',
      models: [{ input: ['text'] }],
    })
  })

  test('does not register again when the exposed catalog is unchanged', async () => {
    const first = modelOption('model-a', 'Model A')
    const resolveLaunch = vi.fn(async () => ({
      modelId: 'wework-selected',
      proxyToken: 'token-model-a',
      baseUrl: 'http://127.0.0.1:1234/v1/harness-router/token-model-a',
      env: {},
    }))
    const api: CoreDshModelSyncApi = {
      resolveLaunch,
      unregisterProxy: vi.fn(async () => undefined),
      request: vi.fn(async method => {
        if (method === 'settings.describe') {
          return {
            namespaces: [
              { ns: 'llm-pi-ai', user: {} },
              { ns: 'agent-default-model', user: {} },
            ],
          }
        }
        if (method === 'settings.mutate') return {}
        throw new Error(`Unexpected method: ${method}`)
      }),
    }

    await scheduleCoreDshModelSync({ options: [first] }, api)
    await scheduleCoreDshModelSync({ options: [first] }, api)

    expect(resolveLaunch).toHaveBeenCalledTimes(1)
  })

  test('does not write Core DSH settings when the exposed catalog is unchanged', async () => {
    const first = modelOption('model-a', 'Model A')
    const second = modelOption('model-b', 'Model B')
    const mutations: Array<Record<string, unknown>> = []
    const resolveLaunch = vi.fn(async option => ({
      modelId: 'wework-selected',
      proxyToken: `token-${option.key}`,
      baseUrl: `http://127.0.0.1:1234/v1/harness-router/token-${option.key}`,
      env: {},
    }))
    const api: CoreDshModelSyncApi = {
      resolveLaunch,
      unregisterProxy: vi.fn(async () => undefined),
      request: vi.fn(async (method, payload) => {
        if (method === 'settings.describe') {
          return {
            namespaces: [
              { ns: 'llm-pi-ai', user: {} },
              { ns: 'agent-default-model', user: {} },
            ],
          }
        }
        if (method === 'settings.mutate') {
          mutations.push(payload)
          return {}
        }
        throw new Error(`Unexpected method: ${method}`)
      }),
    }

    await scheduleCoreDshModelSync({ options: [first, second] }, api)
    const mutationCount = mutations.length
    await scheduleCoreDshModelSync({ options: [first, second] }, api)

    expect(resolveLaunch).toHaveBeenCalledTimes(2)
    expect(mutations).toHaveLength(mutationCount)
  })

  test('keeps a stable proxy token when a model profile is refreshed', async () => {
    const unregisterProxy = vi.fn(async () => undefined)
    const api: CoreDshModelSyncApi = {
      resolveLaunch: vi.fn(async () => ({
        modelId: 'wework-selected',
        proxyToken: 'stable-token',
        baseUrl: 'http://127.0.0.1:1234/v1/harness-router/stable-token',
        env: {},
      })),
      unregisterProxy,
      request: vi.fn(async method => {
        if (method === 'settings.describe') {
          return {
            namespaces: [{ ns: 'llm-pi-ai', user: {} }],
          }
        }
        if (method === 'settings.mutate') return {}
        throw new Error(`Unexpected method: ${method}`)
      }),
    }

    await syncCoreDshModels({ options: [modelOption('model-a', 'Model A')] }, api)
    await syncCoreDshModels({ options: [modelOption('model-a', 'Renamed Model A')] }, api)

    expect(unregisterProxy).not.toHaveBeenCalled()
  })
})
