import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import type { UnifiedModel } from '@/types/api'
import { useHarnessAppManagement } from './useHarnessAppManagement'
import { runHarnessAppRuntimeOperation } from './harnessAppRuntimeOperations'
import { clearHarnessAppLaunch, useHarnessAppLaunchState } from './harnessAppLaunchState'

const mocks = vi.hoisted(() => ({
  api: {
    stop: vi.fn(),
    update: vi.fn(),
  },
  closeTab: vi.fn(),
  openTab: vi.fn(),
  register: vi.fn(),
  takeContextToken: vi.fn(),
  takeDecisionToken: vi.fn(),
  takeProxyToken: vi.fn(),
  takeAdditionalProxyTokens: vi.fn(),
  unregisterDecision: vi.fn(),
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
    takeHarnessAppDecisionToken: mocks.takeDecisionToken,
    takeHarnessAppProxyToken: mocks.takeProxyToken,
    takeHarnessAppAdditionalProxyTokens: mocks.takeAdditionalProxyTokens,
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
      localDecisionRouterApi: {
        unregister: mocks.unregisterDecision,
      },
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
    mocks.takeDecisionToken.mockReset().mockResolvedValue(null)
    mocks.takeProxyToken.mockReset().mockResolvedValue(null)
    mocks.takeAdditionalProxyTokens.mockReset().mockResolvedValue([])
    mocks.unregisterDecision.mockReset().mockResolvedValue(undefined)
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

  test('does not publish a running host snapshot during token handoff or queued close', async () => {
    let release: () => void = () => {}
    const handoff = runHarnessAppRuntimeOperation(
      running.id,
      () =>
        new Promise<void>(resolve => {
          release = resolve
        })
    )
    const close = runHarnessAppRuntimeOperation(running.id, async () => undefined)
    await Promise.resolve()
    const view = renderManagement([running])
    try {
      expect(mocks.register).not.toHaveBeenCalled()
      act(() => view.result.current.open(running))
      expect(mocks.openTab).toHaveBeenCalledWith(workspaceTabs, running)
      expect(mocks.register).not.toHaveBeenCalled()
      const launch = renderHook(() => useHarnessAppLaunchState(running.id))
      expect(launch.result.current?.status).toBe('starting')
      act(() => launch.result.current!.retry())
      expect(mocks.register).not.toHaveBeenCalled()
      expect(mocks.openTab).toHaveBeenCalledTimes(2)
      launch.unmount()
    } finally {
      view.unmount()
      await act(async () => {
        release()
        await handoff
        await close
        clearHarnessAppLaunch(running.id)
      })
    }
    renderManagement([running])
    expect(mocks.register).toHaveBeenCalledWith(running)
  })

  test('opens an installed app through the shared workspace-tab launcher', () => {
    const { result } = renderManagement()

    act(() => result.current.start(installed))

    expect(mocks.openTab).toHaveBeenCalledWith(workspaceTabs, installed)
    expect(onError).toHaveBeenCalledWith(null)
  })

  test('discards a stale running registration before starting a stopped app again', async () => {
    const tabs = await vi.importActual<typeof import('./harnessAppTabs')>('./harnessAppTabs')
    // A retained management surface can publish its old running snapshot when
    // reconnected, before its refresh reports that the previous runtime stopped.
    mocks.register.mockImplementation(tabs.registerHarnessAppTab)
    mocks.unregister.mockImplementation(tabs.unregisterHarnessAppTab)
    const view = renderHook(
      ({ installations }) =>
        useHarnessAppManagement({ installations, onBusyChange, onError, onRefresh }),
      { initialProps: { installations: [running] } }
    )
    try {
      expect(tabs.resolveRunningHarnessApp(`harness-${installed.id}`)?.url).toBe(running.webUrl)
      view.rerender({ installations: [installed] })

      act(() => view.result.current.start(installed))

      expect(mocks.openTab).toHaveBeenCalledWith(workspaceTabs, installed)
      expect(tabs.resolveRunningHarnessApp(`harness-${installed.id}`)).toBeNull()
      expect(mocks.unregister.mock.invocationCallOrder[0]!).toBeLessThan(
        mocks.openTab.mock.invocationCallOrder[0]!
      )
    } finally {
      view.unmount()
      tabs.unregisterHarnessAppTab(installed.id)
    }
  })

  test('does not revoke a running app registration when selecting its existing tab', () => {
    const { result } = renderManagement([running])

    act(() => result.current.start(running))

    expect(mocks.unregister).not.toHaveBeenCalled()
    expect(mocks.openTab).toHaveBeenCalledWith(workspaceTabs, running)
  })

  test('does not revoke an active launch from a stale installed management snapshot', async () => {
    const tabs = await vi.importActual<typeof import('./harnessAppTabs')>('./harnessAppTabs')
    tabs.registerHarnessAppTab(running)
    mocks.unregister.mockImplementation(tabs.unregisterHarnessAppTab)
    let release: () => void = () => {}
    const handoff = runHarnessAppRuntimeOperation(
      installed.id,
      () =>
        new Promise<void>(resolve => {
          release = resolve
        })
    )
    await Promise.resolve()
    const { result, unmount } = renderManagement()
    try {
      act(() => result.current.start(installed))

      expect(tabs.resolveRunningHarnessApp(`harness-${installed.id}`)?.url).toBe(running.webUrl)
      expect(mocks.unregister).not.toHaveBeenCalled()
      expect(mocks.openTab).toHaveBeenCalledWith(workspaceTabs, installed)
    } finally {
      unmount()
      release()
      await handoff
      tabs.unregisterHarnessAppTab(installed.id)
    }
  })

  test('preserves an existing app tab when the management snapshot still says installed', async () => {
    const tabs = await vi.importActual<typeof import('./harnessAppTabs')>('./harnessAppTabs')
    tabs.registerHarnessAppTab(running)
    mocks.unregister.mockImplementation(tabs.unregisterHarnessAppTab)
    workspaceTabs.tabs = [
      { id: 'running-app-tab', contentRoute: tabs.harnessAppRoute(installed.id) },
    ]
    const { result, unmount } = renderManagement()
    try {
      act(() => result.current.start(installed))

      expect(tabs.resolveRunningHarnessApp(`harness-${installed.id}`)?.url).toBe(running.webUrl)
      expect(mocks.unregister).not.toHaveBeenCalled()
      expect(mocks.openTab).toHaveBeenCalledWith(workspaceTabs, installed)
    } finally {
      unmount()
      tabs.unregisterHarnessAppTab(installed.id)
    }
  })

  test('stops the runtime, clears registrations, and closes its workspace tab', async () => {
    workspaceTabs.tabs = [{ id: 'app-tab', contentRoute: '/app/harness-smart-app-1' }]
    mocks.takeProxyToken.mockResolvedValue('proxy-token')
    mocks.takeAdditionalProxyTokens.mockResolvedValue(['second-token'])
    const { result } = renderManagement([running])

    await act(async () => {
      expect(await result.current.stop(running)).toBe(true)
    })

    expect(mocks.api.stop).toHaveBeenCalledWith(running.id)
    expect(mocks.unregister).toHaveBeenCalledWith(running.id)
    expect(mocks.closeTab).toHaveBeenCalledWith('app-tab')
    expect(mocks.unregisterProxy).toHaveBeenCalledWith('proxy-token')
    expect(mocks.unregisterProxy).toHaveBeenCalledWith('second-token')
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

  test('releases the decision route when the app stops', async () => {
    mocks.takeDecisionToken.mockResolvedValue('decision-token')
    const { result } = renderManagement([running])

    await act(async () => {
      expect(await result.current.stop(running)).toBe(true)
    })

    expect(mocks.takeDecisionToken).toHaveBeenCalledWith(running.id)
    expect(mocks.unregisterDecision).toHaveBeenCalledWith('decision-token')
  })

  test('still releases the other routes when one unregister fails', async () => {
    mocks.takeProxyToken.mockResolvedValue('proxy-token')
    mocks.takeContextToken.mockResolvedValue('context-token')
    mocks.takeDecisionToken.mockResolvedValue('decision-token')
    mocks.unregisterProxy.mockRejectedValue(new Error('proxy route already gone'))
    const { result } = renderManagement([running])

    await act(async () => {
      expect(await result.current.stop(running)).toBe(true)
    })

    expect(mocks.unregisterProxy).toHaveBeenCalledWith('proxy-token')
    expect(mocks.unregisterContext).toHaveBeenCalledWith('context-token')
    expect(mocks.unregisterDecision).toHaveBeenCalledWith('decision-token')
    expect(onRefresh).toHaveBeenCalled()
  })
})
