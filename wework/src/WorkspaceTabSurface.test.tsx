import { useEffect } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceTabSurface } from './App'
import {
  beginHarnessAppLaunch,
  clearHarnessAppLaunch,
} from '@/features/harness-apps/harnessAppLaunchState'
import {
  registerHarnessAppTab,
  unregisterHarnessAppTab,
} from '@/features/harness-apps/harnessAppTabs'
import { preloadDefaultDshUiTestModules } from '@/test/setup'

const appIframeMocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  props: vi.fn(),
}))
const workbenchProviderMocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  loadTaskComposerCatalogs: vi.fn(),
  prewarm: vi.fn(),
}))
const portalOwnershipMocks = vi.hoisted(() => ({
  setActiveOwner: vi.fn(),
}))
const harnessAppLauncherMocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  requested: vi.fn(),
  registered: vi.fn(),
  started: vi.fn(),
  waitUntilReady: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}))
const runtimeEnvironmentMocks = vi.hoisted(() => ({
  electron: false,
}))

vi.mock('@/components/topnav/AppIframe', () => ({
  AppIframe: (props: { active?: boolean; embeddedBrowserLabel?: string }) => {
    appIframeMocks.props(props)
    useEffect(() => appIframeMocks.cleanup, [])
    return <div data-testid="mock-app-iframe" data-active={String(props.active)} />
  },
}))

vi.mock('@/components/topnav/TitlebarActionsPortal', () => ({
  WorkspaceTabPortalOwner: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/topnav/workspaceTabPortalOwnership', () => ({
  setActiveWorkspaceTabPortalOwner: portalOwnershipMocks.setActiveOwner,
}))

vi.mock('@/features/harness-apps/HarnessAppAutoLauncher', () => ({
  HarnessAppAutoLauncher: ({
    installationId,
    onStartupSettled,
  }: {
    installationId: string
    onStartupSettled?: (installationId: string) => void
  }) => {
    useEffect(() => {
      let cancelled = false
      harnessAppLauncherMocks.requested(installationId)
      void harnessAppLauncherMocks.waitUntilReady().then(() => {
        if (!cancelled) {
          harnessAppLauncherMocks.started(installationId)
          harnessAppLauncherMocks.registered(installationId)
          onStartupSettled?.(installationId)
        }
      })
      return () => {
        cancelled = true
        harnessAppLauncherMocks.cleanup(installationId)
      }
    }, [installationId, onStartupSettled])
    return null
  },
}))

vi.mock('@/lib/runtime-environment', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/runtime-environment')>()
  return {
    ...actual,
    isElectronRuntime: () => runtimeEnvironmentMocks.electron,
  }
})

vi.mock('@/features/workbench/WorkbenchProvider', () => ({
  WorkbenchProvider: ({
    children,
    loadTaskComposerCatalogs,
    prewarmComposerApps,
  }: {
    children: React.ReactNode
    loadTaskComposerCatalogs?: boolean
    prewarmComposerApps?: boolean
  }) => {
    workbenchProviderMocks.loadTaskComposerCatalogs(loadTaskComposerCatalogs)
    workbenchProviderMocks.prewarm(prewarmComposerApps)
    useEffect(() => workbenchProviderMocks.cleanup, [])
    return <>{children}</>
  },
}))

vi.mock('@/pages/WorkbenchPage', () => ({
  WorkbenchPage: ({
    routeActive,
    surfaceKind,
  }: {
    routeActive?: boolean
    surfaceKind?: 'task' | 'board'
  }) => (
    <div
      data-testid={`mock-workbench-${surfaceKind ?? 'legacy'}`}
      data-route-active={String(routeActive)}
    />
  ),
}))

