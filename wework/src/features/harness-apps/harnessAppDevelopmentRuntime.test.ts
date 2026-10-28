import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import {
  startHarnessAppDevelopmentRuntime,
  stopHarnessAppDevelopmentRuntime,
} from './harnessAppDevelopmentRuntime'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  resolveDecisionLaunch: vi.fn(),
  unregisterDecision: vi.fn(),
  decisionScope: vi.fn((installationId: string) => `smart-app:${installationId}:uuid`),
  registerTab: vi.fn(),
  unregisterTab: vi.fn(),
  storeProxyToken: vi.fn(),
  storeAdditionalProxyTokens: vi.fn(),
  storeContextToken: vi.fn(),
  storeDecisionToken: vi.fn(),
  takeProxyToken: vi.fn(),
  takeAdditionalProxyTokens: vi.fn(),
  takeContextToken: vi.fn(),
  takeDecisionToken: vi.fn(),
}))

vi.mock('@/api/local/harnessApps', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/local/harnessApps')>()
  return {
    ...actual,
    harnessAppsApi: {
      ...actual.harnessAppsApi,
      list: mocks.list,
      start: mocks.start,
      stop: mocks.stop,
    },
  }
})

vi.mock('./harnessAppTabs', () => ({
  harnessAppDecisionScope: mocks.decisionScope,
  registerHarnessAppTab: mocks.registerTab,
  unregisterHarnessAppTab: mocks.unregisterTab,
  storeHarnessAppProxyToken: mocks.storeProxyToken,
  storeHarnessAppAdditionalProxyTokens: mocks.storeAdditionalProxyTokens,
  storeHarnessAppContextToken: mocks.storeContextToken,
  storeHarnessAppDecisionToken: mocks.storeDecisionToken,
  takeHarnessAppProxyToken: mocks.takeProxyToken,
  takeHarnessAppAdditionalProxyTokens: mocks.takeAdditionalProxyTokens,
  takeHarnessAppContextToken: mocks.takeContextToken,
  takeHarnessAppDecisionToken: mocks.takeDecisionToken,
}))

const installation: HarnessAppInstallation = {
  id: 'blank-workbench',
  manifest: {
    name: 'blank-workbench',
    displayName: '空白工作台',
    version: '0.1.0',
    type: 'deepseek-harness-plugin-bundle',
    description: 'Web preset',
    entry: {
      installPackage: 'packages/bundle/blank-workbench',
      profile: 'web',
    },
    requirements: { dsh: '0.1.0-rc.8', node: '>=22' },
  },
  packagePath: '/tmp/blank-workbench',
  sha256: 'a'.repeat(64),
  modelKey: null,
  resident: false,
  runtimeVersion: null,
  state: 'installed',
  webUrl: null,
  error: null,
  source: 'linked',
  grantedCapabilities: { decisionModel: false },
}

const modelOption = {
  key: 'wework:runtime:::local-model',
  label: 'Wework Model',
  source: 'local',
  model: {
    name: 'local-model',
    type: 'runtime',
    provider: 'local',
    displayName: 'Wework Model',
    modelId: 'local-model',
    config: { weworkModelKind: 'model-interface' },
  },
  options: {},
} satisfies LocalHarnessModelOption

