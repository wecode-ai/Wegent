import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import type { UnifiedModel } from '@/types/api'
import { useHarnessAppManagement } from './useHarnessAppManagement'

const mocks = vi.hoisted(() => ({
  api: {
    stop: vi.fn(),
    update: vi.fn(),
  },
  closeTab: vi.fn(),
  openTab: vi.fn(),
  register: vi.fn(),
  takeContextToken: vi.fn(),
  takeProxyToken: vi.fn(),
  unregister: vi.fn(),
  unregisterContext: vi.fn(),
  unregisterProxy: vi.fn(),
}))

vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: mocks.api,
}))

vi.mock('./harnessAppTabs', async importOriginal => {
  const original = await importOriginal<typeof import('./harnessAppTabs')>()
  return {
    ...original,
    openHarnessAppTab: mocks.openTab,
    registerHarnessAppTab: mocks.register,
    takeHarnessAppContextToken: mocks.takeContextToken,
    takeHarnessAppProxyToken: mocks.takeProxyToken,
    unregisterHarnessAppTab: mocks.unregister,
  }
})

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
        unregisterProxy: mocks.unregisterProxy,
        unregisterContext: mocks.unregisterContext,
      },
    },
  }),
}))

const workspaceTabs = {
  tabs: [] as Array<{ id: string; contentRoute: string }>,
  closeTab: mocks.closeTab,
}

vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', () => ({
  useWorkspaceTabs: () => workspaceTabs,
}))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

const installed: HarnessAppInstallation = {
  id: 'smart-app-1',
  manifest: {
    name: 'smart-app-1',
    displayName: 'Smart app 1',
    version: '1.0.0',
    type: 'deepseek-harness-plugin-bundle',
    description: 'Test app',
    entry: { installPackage: 'packages/app', profile: 'default' },
    requirements: { dsh: '>=0.1.0', node: '>=22' },
  },
  packagePath: '/tmp/smart-app-1',
  sha256: 'hash',
  modelKey: 'wework:runtime:::local-model%3Amodel-1',
  resident: false,
  runtimeVersion: null,
  state: 'installed',
  webUrl: null,
  error: null,
  source: 'managed',
}

const running: HarnessAppInstallation = {
  ...installed,
  state: 'running',
  webUrl: 'http://127.0.0.1:39000/',
}

describe('useHarnessAppManagement', () => {
  const onBusyChange = vi.fn()
  const onError = vi.fn()
  const onRefresh = vi.fn()

  beforeEach(() => {
    Object.values(mocks.api).forEach(mock => mock.mockReset())
    mocks.closeTab.mockReset()
    mocks.openTab.mockReset()
    mocks.register.mockReset()
    mocks.takeContextToken.mockReset().mockResolvedValue(null)
    mocks.takeProxyToken.mockReset().mockResolvedValue(null)
    mocks.unregister.mockReset()
    mocks.unregisterContext.mockReset()
    mocks.unregisterProxy.mockReset()
    onBusyChange.mockReset()
    onError.mockReset()
    onRefresh.mockReset().mockResolvedValue(undefined)
    workspaceTabs.tabs = []
    mocks.api.stop.mockResolvedValue(undefined)
    mocks.api.update.mockResolvedValue(installed)
  })

  function renderManagement(installations: HarnessAppInstallation[] = [installed]) {
    return renderHook(() =>
      useHarnessAppManagement({ installations, onBusyChange, onError, onRefresh })
    )
  }

  test('registers running apps after the management surface loads', async () => {
    renderManagement([running])

    await waitFor(() => expect(mocks.register).toHaveBeenCalledWith(running))
  })

  test('opens an installed app through the shared workspace-tab launcher', () => {
    const { result } = renderManagement()

    act(() => result.current.start(installed))

    expect(mocks.openTab).toHaveBeenCalledWith(workspaceTabs, installed)
    expect(onError).toHaveBeenCalledWith(null)
  })

  test('stops the runtime, clears registrations, and closes its workspace tab', async () => {
    workspaceTabs.tabs = [{ id: 'app-tab', contentRoute: '/app/harness-smart-app-1' }]
    mocks.takeProxyToken.mockResolvedValue('proxy-token')
    const { result } = renderManagement([running])

    await act(async () => {
      expect(await result.current.stop(running)).toBe(true)
    })

    expect(mocks.api.stop).toHaveBeenCalledWith(running.id)
    expect(mocks.unregister).toHaveBeenCalledWith(running.id)
    expect(mocks.closeTab).toHaveBeenCalledWith('app-tab')
    expect(mocks.unregisterProxy).toHaveBeenCalledWith('proxy-token')
    expect(onRefresh).toHaveBeenCalled()
  })

  test('changes the bound model while the app is stopped', async () => {
    const { result } = renderManagement()

    await act(async () => {
      await result.current.changeModel(installed, 'next-model')
    })

    expect(mocks.api.update).toHaveBeenCalledWith(installed.id, { modelKey: 'next-model' })
    expect(onRefresh).toHaveBeenCalled()
  })
})
