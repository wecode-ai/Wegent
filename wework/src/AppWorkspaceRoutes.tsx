import { createWorkspaceTabSurfaceBinding } from '@/features/workspace-tabs/workspaceTabSurfaceBinding'
import { isPopoutWindowRuntime } from './appWindowIdentity'

import { LOCAL_USER } from '@/api/local/localSession'
import { RuntimeInteractionsPage } from '@/features/notifications/RuntimeInteractionsPage'
import { INTERACTIONS_PATH } from '@/features/notifications/RuntimeInteractionsContext'
import { CollaborationExpRoute } from '@/features/collaboration-exp/CollaborationExpRoute'
import { isCollaborationExpPath } from '@/features/collaboration-exp/collaborationExpFeature'
import {
  Activity,
  useCallback,
  memo,
  useMemo,
  useState,
  useContext,
  useSyncExternalStore,
} from 'react'
import { PlugZap } from 'lucide-react'
import { useAuth } from '@/features/auth/useAuth'
import { WorkbenchProvider } from '@/features/workbench/WorkbenchProvider'
import { resolveWorkbenchOwnership } from '@/features/workbench/workbenchOwnership'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import {
  createDefaultWorkbenchServices,
  type WorkbenchServices,
} from '@/features/workbench/workbenchServices'
import { ReplyPredictionCoordinator } from '@/features/reply-predictions/ReplyPredictionCoordinator'
import { OidcCallbackPage } from '@/pages/OidcCallbackPage'
import { LoginPage } from '@/pages/LoginPage'
import { WeworkAuthorizePage } from '@/pages/WeworkAuthorizePage'
import { PopoutWorkbenchPage } from '@/pages/PopoutWorkbenchPage'
import { stripAppBasePath } from '@/config/runtime'
import { AppIframe } from '@/components/topnav/AppIframe'
import { HarnessAppLaunchSurface } from '@/features/harness-apps/HarnessAppLaunchSurface'
import {
  clearHarnessAppLaunch,
  harnessAppInstallationIdFromPath,
  useHarnessAppLaunchState,
} from '@/features/harness-apps/harnessAppLaunchState'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { useCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { cn } from '@/lib/utils'
import { isSettingsRoute } from '@/lib/navigation'
import { useExperimentalFeaturesState } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { useAppPreferenceFeatureState } from '@/features/experimental-features/useAppPreferenceFeatureState'
import { useTranslation } from '@/hooks/useTranslation'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { inferWorkspaceTabKind, type WorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'
import { resolveRunningHarnessApp } from '@/features/harness-apps/harnessAppTabs'
import type { User } from '@/types/api'
import { WorkspaceTabPortalOwner } from '@/components/topnav/TitlebarActionsPortal'
import { DshAppSurface } from '@/features/dsh-runtime/DshAppSurface'
import { DshRouteSurface } from '@/features/dsh-runtime/DshRouteSurface'
import { DshWorkspaceTabSurface } from '@/features/dsh-runtime/DshWorkspaceTabSurface'
import { resolveDshApp, type WeworkDshApp } from '@/features/dsh-runtime/dshApps'
import { type WeworkDshRoute } from '@/features/dsh-runtime/dshRoutes'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import { dshWorkspaceTabIdFromPath } from '@/features/dsh-runtime/dshWorkspaceTabs'
import { deviceSurfaceExtension } from '@extensions/device-surface'
import { createAppRouteSession } from './appRouteSession'
import { WorkspaceTabsSessionContext } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useCurrentLocation } from './appLocation'

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

interface AppRoutesProps {
  onOpenWeworkForAppshot?: () => void
  onWorkbenchStartupReadyChange?: (ready: boolean) => void
}

function workspaceTabPath(tab: WorkspaceTab): string {
  return stripAppBasePath(new URL(tab.contentRoute, window.location.origin).pathname)
}

function workspaceTabIframe(
  tab: WorkspaceTab,
  wegentUrl: string | null | undefined
): { appKey: string; embeddedBrowserLabel?: string; src: string; title: string } | null {
  const tabUrl = new URL(tab.contentRoute, window.location.origin)
  const tabPath = stripAppBasePath(tabUrl.pathname)
  const appId = tabPath.match(/^\/app\/([^/]+)/)?.[1]
  if (!appId) return null
  const app = resolveDshApp(appId)
  if (app?.mode === 'iframe') {
    const appPrefix = `/app/${appId}`
    const requestedCloudPath = tabPath.slice(appPrefix.length)
    const cloudPath = requestedCloudPath || app.cloudPath || ''
    const destination = `${cloudPath}${tabUrl.search}`
    const src = app.urlSource === 'cloud-web' ? resolveCloudAppUrl(wegentUrl, destination) : app.url
    return src ? { appKey: app.id, src, title: app.label } : null
  }
  const harnessApp = resolveRunningHarnessApp(appId)
  return harnessApp
    ? {
        appKey: harnessApp.key,
        embeddedBrowserLabel: harnessApp.nativeLabel,
        src: harnessApp.url,
        title: harnessApp.title,
      }
    : null
}

function resolveCloudAppUrl(
  wegentUrl: string | null | undefined,
  destination: string | undefined
): string | null {
  if (!wegentUrl) return null
  if (!destination) return wegentUrl

  const url = new URL(wegentUrl)
  if (url.pathname.endsWith('/login/oidc')) {
    url.searchParams.set('redirect', destination)
    return url.toString()
  }
  const requested = new URL(destination, 'https://wework.invalid')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${requested.pathname}`
  url.search = requested.search
  return url.toString()
}

function workspaceTabDshApp(
  path: string,
  workspaceKind: ReturnType<typeof inferWorkspaceTabKind>,
  apps: readonly WeworkDshApp[]
): WeworkDshApp | null {
  const match = path.match(/^\/app\/([^/]+)$/)
  if (match) {
    const app = apps.find(app => app.id === match[1])
    return app?.mode === 'surface' ? app : null
  }
  return (
    apps.find(
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
  collaborationExperienceEnabled?: boolean
  cloudWebUrl: string | null | undefined
  lifecycleStore: RuntimeTaskLifecycleStore
  nativeWorkbenchKind?: 'task' | 'board'
  smartAppsEnabled?: boolean
  onOpenWeworkForAppshot?: () => void
  onWorkbenchStartupReadyChange?: (ready: boolean) => void
  services: WorkbenchServices
  tab: WorkspaceTab
  user: User
}

export const WorkspaceTabSurface = memo(function WorkspaceTabSurface({
  active,
  collaborationExperienceEnabled = false,
  cloudWebUrl,
  lifecycleStore,
  nativeWorkbenchKind,
  smartAppsEnabled = false,
  onOpenWeworkForAppshot,
  onWorkbenchStartupReadyChange,
  services,
  tab,
  user,
}: WorkspaceTabSurfaceProps) {
  const apps = useDshSlotEntries<WeworkDshApp>(WEWORK_DSH_SLOTS.app)
  const routes = useDshSlotEntries<WeworkDshRoute>(WEWORK_DSH_SLOTS.route)
  const tabPath = workspaceTabPath(tab)
  const tabSearch = new URL(tab.contentRoute, window.location.origin).search
  const dshWorkspaceTabId = dshWorkspaceTabIdFromPath(tabPath)
  const dshWorkspaceTabActive = Boolean(dshWorkspaceTabId)
  const harnessAppInstallationId = harnessAppInstallationIdFromPath(tabPath)
  const iframe = workspaceTabIframe(tab, cloudWebUrl)
  const auxiliaryRoute = routes.find(route => route.path === tabPath) ?? null
  const collaborationExperienceActive =
    collaborationExperienceEnabled && isCollaborationExpPath(tabPath)
  const inferredNativeKind = inferWorkspaceTabKind(tabPath)
  const retainedNativeKind = nativeWorkbenchKind ?? inferredNativeKind
  const routedDshApp = workspaceTabDshApp(tabPath, inferredNativeKind, apps)
  const retainedNativeApp = workspaceTabDshApp('', retainedNativeKind, apps)
  const nativeDshApp = routedDshApp?.mode === 'native' ? routedDshApp : retainedNativeApp
  const surfaceDshApp = routedDshApp?.mode === 'surface' ? routedDshApp : null
  const nativeWorkbenchRoute = Boolean(
    (inferredNativeKind === 'task' || inferredNativeKind === 'board') &&
    nativeDshApp?.workspaceKinds?.includes(inferredNativeKind)
  )
  const auxiliaryActive =
    Boolean(auxiliaryRoute || surfaceDshApp) ||
    dshWorkspaceTabActive ||
    collaborationExperienceActive
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
  // Retained tabs keep their workbench state while hidden. Track each reveal so
  // the provider can revalidate data that another tab may have changed.
  const [reveal, setReveal] = useState({ active, revision: 0 })
  if (reveal.active !== active) setReveal({ active, revision: reveal.revision + (active ? 1 : 0) })
  const workspaceTabRevealRevision = reveal.revision
  const nextIframe =
    iframe &&
    surfaceHistory.iframe?.src === iframe.src &&
    surfaceHistory.iframe.title === iframe.title
      ? surfaceHistory.iframe
      : (iframe ?? surfaceHistory.iframe)
  const nextSurfaceHistory = {
    iframe: nextIframe,
    hasMountedProvider: surfaceHistory.hasMountedProvider || !iframe || harnessAppStartupPending,
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
  const renderProvider = surfaceHistory.hasMountedProvider || !iframe || harnessAppStartupPending
  const renderWorkbench = surfaceHistory.hasMountedWorkbench || nativeWorkbenchActive
  // Fixed native tabs behave like desktop tabs: mount once, preserve their
  // effects and in-memory UI state, and remove them from layout and paint while inactive.
  const keepNativeWorkbenchActive =
    Boolean(nativeWorkbenchKind || tab.kind === 'task' || tab.kind === 'board') && renderWorkbench
  // App WebViews own in-memory page state that is lost when React Activity
  // disconnects their effects. Keep the current iframe route connected while
  // inactive; AppIframe hides the native WebView through its active prop.
  const keepIframeActive = Boolean(iframe)
  // A reopened launch can be queued behind the old tab's cleanup before it
  // establishes shared launch state. Keep that tab's pending owner connected too.
  const keepHarnessAppLaunchActive = Boolean(
    harnessAppInstallationId && (harnessAppLaunchActive || harnessAppStartupPending)
  )
  const keepSurfaceActive =
    keepNativeWorkbenchActive || keepIframeActive || keepHarnessAppLaunchActive

  const [surfaceBinding] = useState(createWorkspaceTabSurfaceBinding)
  const bindSurface = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return
      return surfaceBinding.attach(element, {
        active,
        tabId: tab.id,
        native:
          renderProvider && renderWorkbench && nativeDshApp
            ? {
                appId: nativeDshApp.id,
                hasModule: Boolean(nativeDshApp.module),
                tabId: tab.id,
                active: active && nativeWorkbenchActive,
              }
            : undefined,
        surface:
          renderProvider && surfaceDshApp
            ? {
                appId: surfaceDshApp.id,
                hasModule: Boolean(surfaceDshApp.module),
                tabId: tab.id,
                active,
              }
            : undefined,
      })
    },
    [
      surfaceBinding,
      active,
      tab.id,
      renderProvider,
      renderWorkbench,
      nativeDshApp,
      surfaceDshApp,
      nativeWorkbenchActive,
    ]
  )

  const workbenchContent = (
    <>
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
      {collaborationExperienceActive ? (
        <CollaborationExpRoute active={active} search={tabSearch} />
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
          ref={bindSurface}
          data-workspace-tab-content={tab.id}
          id={`workspace-tab-content-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`workspace-tab-select-${tab.id}`}
          tabIndex={active ? 0 : -1}
          inert={!active}
          aria-hidden={!active}
        >
          {renderProvider ? (
            <WorkbenchProvider
              lifecycleStore={lifecycleStore}
              appshotReceiver={
                active && onOpenWeworkForAppshot
                  ? { onOpenWework: onOpenWeworkForAppshot }
                  : undefined
              }
              taskRouteActive={
                active && nativeWorkbenchActive && nativeDshApp?.workspaceKinds?.[0] !== 'board'
              }
              services={services}
              user={user}
              onStartupReadyChange={active && !iframe ? onWorkbenchStartupReadyChange : undefined}
              harnessAppLaunch={
                harnessAppInstallationId && smartAppsEnabled
                  ? {
                      installationId: harnessAppInstallationId,
                      onStartupSettled: settleHarnessAppStartup,
                    }
                  : undefined
              }
              workspaceTabId={tab.id}
              workspaceTabRevealRevision={workspaceTabRevealRevision}
              composerAppsSourceActive={active && !iframe}
              debugSnapshotEnabled={active && nativeWorkbenchActive}
              consumePluginTrials={active && !iframe}
              loadTaskComposerCatalogs
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
})

export function AppRoutes({
  onWorkbenchStartupReadyChange,
  onOpenWeworkForAppshot,
}: AppRoutesProps = {}) {
  const { t } = useTranslation('common')
  const { pathname: path, search } = useCurrentLocation()
  const registeredRoutes = useDshSlotEntries<WeworkDshRoute>(WEWORK_DSH_SLOTS.route)
  const isPopoutWindow = isPopoutWindowRuntime()
  const { user, isLoading } = useAuth()
  const cloudConnection = useCloudConnection()
  const experimentalFeatures = useExperimentalFeaturesState()
  const collaborationExperience = useAppPreferenceFeatureState('collaborationExperienceEnabled')
  const workspaceTabs = useOptionalWorkspaceTabs()
  const tabsSession = useContext(WorkspaceTabsSessionContext)
  const { user: workbenchIdentity, key: ownershipKey } = resolveWorkbenchOwnership(
    cloudConnection,
    user
  )
  const lifecycleStore = useMemo(() => new RuntimeTaskLifecycleStore(ownershipKey), [ownershipKey])
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
  const routeSession = useMemo(
    () => createAppRouteSession({ tabs: tabsSession, lifecycleStore }),
    [tabsSession, lifecycleStore]
  )
  const taskActivityEnabled =
    !isLoading &&
    Boolean(user) &&
    experimentalFeatures.loaded &&
    path !== '/login' &&
    path !== '/login/oidc' &&
    path !== '/auth/wework/authorize' &&
    !deviceSurfaceExtension.isIsolatedSurface(path, search) &&
    (isPopoutWindow || Boolean(workspaceTabs))
  const pluginUpdatesEnabled =
    isElectronRuntime() &&
    getDesktopWindowLabel() === 'main' &&
    !isLoading &&
    Boolean(user) &&
    experimentalFeatures.loaded &&
    path !== '/login' &&
    path !== '/login/oidc' &&
    !deviceSurfaceExtension.isIsolatedSurface(path, search)
  const pluginUpdateProfile = useMemo(
    () => ({
      apiBaseUrl: cloudConnection.apiBaseUrl,
      token: cloudConnection.token,
      isConnected: cloudConnection.isConnected,
      socketBaseUrl: cloudConnection.socketBaseUrl,
      socketPath: cloudConnection.socketPath,
      userId: cloudConnection.user?.id,
    }),
    [
      cloudConnection.apiBaseUrl,
      cloudConnection.token,
      cloudConnection.isConnected,
      cloudConnection.socketBaseUrl,
      cloudConnection.socketPath,
      cloudConnection.user?.id,
    ]
  )
  const routeNotifications = useMemo(
    () => ({
      chatStream: services.chatStream,
      currentUserId: workbenchIdentity?.id,
      localUserId: LOCAL_USER.id,
      t,
    }),
    [services.chatStream, workbenchIdentity?.id, t]
  )
  const subscribeRoutes = useCallback(
    (listener: () => void) =>
      routeSession.subscribe(
        listener,
        { pathname: path, search },
        isPopoutWindow,
        services,
        taskActivityEnabled,
        routeNotifications,
        pluginUpdatesEnabled ? pluginUpdateProfile : undefined,
        workspaceTabs &&
          !isLoading &&
          user &&
          (getDesktopWindowLabel() !== 'main' || experimentalFeatures.loaded) &&
          path !== '/login' &&
          path !== '/login/oidc' &&
          !deviceSurfaceExtension.isIsolatedSurface(path, search)
          ? { tabs: workspaceTabs, pathname: path }
          : undefined,
        workspaceTabs &&
          !isLoading &&
          user &&
          (getDesktopWindowLabel() !== 'main' || experimentalFeatures.loaded) &&
          path !== '/login' &&
          path !== '/login/oidc' &&
          !deviceSurfaceExtension.isIsolatedSurface(path, search)
          ? {
              tabs: workspaceTabs,
              connection: cloudConnection,
              experiment: collaborationExperience,
              t,
            }
          : undefined,
        services
      ),
    [
      routeSession,
      path,
      search,
      isPopoutWindow,
      services,
      taskActivityEnabled,
      routeNotifications,
      pluginUpdatesEnabled,
      pluginUpdateProfile,
      workspaceTabs,
      isLoading,
      user,
      experimentalFeatures.loaded,
      cloudConnection,
      collaborationExperience,
      t,
    ]
  )
  const mountedTabs = useSyncExternalStore(
    subscribeRoutes,
    routeSession.getSnapshot,
    routeSession.getSnapshot
  )
  const nextNativeWorkbenchKinds = mountedTabs.nativeWorkbenchKinds

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

  if (deviceSurfaceExtension.isIsolatedSurface(path, search)) {
    const route = registeredRoutes.find(entry => entry.path === path)
    return (
      <WorkbenchProvider
        lifecycleStore={lifecycleStore}
        services={services}
        user={user}
        debugSnapshotEnabled={false}
        consumePluginTrials={false}
        loadTaskComposerCatalogs={false}
        publishDebugSnapshots={false}
        syncCoreDshModels={false}
        syncRemoteProjects={false}
        syncRuntimeTaskLifecycle={false}
      >
        <div
          className="h-dvh min-h-0 overflow-hidden bg-background"
          data-testid="isolated-surface-route"
        >
          {route ? (
            <DshRouteSurface route={route} search={search} workspaceTabId="isolated-surface" />
          ) : (
            <UnavailableWorkspaceRoute path={path} />
          )}
        </div>
      </WorkbenchProvider>
    )
  }

  if (isPopoutWindow) {
    return (
      <ReplyPredictionCoordinator services={services} store={lifecycleStore}>
        <WorkbenchProvider
          lifecycleStore={lifecycleStore}
          services={services}
          user={user}
          onStartupReadyChange={onWorkbenchStartupReadyChange}
        >
          <PopoutWorkbenchPage />
        </WorkbenchProvider>
      </ReplyPredictionCoordinator>
    )
  }

  if (!workspaceTabs) return null
  const mountedWorkspaceTabs = workspaceTabs.tabs.filter(
    tab => tab.id === workspaceTabs.activeTabId || mountedTabs.ids.has(tab.id)
  )
  const cloudWebUrl = cloudConnection.webUrl
    ? buildCloudAppUrl(cloudConnection.webUrl, cloudConnection.token)
    : cloudConnection.webUrl
  return (
    <ReplyPredictionCoordinator services={services} store={lifecycleStore}>
      {mountedWorkspaceTabs.map(tab =>
        tab.contentRoute.startsWith(INTERACTIONS_PATH) ? (
          <Activity key={tab.id} mode={tab.id === workspaceTabs.activeTabId ? 'visible' : 'hidden'}>
            <div
              className={cn('h-full', tab.id !== workspaceTabs.activeTabId && 'hidden')}
              data-testid={`workspace-tab-content-${tab.id}`}
              data-workspace-tab-content={tab.id}
              id={`workspace-tab-content-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`workspace-tab-select-${tab.id}`}
              tabIndex={tab.id === workspaceTabs.activeTabId ? 0 : -1}
              inert={tab.id !== workspaceTabs.activeTabId}
              aria-hidden={tab.id !== workspaceTabs.activeTabId}
            >
              <WorkbenchProvider
                lifecycleStore={lifecycleStore}
                services={services}
                user={user}
                workspaceTabId={tab.id}
                appshotReceiver={
                  tab.id === workspaceTabs.activeTabId && onOpenWeworkForAppshot
                    ? { onOpenWework: onOpenWeworkForAppshot }
                    : undefined
                }
                loadTaskComposerCatalogs={tab.id === workspaceTabs.activeTabId}
                composerAppsSourceActive={tab.id === workspaceTabs.activeTabId}
                debugSnapshotEnabled={false}
                publishDebugSnapshots={false}
                consumePluginTrials={false}
                syncCoreDshModels={false}
                syncRemoteProjects={tab.id === workspaceTabs.activeTabId}
                syncRuntimeTaskLifecycle={tab.id === workspaceTabs.activeTabId}
                onStartupReadyChange={
                  tab.id === workspaceTabs.activeTabId ? onWorkbenchStartupReadyChange : undefined
                }
              >
                <RuntimeInteractionsPage
                  active={tab.id === workspaceTabs.activeTabId}
                  selectedId={new URL(tab.contentRoute, window.location.origin).searchParams.get(
                    'interaction'
                  )}
                />
              </WorkbenchProvider>
            </div>
          </Activity>
        ) : (
          <WorkspaceTabSurface
            onOpenWeworkForAppshot={onOpenWeworkForAppshot}
            key={tab.id}
            active={tab.id === workspaceTabs.activeTabId}
            lifecycleStore={lifecycleStore}
            nativeWorkbenchKind={nextNativeWorkbenchKinds.get(tab.id)}
            smartAppsEnabled={experimentalFeatures.enabled}
            collaborationExperienceEnabled={collaborationExperience.enabled}
            services={services}
            cloudWebUrl={cloudWebUrl}
            onWorkbenchStartupReadyChange={onWorkbenchStartupReadyChange}
            tab={
              tab.id === workspaceTabs.activeTabId && isSettingsRoute(path)
                ? { ...tab, contentRoute: `${path}${search}` }
                : tab
            }
            user={user}
          />
        )
      )}
    </ReplyPredictionCoordinator>
  )
}
