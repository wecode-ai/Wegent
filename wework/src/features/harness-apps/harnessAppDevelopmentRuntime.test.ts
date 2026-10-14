import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import {
  startHarnessAppDevelopmentRuntime,
  stopHarnessAppDevelopmentRuntime,
} from './harnessAppDevelopmentRuntime'

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  resolveDecisionLaunch: vi.fn(),
  unregisterDecision: vi.fn(),
  decisionScope: vi.fn((installationId: string) => `smart-app:${installationId}:uuid`),
  registerTab: vi.fn(),
  unregisterTab: vi.fn(),
  storeProxyToken: vi.fn(),
  storeContextToken: vi.fn(),
  storeDecisionToken: vi.fn(),
  takeProxyToken: vi.fn(),
  takeContextToken: vi.fn(),
  takeDecisionToken: vi.fn(),
}))

vi.mock('@/api/local/harnessApps', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/local/harnessApps')>()
  return {
    ...actual,
    harnessAppsApi: {
      ...actual.harnessAppsApi,
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
  storeHarnessAppContextToken: mocks.storeContextToken,
  storeHarnessAppDecisionToken: mocks.storeDecisionToken,
  takeHarnessAppProxyToken: mocks.takeProxyToken,
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
    mocks.start.mockResolvedValue({
      ...installation,
      state: 'running',
      webUrl: 'http://127.0.0.1:43123/',
    })
    mocks.stop.mockResolvedValue(undefined)
    mocks.takeProxyToken.mockResolvedValue(null)
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

  test('releases Wework model registrations when stopping', async () => {
    const unregisterProxy = vi.fn().mockResolvedValue(undefined)
    const unregisterContext = vi.fn().mockResolvedValue(undefined)
    mocks.takeProxyToken.mockResolvedValue('proxy-token')
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
    expect(unregisterContext).toHaveBeenCalledWith('context-token')
    expect(mocks.unregisterDecision).toHaveBeenCalledWith('decision-token')
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
