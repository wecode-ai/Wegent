import { useEffect } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceTabSurface } from './App'
import {
  beginHarnessAppLaunch,
  clearHarnessAppLaunch,
} from '@/features/harness-apps/harnessAppLaunchState'
import { getWorkbenchPluginRuntime } from '@/plugin-runtime/bootstrap'

const appIframeMocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
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
  AppIframe: ({ active }: { active?: boolean }) => {
    useEffect(() => appIframeMocks.cleanup, [])
    return <div data-testid="mock-app-iframe" data-active={String(active)} />
  },
}))

vi.mock('@/components/topnav/TitlebarActionsPortal', () => ({
  WorkspaceTabPortalOwner: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/topnav/workspaceTabPortalOwnership', () => ({
  setActiveWorkspaceTabPortalOwner: portalOwnershipMocks.setActiveOwner,
}))

vi.mock('@/features/harness-apps/HarnessAppAutoLauncher', () => ({
  HarnessAppAutoLauncher: ({ installationId }: { installationId: string }) => {
    useEffect(() => {
      let cancelled = false
      harnessAppLauncherMocks.requested(installationId)
      void harnessAppLauncherMocks.waitUntilReady().then(() => {
        if (!cancelled) {
          harnessAppLauncherMocks.started(installationId)
          harnessAppLauncherMocks.registered(installationId)
        }
      })
      return () => {
        cancelled = true
        harnessAppLauncherMocks.cleanup(installationId)
      }
    }, [installationId])
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
  afterEach(() => {
    appIframeMocks.cleanup.mockClear()
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

  test('keeps the board workbench connected and stateful while its tab is inactive', () => {
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
    expect(screen.getByTestId('mock-workbench-board')).toHaveAttribute('data-route-active', 'true')
    expect(workbenchProviderMocks.loadTaskComposerCatalogs).toHaveBeenLastCalledWith(true)
    expect(workbenchProviderMocks.prewarm).toHaveBeenLastCalledWith(false)

    rerender(<WorkspaceTabSurface {...props} active={false} />)

    expect(screen.getByTestId('workspace-tab-content-fixed-board')).toHaveClass(
      'pointer-events-none',
      'invisible'
    )
    expect(screen.getByTestId('mock-workbench-board')).toHaveAttribute('data-route-active', 'false')
    expect(workbenchProviderMocks.cleanup).not.toHaveBeenCalled()

    unmount()
    expect(workbenchProviderMocks.cleanup).toHaveBeenCalledTimes(1)
  })

  test('keeps composer catalogs loaded when a retained board tab displays an auxiliary page', () => {
    const dispose = getWorkbenchPluginRuntime().routes.register({
      id: 'board-auxiliary-catalog-test',
      path: '/board-auxiliary-catalog-test',
      telemetryFeature: 'apps',
      render: () => <div data-testid="mock-board-auxiliary-page" />,
    })
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
    dispose()
  })

  test('keeps an inactive iframe app connected so its page state survives tab switches', () => {
    const dispose = getWorkbenchPluginRuntime().apps.register({
      key: 'harness-stateful',
      mode: 'iframe',
      url: 'http://localhost:3000',
      hidden: true,
      labelKey: 'harness-stateful.label',
      label: 'Stateful Harness',
      descriptionKey: 'harness-stateful.description',
      description: 'Stateful Harness',
    })
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
    expect(screen.getByTestId('workspace-tab-content-smart-app-1')).toHaveClass(
      'pointer-events-none',
      'invisible'
    )
    expect(appIframeMocks.cleanup).not.toHaveBeenCalled()

    unmount()
    expect(appIframeMocks.cleanup).toHaveBeenCalledTimes(1)
    dispose()
  })

  test('re-syncs titlebar portal ownership when a retained workspace becomes active again', () => {
    const dispose = getWorkbenchPluginRuntime().apps.register({
      key: 'harness-titlebar',
      mode: 'iframe',
      url: 'http://localhost:3000',
      hidden: true,
      labelKey: 'harness-titlebar.label',
      label: 'Titlebar Harness',
      descriptionKey: 'harness-titlebar.description',
      description: 'Titlebar Harness',
    })
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
    dispose()
  })

  test('renders the launch surface when a running Harness app opens directly as an iframe', () => {
    const installationId = 'running-app'
    const dispose = getWorkbenchPluginRuntime().apps.register({
      key: `harness-${installationId}`,
      mode: 'iframe',
      url: 'http://localhost:3000',
      hidden: true,
      labelKey: 'running-app.label',
      label: 'Running app',
      descriptionKey: 'running-app.description',
      description: 'Running app',
    })
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
    dispose()
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

    expect(screen.getByTestId(`workspace-tab-content-${props.tab.id}`)).toHaveClass(
      'pointer-events-none',
      'invisible'
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
})