describe('harnessAppDevelopmentRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.list.mockResolvedValue([installation])
    mocks.start.mockResolvedValue({
      ...installation,
      state: 'running',
      webUrl: 'http://127.0.0.1:43123/',
    })
    mocks.stop.mockResolvedValue(undefined)
    mocks.takeProxyToken.mockResolvedValue(null)
    mocks.takeAdditionalProxyTokens.mockResolvedValue([])
    mocks.takeContextToken.mockResolvedValue(null)
    mocks.takeDecisionToken.mockResolvedValue(null)
    mocks.resolveDecisionLaunch.mockResolvedValue({
      token: 'decision-token',
      baseUrl: 'http://127.0.0.1:9500/v1/decision-router/decision-token',
      protocolVersion: 1,
    })
    mocks.unregisterDecision.mockResolvedValue(undefined)
  })

  test('uses the first available Wework model for an unbound blank workbench', async () => {
    const resolveLaunch = vi.fn().mockResolvedValue({
      modelId: 'wework-messages/wework-selected',
      env: {},
      proxyToken: 'proxy-token',
      baseUrl: 'http://127.0.0.1:41000',
    })

    await startHarnessAppDevelopmentRuntime({
      installation,
      modelOptions: [modelOption],
      localHarnessModelApi: {
        resolveLaunch,
        unregisterProxy: vi.fn(),
        unregisterContext: vi.fn(),
      },
      missingWebUrlMessage: 'missing URL',
    })

    expect(resolveLaunch).toHaveBeenCalledWith('opencode', modelOption)
    expect(mocks.start).toHaveBeenCalledWith({
      installationId: installation.id,
      modelBaseUrl: 'http://127.0.0.1:41000',
      contextBaseUrl: null,
      contextToken: null,
      decisionBaseUrl: null,
      decisionProtocolVersion: null,
    })
    expect(mocks.storeProxyToken).toHaveBeenCalledWith(installation.id, 'proxy-token')
  })

  test('registers other available models as separate routes', async () => {
    const secondModel = { ...modelOption, key: 'second-model', label: 'Second model' }
    const resolveLaunch = vi
      .fn()
      .mockResolvedValueOnce({ proxyToken: 'default-token', baseUrl: 'http://127.0.0.1:41000' })
      .mockResolvedValueOnce({ proxyToken: 'second-token', baseUrl: 'http://127.0.0.1:41001' })

    await startHarnessAppDevelopmentRuntime({
      installation,
      modelOptions: [modelOption, secondModel],
      localHarnessModelApi: {
        resolveLaunch,
        unregisterProxy: vi.fn(),
        unregisterContext: vi.fn(),
      },
      missingWebUrlMessage: 'missing URL',
    })

    expect(resolveLaunch).toHaveBeenNthCalledWith(1, 'opencode', modelOption)
    expect(resolveLaunch).toHaveBeenNthCalledWith(2, 'opencode', secondModel, undefined, false)
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalModels: [
          {
            modelKey: 'second-model',
            displayName: 'Second model',
            baseUrl: 'http://127.0.0.1:41001',
          },
        ],
      })
    )
    expect(mocks.storeAdditionalProxyTokens).toHaveBeenCalledWith(installation.id, ['second-token'])
  })

  test('still starts a blank workbench without a model when Wework has none configured', async () => {
    await startHarnessAppDevelopmentRuntime({
      installation,
      modelOptions: [],
      localHarnessModelApi: undefined,
      missingWebUrlMessage: 'missing URL',
    })

    expect(mocks.start).toHaveBeenCalledWith({
      installationId: installation.id,
      modelBaseUrl: null,
      contextBaseUrl: null,
      contextToken: null,
      decisionBaseUrl: null,
      decisionProtocolVersion: null,
    })
  })

  test('releases stored routes using their local handles when host token reads fail', async () => {
    const secondModel = { ...modelOption, key: 'second-model', label: 'Second model' }
    const unregisterProxy = vi.fn().mockResolvedValue(undefined)
    const unregisterContext = vi.fn().mockResolvedValue(undefined)
    const resolveLaunch = vi
      .fn()
      .mockResolvedValueOnce({
        proxyToken: 'default-token',
        baseUrl: 'http://127.0.0.1:41000',
        context: { token: 'context-token', baseUrl: 'http://127.0.0.1:41002' },
      })
      .mockResolvedValueOnce({
        proxyToken: 'second-token',
        baseUrl: 'http://127.0.0.1:41001',
      })
    mocks.storeContextToken.mockRejectedValueOnce(new Error('Context token store failed'))
    mocks.takeProxyToken.mockRejectedValueOnce(new Error('Default token read failed'))
    mocks.takeAdditionalProxyTokens.mockRejectedValueOnce(new Error('Extra token read failed'))

    await expect(
      startHarnessAppDevelopmentRuntime({
        installation,
        modelOptions: [modelOption, secondModel],
        localHarnessModelApi: { resolveLaunch, unregisterProxy, unregisterContext },
        missingWebUrlMessage: 'missing URL',
      })
    ).rejects.toThrow('Context token store failed')

    expect(mocks.storeProxyToken).toHaveBeenCalledWith(installation.id, 'default-token')
    expect(mocks.storeAdditionalProxyTokens).toHaveBeenCalledWith(installation.id, ['second-token'])
    expect(unregisterProxy).toHaveBeenCalledWith('default-token')
    expect(unregisterProxy).toHaveBeenCalledWith('second-token')
    expect(unregisterContext).toHaveBeenCalledWith('context-token')
  })

  test('serializes stop behind in-flight startup token storage', async () => {
    let releaseStore: () => void = () => {}
    mocks.storeProxyToken.mockReturnValueOnce(
      new Promise<void>(resolve => {
        releaseStore = resolve
      })
    )
    const modelApi = {
      resolveLaunch: vi.fn().mockResolvedValue({
        proxyToken: 'proxy-token',
        baseUrl: 'http://127.0.0.1:41000',
      }),
      unregisterProxy: vi.fn().mockResolvedValue(undefined),
      unregisterContext: vi.fn().mockResolvedValue(undefined),
    }
    const starting = startHarnessAppDevelopmentRuntime({
      installation,
      modelOptions: [modelOption],
      localHarnessModelApi: modelApi,
      missingWebUrlMessage: 'missing URL',
    })
    await vi.waitFor(() => expect(mocks.storeProxyToken).toHaveBeenCalled())
    const stopping = stopHarnessAppDevelopmentRuntime(installation.id, modelApi)
    try {
      await Promise.resolve()
      expect(mocks.stop).not.toHaveBeenCalled()
    } finally {
      releaseStore()
      await starting
      await stopping
    }
    expect(mocks.stop).toHaveBeenCalledWith(installation.id)
  })

  test('releases Wework model registrations when stopping', async () => {
    const unregisterProxy = vi.fn().mockResolvedValue(undefined)
    const unregisterContext = vi.fn().mockResolvedValue(undefined)
    mocks.takeProxyToken.mockResolvedValue('proxy-token')
    mocks.takeAdditionalProxyTokens.mockResolvedValue(['second-token'])
    mocks.takeContextToken.mockResolvedValue('context-token')
    mocks.takeDecisionToken.mockResolvedValue('decision-token')

    await stopHarnessAppDevelopmentRuntime(
      installation.id,
      {
        resolveLaunch: vi.fn(),
        unregisterProxy,
        unregisterContext,
      },
      {
        resolveLaunch: vi.fn(),
        unregister: mocks.unregisterDecision,
      }
    )

    expect(unregisterProxy).toHaveBeenCalledWith('proxy-token')
    expect(unregisterProxy).toHaveBeenCalledWith('second-token')
    expect(unregisterContext).toHaveBeenCalledWith('context-token')
    expect(mocks.unregisterDecision).toHaveBeenCalledWith('decision-token')
  })

  test('does not reuse a running snapshot invalidated by a queued stop', async () => {
    const staleRunning: HarnessAppInstallation = {
      ...installation,
      state: 'running',
      webUrl: 'http://127.0.0.1:40000/',
    }
    const modelApi = {
      resolveLaunch: vi.fn().mockResolvedValue({
        proxyToken: 'fresh-token',
        baseUrl: 'http://127.0.0.1:41000',
      }),
      unregisterProxy: vi.fn(),
      unregisterContext: vi.fn(),
    }
    const stopping = stopHarnessAppDevelopmentRuntime(installation.id, modelApi)
    const starting = startHarnessAppDevelopmentRuntime({
      installation: staleRunning,
      modelOptions: [modelOption],
      localHarnessModelApi: modelApi,
      missingWebUrlMessage: 'missing URL',
    })
    await stopping
    const restarted = await starting
    expect(mocks.start).toHaveBeenCalledOnce()
    expect(restarted.webUrl).not.toBe(staleRunning.webUrl)
    expect(mocks.registerTab).not.toHaveBeenCalledWith(staleRunning)
  })

  test('reuses the current running installation without allocating unused routes', async () => {
    const current: HarnessAppInstallation = {
      ...installation,
      state: 'running',
      webUrl: 'http://127.0.0.1:44000/',
    }
    mocks.list.mockResolvedValue([current])
    const modelApi = {
      resolveLaunch: vi.fn(),
      unregisterProxy: vi.fn(),
      unregisterContext: vi.fn(),
    }
    const result = await startHarnessAppDevelopmentRuntime({
      installation: { ...current, webUrl: 'http://127.0.0.1:40000/' },
      modelOptions: [modelOption],
      localHarnessModelApi: modelApi,
      missingWebUrlMessage: 'missing URL',
    })
    expect(result).toBe(current)
    expect(mocks.start).not.toHaveBeenCalled()
    expect(modelApi.resolveLaunch).not.toHaveBeenCalled()
    expect(mocks.registerTab).toHaveBeenCalledWith(current)
  })

  test('registers a decision route for a granted linked project', async () => {
    const granted = { ...installation, grantedCapabilities: { decisionModel: true } }
    const resolveLaunch = vi.fn().mockResolvedValue({
      modelId: 'wework-messages/wework-selected',
      env: {},
      proxyToken: 'proxy-token',
      baseUrl: 'http://127.0.0.1:41000',
    })

    await startHarnessAppDevelopmentRuntime({
      installation: granted,
      modelOptions: [modelOption],
      localHarnessModelApi: {
        resolveLaunch,
        unregisterProxy: vi.fn(),
        unregisterContext: vi.fn(),
      },
      localDecisionRouterApi: {
        resolveLaunch: mocks.resolveDecisionLaunch,
        unregister: mocks.unregisterDecision,
      },
      missingWebUrlMessage: 'missing URL',
    })

    expect(mocks.decisionScope).toHaveBeenCalledWith(installation.id)
    expect(mocks.resolveDecisionLaunch).toHaveBeenCalledWith(`smart-app:${installation.id}:uuid`)
    expect(mocks.start).toHaveBeenCalledWith({
      installationId: installation.id,
      modelBaseUrl: 'http://127.0.0.1:41000',
      contextBaseUrl: null,
      contextToken: null,
      decisionBaseUrl: 'http://127.0.0.1:9500/v1/decision-router/decision-token',
      decisionProtocolVersion: 1,
    })
    expect(mocks.storeDecisionToken).toHaveBeenCalledWith(installation.id, 'decision-token')
  })

  test('rolls back the decision route when the app fails after start', async () => {
    const granted = { ...installation, grantedCapabilities: { decisionModel: true } }
    mocks.start.mockResolvedValue({ ...installation, state: 'running', webUrl: null })

    await expect(
      startHarnessAppDevelopmentRuntime({
        installation: granted,
        modelOptions: [modelOption],
        localHarnessModelApi: {
          resolveLaunch: vi.fn().mockResolvedValue({
            modelId: 'wework-messages/wework-selected',
            env: {},
            proxyToken: 'proxy-token',
            baseUrl: 'http://127.0.0.1:41000',
          }),
          unregisterProxy: vi.fn().mockResolvedValue(undefined),
          unregisterContext: vi.fn().mockResolvedValue(undefined),
        },
        localDecisionRouterApi: {
          resolveLaunch: mocks.resolveDecisionLaunch,
          unregister: mocks.unregisterDecision,
        },
        missingWebUrlMessage: 'missing URL',
      })
    ).rejects.toThrow('missing URL')

    expect(mocks.stop).toHaveBeenCalledWith(installation.id)
    expect(mocks.takeDecisionToken).toHaveBeenCalledWith(installation.id)
    expect(mocks.unregisterDecision).toHaveBeenCalledWith('decision-token')
    expect(mocks.storeDecisionToken).not.toHaveBeenCalled()
  })
})
