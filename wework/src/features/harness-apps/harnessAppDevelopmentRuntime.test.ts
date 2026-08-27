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
  registerTab: vi.fn(),
  unregisterTab: vi.fn(),
  storeProxyToken: vi.fn(),
  storeContextToken: vi.fn(),
  takeProxyToken: vi.fn(),
  takeContextToken: vi.fn(),
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
  registerHarnessAppTab: mocks.registerTab,
  unregisterHarnessAppTab: mocks.unregisterTab,
  storeHarnessAppProxyToken: mocks.storeProxyToken,
  storeHarnessAppContextToken: mocks.storeContextToken,
  takeHarnessAppProxyToken: mocks.takeProxyToken,
  takeHarnessAppContextToken: mocks.takeContextToken,
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
    mocks.takeProxyToken.mockResolvedValue(null)
    mocks.takeContextToken.mockResolvedValue(null)
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
    expect(mocks.start).toHaveBeenCalledWith(installation.id, 'http://127.0.0.1:41000')
    expect(mocks.storeProxyToken).toHaveBeenCalledWith(installation.id, 'proxy-token')
  })

  test('still starts a blank workbench without a model when Wework has none configured', async () => {
    await startHarnessAppDevelopmentRuntime({
      installation,
      modelOptions: [],
      localHarnessModelApi: undefined,
      missingWebUrlMessage: 'missing URL',
    })

    expect(mocks.start).toHaveBeenCalledWith(installation.id, null)
  })

  test('releases Wework model registrations when stopping', async () => {
    const unregisterProxy = vi.fn().mockResolvedValue(undefined)
    const unregisterContext = vi.fn().mockResolvedValue(undefined)
    mocks.takeProxyToken.mockResolvedValue('proxy-token')
    mocks.takeContextToken.mockResolvedValue('context-token')

    await stopHarnessAppDevelopmentRuntime(installation.id, {
      resolveLaunch: vi.fn(),
      unregisterProxy,
      unregisterContext,
    })

    expect(unregisterProxy).toHaveBeenCalledWith('proxy-token')
    expect(unregisterContext).toHaveBeenCalledWith('context-token')
  })
})
