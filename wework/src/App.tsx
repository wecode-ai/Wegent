import {
  Activity,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Check, Copy, Info, Minimize2, PlugZap } from 'lucide-react'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { useAuth } from '@/features/auth/useAuth'
import { WorkbenchProvider } from '@/features/workbench/WorkbenchProvider'
import {
  registerRuntimeTaskLifecycleAutomation,
  RuntimeTaskLifecycleStore,
  RuntimeTaskLifecycleStreamCoordinator,
} from '@/features/workbench/runtimeTaskLifecycle'
import {
  createDefaultWorkbenchServices,
  type WorkbenchServices,
} from '@/features/workbench/workbenchServices'
import { RuntimeTaskCloseGuard } from '@/features/workbench/RuntimeTaskCloseGuard'
import { RuntimeTaskSystemSleepBridge } from '@/features/workbench/RuntimeTaskSystemSleepBridge'
import { OidcCallbackPage } from '@/pages/OidcCallbackPage'
import { LoginPage } from '@/pages/LoginPage'
import { WeworkAuthorizePage } from '@/pages/WeworkAuthorizePage'
import { PopoutWorkbenchPage } from '@/pages/PopoutWorkbenchPage'
import { stripAppBasePath } from '@/config/runtime'
import { AppearanceProvider } from '@/features/appearance'
import { ChromeTitlebar } from '@/components/topnav/ChromeTitlebar'
import { AppIframe } from '@/components/topnav/AppIframe'
import { listenHarnessAppLaunchProgress } from '@/api/local/harnessApps'
import { HarnessAppLaunchSurface } from '@/features/harness-apps/HarnessAppLaunchSurface'
import { ElectronWorkbenchTabBridge } from '@/features/harness-apps/ElectronWorkbenchTabBridge'
import {
  clearHarnessAppLaunch,
  harnessAppInstallationIdFromPath,
  updateHarnessAppLaunchPhase,
  useHarnessAppLaunchState,
} from '@/features/harness-apps/harnessAppLaunchState'
import { useChromeTabs } from '@/components/topnav/useChromeTabs'
import {
  getDesktopWindowLabel,
  isDesktopRuntime,
  isElectronRuntime,
} from '@/lib/runtime-environment'
import { AppUpdateProvider } from '@/features/app-update/AppUpdateProvider'
import { LocalRuntimeInitializer } from '@/features/local-runtime/LocalRuntimeInitializer'
import { CodexHomeInitializer } from '@/features/local-runtime/CodexHomeInitializer'
import { IdleTaskCoordinator } from '@/features/idle-tasks/IdleTaskCoordinator'
import { WeworkIdleTasks } from '@/features/idle-tasks/WeworkIdleTasks'
import { CloudConnectionProvider } from '@/features/cloud-connection/CloudConnectionProvider'
import { useCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { LocalExecutorCloudBridge } from '@/features/cloud-connection/LocalExecutorCloudBridge'
import { PluginAutoUpdateCoordinator } from '@/features/plugins/PluginAutoUpdateCoordinator'
import { CloudModelCatalogSyncDialogHost } from '@/features/model-settings/cloudModelCatalogSync'
import { cn } from '@/lib/utils'
import { createLocalAppServices } from '@/api/local/localServices'
import { createHttpClient } from '@/api/http'
import { createRuntimeWorkApi } from '@/api/runtimeWork'
import { useAwayImNotificationPresence } from '@/features/workbench/awayImNotificationPresence'
import { applyLanguagePreference } from '@/i18n/languagePreference'
import {
  KEYBINDINGS_CHANGED_EVENT,
  GO_BACK_COMMAND,
  GO_FORWARD_COMMAND,
  INCREASE_FONT_SIZE_COMMAND,
  DECREASE_FONT_SIZE_COMMAND,
  RESET_FONT_SIZE_COMMAND,
  OPEN_SETTINGS_COMMAND,
  OPEN_TERMINAL_COMMAND,
  TOGGLE_SIDEBAR_COMMAND,
  TOGGLE_SIDE_PANEL_COMMAND,
  TOGGLE_MODEL_SELECTOR_COMMAND,
  dispatchGoBackShortcut,
  dispatchGoForwardShortcut,
  dispatchOpenSettingsShortcut,
  dispatchOpenTerminalShortcut,
  dispatchToggleSidebarShortcut,
  dispatchToggleSidePanelShortcut,
  dispatchToggleModelSelectorShortcut,
  dispatchStepFontSizeShortcut,
  dispatchResetFontSizeShortcut,
  isEditableShortcutTarget,
  keybindingFromKeyboardEvent,
  mergeKeybindings,
  setActiveKeybindings,
} from '@/lib/keybindings'
import {
  getWeworkDevInstanceInfo,
  getWeworkDevInstanceRows,
  getWeworkDocumentTitle,
} from '@/lib/wework-dev-instance'
import { AppshotBridge } from '@/features/appshots/AppshotBridge'
import { HarnessAppAutoLauncher } from '@/features/harness-apps/HarnessAppAutoLauncher'
import { SystemDragPanel } from '@/features/system-drag/SystemDragPanel'
import { SystemDragBridge } from '@/features/system-drag/SystemDragBridge'
import { installMacOSInputArrowKeyGuard } from '@/lib/macosInputArrowKeyGuard'
import { useExperimentalFeaturesState } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { AppPreferencesProvider } from '@/features/app-preferences/AppPreferencesProvider'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { useTranslation } from '@/hooks/useTranslation'
import { WorkspaceTabsProvider } from '@/features/workspace-tabs/WorkspaceTabsContext'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import {
  createWorkspaceTab,
  inferWorkspaceTabKind,
  type WorkspaceTab,
} from '@/features/workspace-tabs/workspaceTabs'
import { harnessAppRoute, resolveRunningHarnessApp } from '@/features/harness-apps/harnessAppTabs'
import type { User } from '@/types/api'
import { TelemetryBridge } from '@/telemetry/TelemetryBridge'
import { track, useTelemetryEnabled } from '@/telemetry/client'
import { WorkspaceTabPortalOwner } from '@/components/topnav/TitlebarActionsPortal'
import { setActiveWorkspaceTabPortalOwner } from '@/components/topnav/workspaceTabPortalOwnership'
import { DshAppSurface } from '@/features/dsh-runtime/DshAppSurface'
import { DshRouteSurface } from '@/features/dsh-runtime/DshRouteSurface'
import { DshSlotSurface } from '@/features/dsh-runtime/DshSlotSurface'
import { DshWorkspaceTabSurface } from '@/features/dsh-runtime/DshWorkspaceTabSurface'
import { getDshApps, resolveDshApp, type WeworkDshApp } from '@/features/dsh-runtime/dshApps'
import { resolveDshRoute, type WeworkDshRoute } from '@/features/dsh-runtime/dshRoutes'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import { dshWorkspaceTabIdFromPath } from '@/features/dsh-runtime/dshWorkspaceTabs'
import { ComputerUseActivityIndicator } from '@/features/computer-use/ComputerUseActivityIndicator'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'

const POPOUT_WINDOW_LABEL = 'popout-window'

function isPopoutWindowRuntime() {
  return isElectronRuntime() && getDesktopWindowLabel() === POPOUT_WINDOW_LABEL
}

function buildCloudAppUrl(url: string, token: string | null): string {
  if (!token) return url

  const authenticatedUrl = new URL(url)
  const basePath = authenticatedUrl.pathname.replace(/\/+$/, '')
  authenticatedUrl.pathname = `${basePath}/login/oidc`
  authenticatedUrl.searchParams.set('access_token', token)
  authenticatedUrl.searchParams.set('token_type', 'bearer')
  authenticatedUrl.searchParams.set('login_success', 'true')
  return authenticatedUrl.toString()
}

function useCurrentPath() {
  return useCurrentLocation().pathname
}

function useCurrentLocation() {
  const [location, setLocation] = useState(() => ({
    pathname: stripAppBasePath(window.location.pathname),
    search: window.location.search,
  }))

  useEffect(() => {
    const handlePopState = () =>
      setLocation({
        pathname: stripAppBasePath(window.location.pathname),
        search: window.location.search,
      })
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  return location
}

function telemetryFeatureForPath(path: string) {
  if (path === '/login' || path === '/login/oidc') return 'login' as const
  const pluginRoute = resolveDshRoute(path)
  if (pluginRoute) return pluginRoute.telemetryFeature
  if (path.startsWith('/app/')) return 'apps' as const
  if (path.startsWith('/settings')) return 'settings' as const
  if (path.startsWith('/project-space')) return 'project_space' as const
  if (path === '/') return 'workbench' as const
  return 'unknown' as const
}

interface AppRoutesProps {
  onWorkbenchStartupReadyChange?: (ready: boolean) => void
  onOpenWeworkForAppshot?: () => void
}

function workspaceTabPath(tab: WorkspaceTab): string {
  return stripAppBasePath(new URL(tab.contentRoute, window.location.origin).pathname)
}

function workspaceTabIframe(
  tab: WorkspaceTab,
  wegentUrl: string | null | undefined
): { appKey: string; embeddedBrowserLabel?: string; src: string; title: string } | null {
  const match = workspaceTabPath(tab).match(/^\/app\/([^/]+)/)
  if (!match) return null
  const app = resolveDshApp(match[1])
  if (app?.mode === 'iframe') {
    const src = app.urlSource === 'cloud-web' ? wegentUrl : app.url
    return src ? { appKey: app.id, src, title: app.label } : null
  }
  const harnessApp = resolveRunningHarnessApp(match[1])
  return harnessApp
    ? {
        appKey: harnessApp.key,
        embeddedBrowserLabel: harnessApp.nativeLabel,
        src: harnessApp.url,
        title: harnessApp.title,
      }
    : null
}

function workspaceTabDshApp(
  path: string,
  workspaceKind: ReturnType<typeof inferWorkspaceTabKind>
): WeworkDshApp | null {
  const match = path.match(/^\/app\/([^/]+)$/)
  if (match) {
    const app = resolveDshApp(match[1])
    return app?.mode === 'surface' ? app : null
  }
  return (
    getDshApps().find(
      app =>
        app.module &&
        (workspaceKind === 'task' || workspaceKind === 'board') &&
        app.workspaceKinds?.includes(workspaceKind)
    ) ?? null
  )
}

function UnavailableWorkspaceRoute({ path }: { path: string }) {
  const { t } = useTranslation('common')
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center p-5"
      data-testid="workspace-route-unavailable"
    >
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-text-secondary">
          <PlugZap aria-hidden="true" className="h-5 w-5" />
        </div>
        <h1 className="heading-small mt-4 text-text-primary">
          {t('workbench.workspace_route_unavailable_title', '此工作区不可用')}
        </h1>
        <p className="mt-2 text-sm leading-5 text-text-secondary">
          {t(
            'workbench.workspace_route_unavailable_description',
            '提供此页面的插件可能已停用或卸载。你可以关闭此标签页，或重新启用对应插件。'
          )}
        </p>
        <code className="mt-3 rounded-md bg-muted px-2 py-1 text-code text-text-secondary">
          {path}
        </code>
      </div>
    </div>
  )
}

interface WorkspaceTabSurfaceProps {
  active: boolean
  cloudWebUrl: string | null | undefined
  lifecycleStore: RuntimeTaskLifecycleStore
  nativeWorkbenchKind?: 'task' | 'board'
  prewarmComposerApps?: boolean
  smartAppsEnabled?: boolean
  onOpenWeworkForAppshot?: () => void
  onWorkbenchStartupReadyChange?: (ready: boolean) => void
  services: WorkbenchServices
  tab: WorkspaceTab
  user: User
}

export function WorkspaceTabSurface({
  active,
  cloudWebUrl,
  lifecycleStore,
  nativeWorkbenchKind,
  prewarmComposerApps = false,
  smartAppsEnabled = false,
  onOpenWeworkForAppshot,
  onWorkbenchStartupReadyChange,
  services,
  tab,
  user,
}: WorkspaceTabSurfaceProps) {
  useDshSlotEntries(WEWORK_DSH_SLOTS.app)
  useDshSlotEntries(WEWORK_DSH_SLOTS.route)
  const tabPath = workspaceTabPath(tab)
  const tabSearch = new URL(tab.contentRoute, window.location.origin).search
  const dshWorkspaceTabId = dshWorkspaceTabIdFromPath(tabPath)
  const dshWorkspaceTabActive = Boolean(dshWorkspaceTabId)
  const harnessAppInstallationId = harnessAppInstallationIdFromPath(tabPath)
  const iframe = workspaceTabIframe(tab, cloudWebUrl)
  const auxiliaryRoute = resolveDshRoute(tabPath)
  const inferredNativeKind = inferWorkspaceTabKind(tabPath)
  const retainedNativeKind = nativeWorkbenchKind ?? inferredNativeKind
  const routedDshApp = workspaceTabDshApp(tabPath, inferredNativeKind)
  const retainedNativeApp = workspaceTabDshApp('', retainedNativeKind)
  const nativeDshApp = routedDshApp?.mode === 'native' ? routedDshApp : retainedNativeApp
  const surfaceDshApp = routedDshApp?.mode === 'surface' ? routedDshApp : null
  const nativeWorkbenchRoute = Boolean(
    (inferredNativeKind === 'task' || inferredNativeKind === 'board') &&
    nativeDshApp?.workspaceKinds?.includes(inferredNativeKind)
  )
  const auxiliaryActive = Boolean(auxiliaryRoute || surfaceDshApp) || dshWorkspaceTabActive
  const harnessAppLaunch = useHarnessAppLaunchState(harnessAppInstallationId)
  const harnessAppLaunchActive = Boolean(harnessAppLaunch)
  const [harnessAppStartupOwner, setHarnessAppStartupOwner] = useState(() => ({
    installationId: harnessAppInstallationId,
    pending: Boolean(harnessAppInstallationId),
  }))
  if (harnessAppStartupOwner.installationId !== harnessAppInstallationId) {
    setHarnessAppStartupOwner({
      installationId: harnessAppInstallationId,
      pending: Boolean(harnessAppInstallationId),
    })
  }
  const settleHarnessAppStartup = useCallback((settledInstallationId: string) => {
    setHarnessAppStartupOwner(current =>
      current.installationId === settledInstallationId ? { ...current, pending: false } : current
    )
  }, [])
  const harnessAppStartupPending =
    smartAppsEnabled &&
    harnessAppStartupOwner.installationId === harnessAppInstallationId &&
    harnessAppStartupOwner.pending
  const nativeWorkbenchActive =
    nativeWorkbenchRoute && !iframe && !auxiliaryActive && !harnessAppLaunchActive
  const unavailableRouteActive =
    !nativeWorkbenchActive &&
    !iframe &&
    !auxiliaryActive &&
    !harnessAppLaunchActive &&
    !harnessAppStartupPending
  const [surfaceHistory, setSurfaceHistory] = useState(() => ({
    iframe,
    hasMountedProvider: !iframe,
    hasMountedWorkbench: nativeWorkbenchActive,
  }))
  const nextIframe =
    iframe &&
    surfaceHistory.iframe?.src === iframe.src &&
    surfaceHistory.iframe.title === iframe.title
      ? surfaceHistory.iframe
      : (iframe ?? surfaceHistory.iframe)
  const nextSurfaceHistory = {
    iframe: nextIframe,
    hasMountedProvider: surfaceHistory.hasMountedProvider || !iframe,
    hasMountedWorkbench: surfaceHistory.hasMountedWorkbench || nativeWorkbenchActive,
  }
  if (
    nextSurfaceHistory.iframe !== surfaceHistory.iframe ||
    nextSurfaceHistory.hasMountedProvider !== surfaceHistory.hasMountedProvider ||
    nextSurfaceHistory.hasMountedWorkbench !== surfaceHistory.hasMountedWorkbench
  ) {
    setSurfaceHistory(nextSurfaceHistory)
  }

  const renderedIframe = iframe ?? surfaceHistory.iframe
  const renderProvider = surfaceHistory.hasMountedProvider || !iframe
  const renderWorkbench = surfaceHistory.hasMountedWorkbench || nativeWorkbenchActive
  // Fixed native tabs behave like desktop tabs: mount once, preserve their
  // effects and in-memory UI state, and remove them from layout and paint while inactive.
  const keepNativeWorkbenchActive =
    Boolean(nativeWorkbenchKind || tab.kind === 'task' || tab.kind === 'board') && renderWorkbench
  // App WebViews own in-memory page state that is lost when React Activity
  // disconnects their effects. Keep the current iframe route connected while
  // inactive; AppIframe hides the native WebView through its active prop.
  const keepIframeActive = Boolean(iframe)
  // Starting an Electron Smart app is an application lifecycle operation, not
  // a visible-tab effect. Keep its launcher connected until startup settles.
  const keepHarnessAppLaunchActive = Boolean(harnessAppInstallationId && harnessAppLaunchActive)
  const keepSurfaceActive =
    keepNativeWorkbenchActive || keepIframeActive || keepHarnessAppLaunchActive

  useLayoutEffect(() => {
    if (!active) return
    // React Activity may reveal a retained workspace after AppRoutes has already
    // committed its active-tab effect. Re-sync at the surface boundary so titlebar
    // portals mounted during that reveal cannot keep the previous tab's visibility.
    setActiveWorkspaceTabPortalOwner(tab.id)
  }, [active, tab.id])

  const workbenchContent = (
    <>
      {harnessAppInstallationId && smartAppsEnabled ? (
        <HarnessAppAutoLauncher
          installationId={harnessAppInstallationId}
          onStartupSettled={settleHarnessAppStartup}
        />
      ) : null}
      {onOpenWeworkForAppshot && active && !iframe ? (
        <AppshotBridge onOpenWework={onOpenWeworkForAppshot} />
      ) : null}
      {renderWorkbench ? (
        <div
          data-testid="desktop-workbench-surface"
          className={cn('h-full', !nativeWorkbenchActive && 'hidden')}
          aria-hidden={!nativeWorkbenchActive}
        >
          {nativeDshApp ? (
            <DshAppSurface active={active && nativeWorkbenchActive} app={nativeDshApp} tab={tab} />
          ) : null}
        </div>
      ) : null}
      {auxiliaryRoute ? (
        <div data-testid="desktop-auxiliary-surface" className="h-full">
          <DshRouteSurface route={auxiliaryRoute} search={tabSearch} workspaceTabId={tab.id} />
        </div>
      ) : null}
      {surfaceDshApp ? <DshAppSurface active={active} app={surfaceDshApp} tab={tab} /> : null}
      {dshWorkspaceTabActive ? (
        <DshWorkspaceTabSurface active={active} path={tabPath} tab={tab} />
      ) : null}
      {unavailableRouteActive ? <UnavailableWorkspaceRoute path={tabPath} /> : null}
    </>
  )
  return (
    <WorkspaceTabPortalOwner ownerId={tab.id}>
      <Activity mode={active || keepSurfaceActive ? 'visible' : 'hidden'}>
        <div
          className={cn(
            'min-h-0 min-w-0 overflow-hidden',
            active ? 'relative h-full' : 'absolute inset-0',
            !active && keepSurfaceActive && 'hidden'
          )}
          data-testid={`workspace-tab-content-${tab.id}`}
          data-workspace-tab-content={tab.id}
          aria-hidden={!active}
        >
          {renderProvider ? (
            <WorkbenchProvider
              lifecycleStore={lifecycleStore}
              services={services}
              user={user}
              onStartupReadyChange={active && !iframe ? onWorkbenchStartupReadyChange : undefined}
              workspaceTabId={tab.id}
              debugSnapshotEnabled={active && nativeWorkbenchActive}
              consumePluginTrials={active && !iframe}
              loadTaskComposerCatalogs
              prewarmComposerApps={prewarmComposerApps}
              publishDebugSnapshots={active && !iframe}
              syncCoreDshModels={
                tab.fixed &&
                tab.kind === 'task' &&
                isElectronRuntime() &&
                getDesktopWindowLabel() === 'main'
              }
              syncRemoteProjects={active}
              syncRuntimeTaskLifecycle={active}
            >
              {workbenchContent}
            </WorkbenchProvider>
          ) : null}
          {harnessAppLaunch ? <HarnessAppLaunchSurface launch={harnessAppLaunch} /> : null}
          {renderedIframe ? (
            <div
              className={cn(
                'absolute inset-0',
                !iframe && 'hidden',
                harnessAppLaunchActive && 'pointer-events-none opacity-0'
              )}
              aria-hidden={!iframe || harnessAppLaunchActive}
            >
              <AppIframe
                active={active && Boolean(iframe)}
                appKey={renderedIframe.appKey}
                edgeToEdge={Boolean(harnessAppInstallationId)}
                embeddedBrowserLabel={renderedIframe.embeddedBrowserLabel}
                onReady={
                  harnessAppInstallationId
                    ? () => clearHarnessAppLaunch(harnessAppInstallationId)
                    : undefined
                }
                src={renderedIframe.src}
                title={renderedIframe.title}
                waitForContent={Boolean(harnessAppInstallationId)}
                workspaceTabId={tab.id}
              />
            </div>
          ) : null}
        </div>
      </Activity>
    </WorkspaceTabPortalOwner>
  )
}

function AppRoutes({ onWorkbenchStartupReadyChange, onOpenWeworkForAppshot }: AppRoutesProps = {}) {
  const path = useCurrentPath()
  useDshSlotEntries(WEWORK_DSH_SLOTS.route)
  const isPopoutWindow = isPopoutWindowRuntime()
  const { user, isLoading } = useAuth()
  const cloudConnection = useCloudConnection()
  const experimentalFeatures = useExperimentalFeaturesState()
  const workspaceTabs = useOptionalWorkspaceTabs()
  const [mountedTabs, setMountedTabs] = useState(() => ({
    activeTabId: workspaceTabs?.activeTabId ?? null,
    ids: new Set(workspaceTabs ? [workspaceTabs.activeTabId] : []),
    nativeWorkbenchKinds: new Map(
      workspaceTabs?.tabs.flatMap(tab =>
        tab.kind === 'task' || tab.kind === 'board' ? [[tab.id, tab.kind] as const] : []
      ) ?? []
    ),
  }))
  const telemetryEnabled = useTelemetryEnabled()
  const lifecycleStore = useMemo(() => new RuntimeTaskLifecycleStore(user?.id), [user?.id])
  useEffect(() => registerRuntimeTaskLifecycleAutomation(lifecycleStore), [lifecycleStore])
  const usesFallbackCloudConnection = cloudConnection.serviceKey.startsWith('fallback:')
  const workbenchIdentity = usesFallbackCloudConnection ? user : (cloudConnection.user ?? user)
  const workbenchIdentityId = workbenchIdentity?.id
  const workbenchIdentityName = workbenchIdentity?.user_name
  const workbenchIdentityEmail = workbenchIdentity?.email
  const runtimeServiceUser = useMemo<User | undefined>(
    () =>
      workbenchIdentityId !== undefined
        ? {
            id: workbenchIdentityId,
            user_name: workbenchIdentityName ?? '',
            email: workbenchIdentityEmail ?? '',
          }
        : undefined,
    [workbenchIdentityEmail, workbenchIdentityId, workbenchIdentityName]
  )
  const services = useMemo(
    () =>
      createDefaultWorkbenchServices({
        isConnected: cloudConnection.isConnected,
        backendUrl: cloudConnection.backendUrl,
        apiBaseUrl: cloudConnection.apiBaseUrl,
        socketBaseUrl: cloudConnection.socketBaseUrl,
        socketPath: cloudConnection.socketPath,
        token: cloudConnection.token,
        user: runtimeServiceUser,
      }),
    [
      cloudConnection.apiBaseUrl,
      cloudConnection.backendUrl,
      cloudConnection.isConnected,
      cloudConnection.socketBaseUrl,
      cloudConnection.socketPath,
      cloudConnection.token,
      runtimeServiceUser,
    ]
  )

  useEffect(() => {
    if (!isElectronRuntime()) return
    let disposed = false
    let unlisten: (() => void) | null = null
    void listenHarnessAppLaunchProgress(progress => {
      updateHarnessAppLaunchPhase(progress.installationId, progress.phase)
    })
      .then(dispose => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(error => {
        console.error('[Wework] failed to listen for Smart app launch progress', error)
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    track('feature_opened', {
      feature: isPopoutWindow ? 'popout' : telemetryFeatureForPath(path),
    })
  }, [isPopoutWindow, path, telemetryEnabled])
  const nextNativeWorkbenchKinds = new Map(
    [...mountedTabs.nativeWorkbenchKinds].filter(([id]) =>
      workspaceTabs?.tabs.some(tab => tab.id === id)
    )
  )
  for (const tab of workspaceTabs?.tabs ?? []) {
    if (tab.kind === 'task' || tab.kind === 'board') {
      nextNativeWorkbenchKinds.set(tab.id, tab.kind)
    }
  }
  const nativeWorkbenchKindsChanged =
    nextNativeWorkbenchKinds.size !== mountedTabs.nativeWorkbenchKinds.size ||
    [...nextNativeWorkbenchKinds].some(
      ([id, kind]) => mountedTabs.nativeWorkbenchKinds.get(id) !== kind
    )
  if (
    workspaceTabs &&
    (mountedTabs.activeTabId !== workspaceTabs.activeTabId || nativeWorkbenchKindsChanged)
  ) {
    setMountedTabs({
      activeTabId: workspaceTabs.activeTabId,
      ids: new Set([...mountedTabs.ids, workspaceTabs.activeTabId]),
      nativeWorkbenchKinds: nextNativeWorkbenchKinds,
    })
  }

  useLayoutEffect(() => {
    setActiveWorkspaceTabPortalOwner(workspaceTabs?.activeTabId ?? null)
  }, [workspaceTabs?.activeTabId])

  if (path === '/login') {
    return <LoginPage />
  }

  if (path === '/login/oidc') {
    return <OidcCallbackPage />
  }

  if (path === '/auth/wework/authorize') {
    return <WeworkAuthorizePage />
  }

  if (isLoading || !user) {
    return null
  }

  // Route surfaces and their sidebars must read one resolved preference snapshot.
  // Mounting them before it is available makes experimental navigation items briefly
  // disappear when a route change creates a new sidebar instance.
  if (!experimentalFeatures.loaded) {
    return null
  }

  if (isPopoutWindow) {
    return (
      <>
        <RuntimeTaskLifecycleStreamCoordinator services={services} store={lifecycleStore} />
        <RuntimeTaskSystemSleepBridge store={lifecycleStore} />
        <WorkbenchProvider
          lifecycleStore={lifecycleStore}
          services={services}
          user={user}
          onStartupReadyChange={onWorkbenchStartupReadyChange}
        >
          {isElectronRuntime() && <SystemDragBridge />}
          <PopoutWorkbenchPage />
        </WorkbenchProvider>
      </>
    )
  }

  if (!workspaceTabs) return null
  const mountedWorkspaceTabs = workspaceTabs.tabs.filter(
    tab => tab.id === workspaceTabs.activeTabId || mountedTabs.ids.has(tab.id)
  )
  const composerPrewarmTabId = workspaceTabs.tabs.find(
    tab => nextNativeWorkbenchKinds.get(tab.id) === 'task'
  )?.id
  const cloudWebUrl = cloudConnection.webUrl
    ? buildCloudAppUrl(cloudConnection.webUrl, cloudConnection.token)
    : cloudConnection.webUrl
  return (
    <>
      <RuntimeTaskLifecycleStreamCoordinator services={services} store={lifecycleStore} />
      <RuntimeTaskSystemSleepBridge store={lifecycleStore} />
      {mountedWorkspaceTabs.map(tab => (
        <WorkspaceTabSurface
          key={tab.id}
          active={tab.id === workspaceTabs.activeTabId}
          lifecycleStore={lifecycleStore}
          nativeWorkbenchKind={nextNativeWorkbenchKinds.get(tab.id)}
          prewarmComposerApps={tab.id === composerPrewarmTabId}
          smartAppsEnabled={experimentalFeatures.enabled}
          services={services}
          cloudWebUrl={cloudWebUrl}
          onOpenWeworkForAppshot={onOpenWeworkForAppshot}
          onWorkbenchStartupReadyChange={onWorkbenchStartupReadyChange}
          tab={tab}
          user={user}
        />
      ))}
    </>
  )
}

export default function App() {
  const path = useCurrentPath()
  const content = isDesktopRuntime() && path === '/system-drag' ? <SystemDragPanel /> : <MainApp />
  return (
    <>
      <DshSlotSurface className="contents" slot={WEWORK_DSH_SLOTS.shellBefore} />
      {content}
      <ComputerUseActivityIndicator />
      <DshSlotSurface className="contents" slot={WEWORK_DSH_SLOTS.shellAfter} />
      <DshSlotSurface
        className="pointer-events-none fixed inset-0 z-system-popover"
        slot={WEWORK_DSH_SLOTS.shellOverlay}
      />
    </>
  )
}

function MainApp() {
  useEffect(() => {
    document.title = getWeworkDocumentTitle()
  }, [])

  return (
    <AppearanceProvider>
      <AppPreferencesProvider>
        <LanguagePreferenceInitializer />
        <AppUpdateProvider>
          <CloudConnectionProvider>
            <AuthProvider>
              <TelemetryBridge />
              <AppShell />
            </AuthProvider>
          </CloudConnectionProvider>
        </AppUpdateProvider>
      </AppPreferencesProvider>
    </AppearanceProvider>
  )
}

function LanguagePreferenceInitializer() {
  const appPreferences = useAppPreferencesState()

  useEffect(() => {
    if (!appPreferences?.loaded) return
    void applyLanguagePreference(appPreferences.preferences.language)
  }, [appPreferences?.loaded, appPreferences?.preferences.language])

  return null
}

const BROWSER_WORKSPACE_SCOPE_PREFIX = 'wework-workspace-'

function browserWorkspaceTabStorageScope(): string {
  if (!window.name.startsWith(BROWSER_WORKSPACE_SCOPE_PREFIX)) {
    window.name = `${BROWSER_WORKSPACE_SCOPE_PREFIX}${crypto.randomUUID()}`
  }
  return `browser:${window.name}`
}

function AppShell() {
  const { t } = useTranslation('common')
  const registeredRoutes = useDshSlotEntries<WeworkDshRoute>(WEWORK_DSH_SLOTS.route)
  const appPreferences = useAppPreferencesState()
  const { pathname: path, search } = useCurrentLocation()
  const { user, isLoading } = useAuth()
  const cloudConnection = useCloudConnection()
  const initialCloudConnection = {
    apiBaseUrl: cloudConnection.apiBaseUrl,
    backendUrl: cloudConnection.backendUrl,
    socketBaseUrl: cloudConnection.socketBaseUrl,
    isConnected: cloudConnection.isConnected,
    token: cloudConnection.token,
    registrationDeviceType: appPreferences?.preferences.remoteControlEnabled
      ? ('remote' as const)
      : ('app' as const),
  }
  const { activeAppKey, navigateToApp } = useChromeTabs(path)
  const isElectron = isElectronRuntime()
  const isDesktop = isDesktopRuntime()
  const isPopoutWindow = isPopoutWindowRuntime()
  const currentWindowLabel = isElectron ? getDesktopWindowLabel() : null
  const isMainWindow = currentWindowLabel === 'main'
  const isWorkspaceWindow = currentWindowLabel?.startsWith('workspace-') === true
  const cloudApiBaseUrl = cloudConnection.apiBaseUrl
  const cloudToken = cloudConnection.token
  const titlebarOverlaysContent = false
  const showChromeTitlebar = (isDesktop || isElectron) && !isPopoutWindow
  useEffect(() => {
    const startupRouteReady =
      path === '/login' || path === '/login/oidc' || path === '/auth/wework/authorize'
    if (!startupRouteReady || isLoading || !isMainWindow) return
    void invokeDesktopHost<void>('renderer.startupReady').catch(error => {
      console.error('[Wework] Failed to reveal the startup route', error)
    })
  }, [isLoading, isMainWindow, path])
  const workspaceTabStorageScope = useMemo(
    () => (isElectron ? (currentWindowLabel ?? 'main') : browserWorkspaceTabStorageScope()),
    [currentWindowLabel, isElectron]
  )
  const workspaceTabLabels = useMemo(
    () => ({
      task: t('workbench.workspace_tab_task', '任务'),
      board: t('workbench.workspace_tab_board', '工作空间'),
      agent: t('workbench.workspace_tab_agent', '智能体'),
      auxiliary: t('workbench.workspace_tab_auxiliary', '工作区'),
      auxiliaryRoutes: Object.fromEntries(
        registeredRoutes.map(route => [
          route.path,
          t(route.titleKey ?? route.id, route.title ?? route.label ?? route.id),
        ])
      ),
    }),
    [registeredRoutes, t]
  )
  const fixedWorkspaceTabs = useMemo(
    () =>
      isMainWindow && appPreferences?.loaded
        ? appPreferences.preferences.fixedWorkspaceTabs.flatMap(preference => {
            if (preference.kind === 'smart_app') {
              if (
                !appPreferences.preferences.experimentalFeaturesEnabled ||
                !preference.installationId
              ) {
                return []
              }
              return [
                createWorkspaceTab('auxiliary', workspaceTabLabels, {
                  id: preference.id,
                  title: preference.title ?? t('workbench.smart_apps_title', '智能工作台'),
                  contentRoute: harnessAppRoute(preference.installationId),
                  fixed: true,
                }),
              ]
            }
            return [
              createWorkspaceTab(preference.kind, workspaceTabLabels, {
                id: preference.id,
                fixed: true,
              }),
            ]
          })
        : [],
    [appPreferences, isMainWindow, t, workspaceTabLabels]
  )
  const startupWorkspaceTabId = useMemo(() => {
    if (!isMainWindow || !appPreferences?.loaded) return undefined
    const preferredId = appPreferences.preferences.startupWorkspaceTabId
    return fixedWorkspaceTabs.some(tab => tab.id === preferredId)
      ? preferredId
      : fixedWorkspaceTabs[0]?.id
  }, [appPreferences, fixedWorkspaceTabs, isMainWindow])
  const [workbenchStartupReady, setWorkbenchStartupReady] = useState(false)
  const updateImNotificationPresence = useMemo(() => {
    if (!cloudApiBaseUrl || !cloudToken) return undefined
    return createRuntimeWorkApi(
      createHttpClient({
        baseUrl: cloudApiBaseUrl,
        getToken: () => cloudToken,
        redirectOnUnauthorized: false,
      })
    ).updateImNotificationPresence
  }, [cloudApiBaseUrl, cloudToken])
  useAwayImNotificationPresence({
    enabled: isMainWindow && isElectron && cloudConnection.isConnected,
    updatePresence: updateImNotificationPresence,
  })
  const openWeworkForAppshot = useCallback(() => {
    navigateToApp('wework')
  }, [navigateToApp])

  useEffect(() => {
    if (!isDesktop || isPopoutWindow) return undefined

    let activeBindings = mergeKeybindings([])
    let disposed = false

    const loadKeybindings = async () => {
      try {
        const services = createLocalAppServices()
        const response = await services.runtimeWorkApi?.getKeybindings()
        if (!disposed) {
          activeBindings = setActiveKeybindings(response?.keybindings ?? [])
        }
      } catch (error) {
        console.error('[Wework] Failed to load keybindings:', error)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const terminalKey = activeBindings[OPEN_TERMINAL_COMMAND]
      const settingsKey = activeBindings[OPEN_SETTINGS_COMMAND]
      const goBackKey = activeBindings[GO_BACK_COMMAND]
      const goForwardKey = activeBindings[GO_FORWARD_COMMAND]
      const sidebarKey = activeBindings[TOGGLE_SIDEBAR_COMMAND]
      const sidePanelKey = activeBindings[TOGGLE_SIDE_PANEL_COMMAND]
      const modelSelectorKey = activeBindings[TOGGLE_MODEL_SELECTOR_COMMAND]
      const increaseFontSizeKey = activeBindings[INCREASE_FONT_SIZE_COMMAND]
      const decreaseFontSizeKey = activeBindings[DECREASE_FONT_SIZE_COMMAND]
      const resetFontSizeKey = activeBindings[RESET_FONT_SIZE_COMMAND]
      const eventKey = keybindingFromKeyboardEvent(event)
      const matchesFontSizeShortcut =
        eventKey === increaseFontSizeKey ||
        eventKey === decreaseFontSizeKey ||
        eventKey === resetFontSizeKey
      // The page zoom guard prevents WebView zoom before this window-level
      // handler runs. Keep application font-size shortcuts actionable.
      if (event.defaultPrevented && !matchesFontSizeShortcut) return
      const matchesRegisteredShortcut = [
        terminalKey,
        settingsKey,
        goBackKey,
        goForwardKey,
        sidebarKey,
        sidePanelKey,
        modelSelectorKey,
        increaseFontSizeKey,
        decreaseFontSizeKey,
        resetFontSizeKey,
      ].some(key => key && key === eventKey)
      if (!matchesRegisteredShortcut && isEditableShortcutTarget(event.target)) return

      if (settingsKey && eventKey === settingsKey) {
        event.preventDefault()
        dispatchOpenSettingsShortcut()
        return
      }
      if (goBackKey && eventKey === goBackKey) {
        event.preventDefault()
        dispatchGoBackShortcut()
        return
      }
      if (goForwardKey && eventKey === goForwardKey) {
        event.preventDefault()
        dispatchGoForwardShortcut()
        return
      }
      if (sidebarKey && eventKey === sidebarKey) {
        event.preventDefault()
        dispatchToggleSidebarShortcut()
        return
      }
      if (sidePanelKey && eventKey === sidePanelKey) {
        event.preventDefault()
        dispatchToggleSidePanelShortcut()
        return
      }
      if (modelSelectorKey && eventKey === modelSelectorKey) {
        event.preventDefault()
        dispatchToggleModelSelectorShortcut()
        return
      }
      if (increaseFontSizeKey && eventKey === increaseFontSizeKey) {
        event.preventDefault()
        dispatchStepFontSizeShortcut(1)
        return
      }
      if (decreaseFontSizeKey && eventKey === decreaseFontSizeKey) {
        event.preventDefault()
        dispatchStepFontSizeShortcut(-1)
        return
      }
      if (resetFontSizeKey && eventKey === resetFontSizeKey) {
        event.preventDefault()
        dispatchResetFontSizeShortcut()
        return
      }
      if (!terminalKey || eventKey !== terminalKey) return
      event.preventDefault()
      dispatchOpenTerminalShortcut()
    }

    const handleMouseUp = (event: MouseEvent) => {
      if (event.defaultPrevented) return
      if (activeBindings[GO_BACK_COMMAND] && event.button === 3) {
        event.preventDefault()
        dispatchGoBackShortcut()
        return
      }
      if (activeBindings[GO_FORWARD_COMMAND] && event.button === 4) {
        event.preventDefault()
        dispatchGoForwardShortcut()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener(KEYBINDINGS_CHANGED_EVENT, loadKeybindings)
    void loadKeybindings()

    return () => {
      disposed = true
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener(KEYBINDINGS_CHANGED_EVENT, loadKeybindings)
    }
  }, [isDesktop, isPopoutWindow])

  useEffect(() => {
    return installMacOSInputArrowKeyGuard()
  }, [])

  // No chrome on login/setup pages
  if (path === '/login' || path === '/login/oidc') {
    return <AppRoutes />
  }

  if (isLoading || (isMainWindow && !appPreferences?.loaded)) {
    if (isPopoutWindow) {
      return <div className="h-dvh bg-transparent" />
    }
    return (
      <CodexHomeInitializer>
        <LocalRuntimeInitializer startupReady={false}>
          <div />
        </LocalRuntimeInitializer>
      </CodexHomeInitializer>
    )
  }

  if (!user) {
    return <AppRoutes />
  }

  const shell = (
    <WorkspaceTabsProvider
      pathname={path}
      search={search}
      storageScope={workspaceTabStorageScope}
      labels={workspaceTabLabels}
      fixedTabs={fixedWorkspaceTabs}
      startupTabId={startupWorkspaceTabId}
      restoreSessionTabs={!isMainWindow}
    >
      <ElectronWorkbenchTabBridge />
      <div
        data-testid="app-shell"
        className={cn(
          isDesktop ? 'fixed inset-0' : 'h-dvh',
          isPopoutWindow
            ? 'overflow-visible bg-transparent'
            : isWorkspaceWindow
              ? 'overflow-hidden bg-[rgb(var(--color-titlebar))]'
              : 'overflow-hidden bg-surface',
          titlebarOverlaysContent ? 'relative' : 'flex flex-col'
        )}
      >
        {showChromeTitlebar && (
          <ChromeTitlebar
            showWorkspacePortals={activeAppKey !== 'wework'}
            showFeedback={activeAppKey !== 'wework'}
          />
        )}
        {isDesktop && !isPopoutWindow && !isWorkspaceWindow ? <RuntimeTaskCloseGuard /> : null}
        {!isPopoutWindow && !isWorkspaceWindow ? (
          <LocalExecutorCloudBridge
            apiBaseUrl={cloudConnection.apiBaseUrl}
            backendUrl={cloudConnection.backendUrl}
            socketBaseUrl={cloudConnection.socketBaseUrl}
            isConnected={cloudConnection.isConnected}
            token={cloudConnection.token}
            preferencesLoaded={appPreferences?.loaded ?? false}
            remoteControlEnabled={appPreferences?.preferences.remoteControlEnabled ?? false}
          />
        ) : null}
        {isMainWindow && isElectron ? (
          <>
            <IdleTaskCoordinator active={workbenchStartupReady} />
            <WeworkIdleTasks />
          </>
        ) : null}
        {isMainWindow && isElectron ? <PluginAutoUpdateCoordinator /> : null}
        <CloudModelCatalogSyncDialogHost />
        <div
          data-testid="app-route-host"
          className={cn(
            'relative min-h-0',
            isPopoutWindow ? 'overflow-visible' : 'overflow-hidden',
            titlebarOverlaysContent ? 'h-full' : 'flex-1'
          )}
        >
          <AppRoutes
            onWorkbenchStartupReadyChange={setWorkbenchStartupReady}
            onOpenWeworkForAppshot={isDesktop ? openWeworkForAppshot : undefined}
          />
        </div>
        {!isPopoutWindow && <WeworkDevInstanceBadge />}
      </div>
    </WorkspaceTabsProvider>
  )

  if (isPopoutWindow) {
    return shell
  }

  return (
    <CodexHomeInitializer>
      <LocalRuntimeInitializer
        initialCloudConnection={initialCloudConnection}
        startupReady={workbenchStartupReady}
      >
        {shell}
      </LocalRuntimeInitializer>
    </CodexHomeInitializer>
  )
}

function WeworkDevInstanceBadge() {
  const info = getWeworkDevInstanceInfo()
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const [position, setPosition] = useState<CSSProperties>()
  const draggedRef = useRef(false)
  const copiedResetTimeoutRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (copiedResetTimeoutRef.current !== null) {
        window.clearTimeout(copiedResetTimeoutRef.current)
      }
    },
    []
  )
  if (!info) return null

  const rows = getWeworkDevInstanceRows(info)
  const popoverAbove = typeof position?.top !== 'number' || position.top > window.innerHeight / 2
  const popoverAlignRight =
    typeof position?.left !== 'number' || position.left > window.innerWidth / 2
  const copyValue = async (key: string, value: string) => {
    await navigator.clipboard?.writeText(value)
    setCopiedKey(key)
    if (copiedResetTimeoutRef.current !== null) {
      window.clearTimeout(copiedResetTimeoutRef.current)
    }
    copiedResetTimeoutRef.current = window.setTimeout(() => {
      copiedResetTimeoutRef.current = null
      setCopiedKey(current => (current === key ? null : current))
    }, 1200)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    const root = event.currentTarget.parentElement
    if (!root) return
    const startX = event.clientX
    const startY = event.clientY
    const startRect = root.getBoundingClientRect()
    draggedRef.current = false

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX
      const deltaY = moveEvent.clientY - startY
      if (!draggedRef.current && Math.hypot(deltaX, deltaY) < 4) return
      draggedRef.current = true
      setPosition({
        bottom: 'auto',
        right: 'auto',
        left: Math.min(
          Math.max(0, window.innerWidth - startRect.width),
          Math.max(0, startRect.left + deltaX)
        ),
        top: Math.min(
          Math.max(0, window.innerHeight - startRect.height),
          Math.max(0, startRect.top + deltaY)
        ),
      })
    }
    const stopDragging = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopDragging)
      window.removeEventListener('pointercancel', stopDragging)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopDragging)
    window.addEventListener('pointercancel', stopDragging)
  }

  const handleTriggerClick = () => {
    if (draggedRef.current) {
      draggedRef.current = false
      return
    }
    if (collapsed) setCollapsed(false)
  }

  return (
    <div
      data-testid="wework-dev-instance-badge"
      style={position}
      className="group pointer-events-auto fixed bottom-3 right-3 z-critical max-w-[min(460px,calc(100vw-1.5rem))]"
    >
      <button
        type="button"
        data-testid="wework-dev-instance-trigger"
        onClick={handleTriggerClick}
        onPointerDown={handlePointerDown}
        aria-label={collapsed ? 'Expand development instance info' : 'Development instance info'}
        className={cn(
          'ml-auto flex cursor-grab items-center justify-center border border-border/80 bg-background/95 text-xs font-medium text-text-secondary shadow-[0_8px_24px_rgba(0,0,0,0.12)] backdrop-blur active:cursor-grabbing',
          collapsed
            ? 'h-8 w-8 rounded-full'
            : 'max-w-[min(240px,calc(100vw-1.5rem))] rounded-md px-2.5 py-1.5'
        )}
      >
        {collapsed ? (
          <Info className="h-4 w-4" />
        ) : (
          <span className="truncate text-text-primary">{info.title}</span>
        )}
      </button>
      <div
        className={cn(
          'pointer-events-none absolute w-[min(460px,calc(100vw-1.5rem))] text-xs opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100',
          popoverAbove ? 'bottom-full pb-2' : 'top-full pt-2',
          popoverAlignRight ? 'right-0' : 'left-0'
        )}
      >
        <div className="rounded-lg border border-border/80 bg-background/98 p-2 shadow-[0_18px_48px_rgba(0,0,0,0.18)] backdrop-blur">
          <div className="mb-1 flex items-center justify-between px-2 py-1">
            <span className="font-medium text-text-primary">Development instance</span>
            {!collapsed && (
              <button
                type="button"
                data-testid="collapse-wework-dev-instance-button"
                className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-black/[0.04] hover:text-text-primary"
                title="Collapse to movable icon"
                aria-label="Collapse development instance info"
                onClick={() => setCollapsed(true)}
              >
                <Minimize2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="space-y-1">
            {rows.map(row => (
              <div
                key={row.key}
                className="grid grid-cols-[7.5rem_minmax(0,1fr)_2rem] items-center gap-2 rounded-md px-2 py-1 hover:bg-surface"
              >
                <div className="text-text-muted">{row.label}</div>
                <div
                  className="min-w-0 truncate font-mono text-xs text-text-primary"
                  title={row.value}
                >
                  {row.value}
                </div>
                <button
                  type="button"
                  data-testid={`copy-wework-dev-${row.key}-button`}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-black/[0.04] hover:text-text-primary"
                  title={`Copy ${row.label}`}
                  aria-label={`Copy ${row.label}`}
                  onClick={() => void copyValue(row.key, row.value)}
                >
                  {copiedKey === row.key ? (
                    <Check className="h-3.5 w-3.5 text-primary" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
