import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import type { UnifiedModel } from '@/types/api'
import { ResidentSmartAppsManager } from './ResidentSmartAppsManager'
import { findResidentSmartAppsHostTabId } from './residentSmartAppsHost'

const mocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  list: vi.fn(),
  openTab: vi.fn(),
  register: vi.fn(),
  resolveLaunch: vi.fn(),
  proxyTokens: new Map<string, string>(),
  start: vi.fn(),
  stop: vi.fn(),
  unregister: vi.fn(),
  unregisterProxy: vi.fn(),
  unregisterContext: vi.fn(),
}))

vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: {
    list: mocks.list,
    start: mocks.start,
    stop: mocks.stop,
  },
}))

vi.mock('@/features/harness-apps/harnessAppTabs', () => ({
  takeHarnessAppProxyToken: (installationId: string) => {
    const token = mocks.proxyTokens.get(installationId) ?? null
    mocks.proxyTokens.delete(installationId)
    return token
  },
  takeHarnessAppContextToken: () => null,
  openHarnessAppTab: (_tabs: unknown, installation: HarnessAppInstallation) =>
    mocks.openTab(installation),
  registerHarnessAppTab: (installation: HarnessAppInstallation) => mocks.register(installation),
  storeHarnessAppProxyToken: (installationId: string, token: string) => {
    mocks.proxyTokens.set(installationId, token)
  },
  storeHarnessAppContextToken: () => undefined,
  unregisterHarnessAppTab: (installationId: string) => mocks.unregister(installationId),
}))

const model: UnifiedModel = {
  name: 'local-model:model-1',
  type: 'runtime',
  provider: 'local',
  displayName: 'Local Model',
  modelId: 'local-upstream',
  config: { weworkModelKind: 'model-interface' },
}

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    projectChat: { models: [model] },
    services: {
      localHarnessModelApi: {
        resolveLaunch: mocks.resolveLaunch,
        unregisterProxy: mocks.unregisterProxy,
        unregisterContext: mocks.unregisterContext,
      },
    },
  }),
}))

vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', () => ({
  useWorkspaceTabs: () => ({
    tabs: [
      {
        id: 'smart-app-tab',
        kind: 'auxiliary',
        title: 'Resident app',
        contentRoute: '/app/harness-resident-app',
      },
    ],
    closeTab: mocks.closeTab,
    openTab: vi.fn(),
    selectTab: vi.fn(),
  }),
}))

const installation: HarnessAppInstallation = {
  id: 'resident-app',
  manifest: {
    name: 'resident-app',
    displayName: 'Resident app',
    version: '0.1.0',
    type: 'deepseek-harness-plugin-bundle',
    description: 'Resident app',
    entry: {
      installPackage: 'packages/resident',
      profile: 'resident',
      webUrl: 'http://127.0.0.1:3080/',
    },
    requirements: { dsh: '0.1.0-rc.7', node: '>=22' },
  },
  packagePath: '/tmp/resident',
  sha256: 'hash',
  modelKey: 'wework:runtime:::local-model%3Amodel-1',
  resident: true,
  runtimeVersion: null,
  state: 'installed',
  webUrl: null,
  error: null,
}

describe('ResidentSmartAppsManager', () => {
  beforeEach(() => {
    Object.entries(mocks).forEach(([key, mock]) => {
      if (key !== 'proxyTokens') mock.mockReset()
    })
    mocks.proxyTokens.clear()
    mocks.list.mockResolvedValue([installation])
    mocks.resolveLaunch.mockResolvedValue({
      proxyToken: 'proxy-token',
      baseUrl: 'http://127.0.0.1:41000/v1/harness-router/proxy-token',
    })
    mocks.start.mockResolvedValue({
      ...installation,
      state: 'running',
      webUrl: 'http://127.0.0.1:39000/',
    })
    mocks.stop.mockResolvedValue(undefined)
  })

  test('hosts resident startup on a provider-backed tab instead of an app webview', () => {
    expect(
      findResidentSmartAppsHostTabId([
        { id: 'agent-app', contentRoute: '/app/wegent' },
        { id: 'applications', contentRoute: '/sites?app_type=smart_app&view=installed' },
        { id: 'smart-app', contentRoute: '/app/harness-resident-app' },
      ])
    ).toBe('applications')
  })

  test('strips the runtime base path before selecting a resident host tab', () => {
    expect(
      findResidentSmartAppsHostTabId([
        { id: 'agent-app', contentRoute: '/app/wegent' },
        { id: 'applications', contentRoute: '/sites?app_type=smart_app' },
      ])
    ).toBe('applications')
  })

  test('starts resident Smart apps and opens their workspace tabs', async () => {
    render(<ResidentSmartAppsManager enabled />)

    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        installation.id,
        'http://127.0.0.1:41000/v1/harness-router/proxy-token'
      )
    )
    expect(mocks.register).toHaveBeenCalledOnce()
    expect(mocks.openTab).toHaveBeenCalledOnce()
    expect(mocks.proxyTokens.get(installation.id)).toBe('proxy-token')
  })

  test('restores a resident app that is already running without starting it again', async () => {
    const running = {
      ...installation,
      state: 'running' as const,
      webUrl: 'http://127.0.0.1:39000/',
    }
    mocks.list.mockResolvedValue([running])

    render(<ResidentSmartAppsManager enabled />)

    await waitFor(() => expect(mocks.register).toHaveBeenCalledWith(running))
    expect(mocks.openTab).toHaveBeenCalledWith(running)
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.resolveLaunch).not.toHaveBeenCalled()
  })

  test('rolls back a resident app when its workspace tab cannot be registered', async () => {
    mocks.register.mockImplementation(() => {
      throw new Error('registration failed')
    })

    render(<ResidentSmartAppsManager enabled />)

    await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith(installation.id))
    expect(mocks.unregister).toHaveBeenCalledWith(installation.id)
    expect(mocks.unregisterProxy).toHaveBeenCalledWith('proxy-token')
    expect(mocks.proxyTokens.has(installation.id)).toBe(false)
  })

  test('stops running Smart apps and closes their tabs when experiments are disabled', async () => {
    const running = {
      ...installation,
      state: 'running' as const,
      webUrl: 'http://127.0.0.1:39000/',
    }
    mocks.list.mockResolvedValue([running])
    mocks.proxyTokens.set(installation.id, 'proxy-token')

    render(<ResidentSmartAppsManager enabled={false} />)

    await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith(installation.id))
    expect(mocks.closeTab).toHaveBeenCalledWith('smart-app-tab')
    expect(mocks.unregister).toHaveBeenCalledWith(installation.id)
    expect(mocks.unregisterProxy).toHaveBeenCalledWith('proxy-token')
    expect(mocks.start).not.toHaveBeenCalled()
  })
})