describe('WorkspaceTabSurface', () => {
  beforeEach(async () => {
    await preloadDefaultDshUiTestModules()
  }, 60_000)

  afterEach(() => {
    appIframeMocks.cleanup.mockClear()
    appIframeMocks.props.mockClear()
    workbenchProviderMocks.cleanup.mockClear()
    workbenchProviderMocks.loadTaskComposerCatalogs.mockClear()
    workbenchProviderMocks.prewarm.mockClear()
    portalOwnershipMocks.setActiveOwner.mockClear()
    harnessAppLauncherMocks.cleanup.mockClear()
    harnessAppLauncherMocks.requested.mockClear()
    harnessAppLauncherMocks.registered.mockClear()
    harnessAppLauncherMocks.started.mockClear()
    harnessAppLauncherMocks.waitUntilReady.mockReset()
    harnessAppLauncherMocks.waitUntilReady.mockResolvedValue()
    runtimeEnvironmentMocks.electron = false
  })

  test('keeps the board workbench connected and stateful while its tab is inactive', async () => {
    const props = {
      cloudWebUrl: null,
      lifecycleStore: {} as never,
      services: {} as never,
      tab: {
        id: 'fixed-board',
        kind: 'board' as const,
        title: '项目空间',
        contentRoute: '/todo',
      },
      user: {
        id: 1,
        user_name: 'tester',
        email: 'tester@example.com',
      },
    }

    const { rerender, unmount } = render(<WorkspaceTabSurface {...props} active />)
    expect(await screen.findByTestId('mock-workbench-board')).toHaveAttribute(
      'data-route-active',
      'true'
    )
    expect(workbenchProviderMocks.loadTaskComposerCatalogs).toHaveBeenLastCalledWith(true)
    expect(workbenchProviderMocks.prewarm).toHaveBeenLastCalledWith(false)

    rerender(<WorkspaceTabSurface {...props} active={false} />)

    expect(screen.getByTestId('workspace-tab-content-fixed-board')).toHaveClass('hidden')
    expect(screen.getByTestId('workspace-tab-content-fixed-board')).not.toHaveClass(
      'invisible',
      'pointer-events-none'
    )
    expect(screen.getByTestId('mock-workbench-board')).toHaveAttribute('data-route-active', 'false')
    expect(workbenchProviderMocks.cleanup).not.toHaveBeenCalled()

    unmount()
    expect(workbenchProviderMocks.cleanup).toHaveBeenCalledTimes(1)
  })

  test('keeps composer catalogs loaded when a retained board tab displays an auxiliary page', async () => {
    const defaultRuntime = window.__WEWORK_DSH_UI__
    const routes = [
      {
        id: 'board-auxiliary-catalog-test',
        path: '/board-auxiliary-catalog-test',
        telemetryFeature: 'apps',
      },
    ]
    window.__WEWORK_DSH_UI__ = {
      getEntries: slot =>
        slot === 'wework.route' ? routes : (defaultRuntime?.getEntries(slot) ?? []),
      subscribe: defaultRuntime?.subscribe ?? (() => () => undefined),
      attach(slot, id, container) {
        if (slot === 'wework.route' && id === 'board-auxiliary-catalog-test') {
          const page = document.createElement('div')
          page.dataset.testid = 'mock-board-auxiliary-page'
          container.append(page)
          return {
            update: () => undefined,
            dispose: () => page.remove(),
          }
        }
        return {
          update: () => undefined,
          dispose: () => undefined,
        }
      },
    }
    const props = {
      active: true,
      cloudWebUrl: null,
      lifecycleStore: {} as never,
      nativeWorkbenchKind: 'board' as const,
      services: {} as never,
      tab: {
        id: 'fixed-board',
        kind: 'board' as const,
        title: '项目空间',
        contentRoute: '/todo',
      },
      user: {
        id: 1,
        user_name: 'tester',
        email: 'tester@example.com',
      },
    }

    const { rerender, unmount } = render(<WorkspaceTabSurface {...props} />)
    await screen.findByTestId('mock-workbench-board')
    expect(workbenchProviderMocks.loadTaskComposerCatalogs).toHaveBeenLastCalledWith(true)

    rerender(
      <WorkspaceTabSurface
        {...props}
        tab={{ ...props.tab, contentRoute: '/board-auxiliary-catalog-test' }}
      />
    )

    expect(screen.getByTestId('mock-board-auxiliary-page')).toBeInTheDocument()
    expect(workbenchProviderMocks.loadTaskComposerCatalogs.mock.calls).toEqual([[true], [true]])
    expect(workbenchProviderMocks.cleanup).not.toHaveBeenCalled()

    unmount()
    window.__WEWORK_DSH_UI__ = defaultRuntime
  })

  test('shows an unavailable route instead of degrading a removed plugin route to the task workbench', () => {
    const defaultRuntime = window.__WEWORK_DSH_UI__
    let routes = [
      {
        id: 'removed-plugin-route',
        path: '/removed-plugin-route',
        telemetryFeature: 'apps',
      },
    ]
    const listeners = new Set<() => void>()
    window.__WEWORK_DSH_UI__ = {
      getEntries: slot =>
        slot === 'wework.route' ? routes : (defaultRuntime?.getEntries(slot) ?? []),
      subscribe(slot, listener) {
        if (slot !== 'wework.route') return defaultRuntime?.subscribe(slot, listener) ?? (() => {})
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      attach(slot, id, container) {
        if (slot === 'wework.route' && id === 'removed-plugin-route') {
          const page = document.createElement('div')
          page.dataset.testid = 'removed-plugin-page'
          container.append(page)
          return {
            update: () => undefined,
            dispose: () => page.remove(),
          }
        }
        return {
          update: () => undefined,
          dispose: () => undefined,
        }
      },
    }
    const props = {
      active: true,
      cloudWebUrl: null,
      lifecycleStore: {} as never,
      services: {} as never,
      tab: {
        id: 'removed-plugin-tab',
        kind: 'auxiliary' as const,
        title: 'Removed plugin',
        contentRoute: '/removed-plugin-route',
      },
      user: {
        id: 1,
        user_name: 'tester',
        email: 'tester@example.com',
      },
    }

    const { unmount } = render(<WorkspaceTabSurface {...props} />)
    expect(screen.getByTestId('removed-plugin-page')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-route-unavailable')).not.toBeInTheDocument()

    act(() => {
      routes = []
      for (const listener of listeners) listener()
    })

    expect(screen.queryByTestId('removed-plugin-page')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-route-unavailable')).toHaveTextContent(
      '提供此页面的插件可能已停用或卸载'
    )
    expect(screen.queryByTestId('mock-workbench-task')).not.toBeInTheDocument()

    unmount()
    window.__WEWORK_DSH_UI__ = defaultRuntime
  })

  test('keeps an inactive iframe app connected so its page state survives tab switches', () => {
    registerHarnessAppTab({
      id: 'stateful',
      webUrl: 'http://localhost:3000',
      manifest: {
        displayName: 'Stateful Harness',
        description: 'Stateful Harness',
      },
    } as never)
    const props = {
      cloudWebUrl: null,
      lifecycleStore: {} as never,
      services: {} as never,
      tab: {
        id: 'smart-app-1',
        kind: 'auxiliary' as const,
        title: 'Stateful Harness',
        contentRoute: '/app/harness-stateful',
      },
      user: {
        id: 1,
        user_name: 'tester',
        email: 'tester@example.com',
      },
    }

    const { rerender, unmount } = render(<WorkspaceTabSurface {...props} active />)
    expect(screen.getByTestId('mock-app-iframe')).toHaveAttribute('data-active', 'true')

    rerender(<WorkspaceTabSurface {...props} active={false} />)

    expect(screen.getByTestId('mock-app-iframe')).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('workspace-tab-content-smart-app-1')).toHaveClass('hidden')
    expect(screen.getByTestId('workspace-tab-content-smart-app-1')).not.toHaveClass(
      'invisible',
      'pointer-events-none'
    )
    expect(appIframeMocks.cleanup).not.toHaveBeenCalled()

    unmount()
    expect(appIframeMocks.cleanup).toHaveBeenCalledTimes(1)
    unregisterHarnessAppTab('stateful')
  })

  test('re-syncs titlebar portal ownership when a retained workspace becomes active again', () => {
    registerHarnessAppTab({
      id: 'titlebar',
      webUrl: 'http://localhost:3000',
      manifest: {
        displayName: 'Titlebar Harness',
        description: 'Titlebar Harness',
      },
    } as never)
    const props = {
      cloudWebUrl: null,
      lifecycleStore: {} as never,
      services: {} as never,
      tab: {
        id: 'smart-app-tab-1',
        kind: 'auxiliary' as const,
        title: 'Titlebar Harness',
        contentRoute: '/app/harness-titlebar',
      },
      user: {
        id: 1,
        user_name: 'tester',
        email: 'tester@example.com',
      },
    }

    const { rerender, unmount } = render(<WorkspaceTabSurface {...props} active={false} />)
    expect(portalOwnershipMocks.setActiveOwner).not.toHaveBeenCalled()

    rerender(<WorkspaceTabSurface {...props} active />)

    expect(portalOwnershipMocks.setActiveOwner).toHaveBeenLastCalledWith('smart-app-tab-1')
    unmount()
    unregisterHarnessAppTab('titlebar')
  })

  test('renders the launch surface when a running Harness app opens directly as an iframe', () => {
    const installationId = 'running-app'
    registerHarnessAppTab({
      id: installationId,
      webUrl: 'http://localhost:3000',
      manifest: {
        displayName: 'Running app',
        description: 'Running app',
      },
    } as never)
    beginHarnessAppLaunch(installationId, 'Running app', vi.fn(), 'loadingApp')

    const { unmount } = render(
      <WorkspaceTabSurface
        active
        cloudWebUrl={null}
        lifecycleStore={{} as never}
        services={{} as never}
        tab={{
          id: 'running-app-tab',
          kind: 'auxiliary',
          title: 'Running app',
          contentRoute: `/app/harness-${installationId}`,
        }}
        user={{
          id: 1,
          user_name: 'tester',
          email: 'tester@example.com',
        }}
      />
    )

    expect(screen.getByTestId(`harness-app-launch-${installationId}`)).toBeInTheDocument()

    unmount()
    clearHarnessAppLaunch(installationId)
    unregisterHarnessAppTab(installationId)
  })

  test('does not render an unavailable route before Smart app startup establishes launch state', () => {
    const installationId = 'initially-empty-launch'
    runtimeEnvironmentMocks.electron = true
    harnessAppLauncherMocks.waitUntilReady.mockReturnValue(new Promise(() => undefined))

    const { unmount } = render(
      <WorkspaceTabSurface
        active
        cloudWebUrl={null}
        lifecycleStore={{} as never}
        services={{} as never}
        smartAppsEnabled
        tab={{
          id: 'initially-empty-launch-tab',
          kind: 'auxiliary',
          title: 'Initially empty launch',
          contentRoute: `/app/harness-${installationId}`,
        }}
        user={{ id: 1, user_name: 'tester', email: 'tester@example.com' }}
      />
    )

    expect(harnessAppLauncherMocks.requested).toHaveBeenCalledWith(installationId)
    expect(screen.queryByTestId('workspace-route-unavailable')).not.toBeInTheDocument()
    unmount()
    harnessAppLauncherMocks.cleanup.mockClear()
  })

  test('keeps an Electron Harness app launch connected while its tab is inactive', async () => {
    const installationId = 'launching-app'
    runtimeEnvironmentMocks.electron = true
    let finishLaunch: (() => void) | undefined
    harnessAppLauncherMocks.waitUntilReady.mockImplementation(
      () =>
        new Promise(resolve => {
          finishLaunch = resolve
        })
    )
    beginHarnessAppLaunch(installationId, 'Launching app', vi.fn(), 'loadingApp')
    const props = {
      cloudWebUrl: null,
      lifecycleStore: {} as never,
      services: {} as never,
      smartAppsEnabled: true,
      tab: {
        id: 'launching-app-tab',
        kind: 'auxiliary' as const,
        title: 'Launching app',
        contentRoute: `/app/harness-${installationId}`,
      },
      user: {
        id: 1,
        user_name: 'tester',
        email: 'tester@example.com',
      },
    }

    const { rerender, unmount } = render(<WorkspaceTabSurface {...props} active />)
    expect(harnessAppLauncherMocks.requested).toHaveBeenCalledWith(installationId)

    rerender(<WorkspaceTabSurface {...props} active={false} />)

    expect(screen.getByTestId(`workspace-tab-content-${props.tab.id}`)).toHaveClass('hidden')
    expect(screen.getByTestId(`workspace-tab-content-${props.tab.id}`)).not.toHaveClass(
      'invisible',
      'pointer-events-none'
    )
    expect(harnessAppLauncherMocks.cleanup).not.toHaveBeenCalled()

    finishLaunch?.()
    await waitFor(() => {
      expect(harnessAppLauncherMocks.started).toHaveBeenCalledWith(installationId)
      expect(harnessAppLauncherMocks.registered).toHaveBeenCalledWith(installationId)
    })

    unmount()
    expect(harnessAppLauncherMocks.cleanup).toHaveBeenCalledWith(installationId)
    clearHarnessAppLaunch(installationId)
  })

  test('renders a running Electron Harness app through the DOM webview host', () => {
    const installationId = 'dom-webview-app'
    runtimeEnvironmentMocks.electron = true
    registerHarnessAppTab({
      id: installationId,
      manifest: {
        name: installationId,
        displayName: 'DOM Webview App',
        version: '0.1.0',
        type: 'deepseek-harness-plugin-bundle',
        description: '',
        entry: { installPackage: '.', profile: 'default' },
        requirements: { dsh: '0.1.0-rc.8', node: '>=20' },
      },
      packagePath: '/tmp/dom-webview-app',
      sha256: 'fixture',
      modelKey: null,
      resident: false,
      runtimeVersion: '0.1.0-rc.8',
      state: 'running',
      webUrl: 'http://127.0.0.1:4101',
      error: null,
      source: 'linked',
    })

    const { unmount } = render(
      <WorkspaceTabSurface
        active
        cloudWebUrl={null}
        lifecycleStore={{} as never}
        services={{} as never}
        tab={{
          id: 'dom-webview-tab',
          kind: 'auxiliary',
          title: 'DOM Webview App',
          contentRoute: `/app/harness-${installationId}`,
        }}
        user={{ id: 1, user_name: 'tester', email: 'tester@example.com' }}
      />
    )

    expect(screen.getByTestId('mock-app-iframe')).toHaveAttribute('data-active', 'true')
    expect(appIframeMocks.props).toHaveBeenCalledWith(
      expect.objectContaining({
        appKey: `harness-${installationId}`,
        embeddedBrowserLabel: `smart-app:${installationId}`,
        src: 'http://127.0.0.1:4101',
      })
    )
    unmount()
    unregisterHarnessAppTab(installationId)
  })
})
