import { useTelemetryEnabled } from '@/telemetry/client'
import { useSessionTelemetryConsent } from '@/telemetry/sessionConsent'
import { NotificationTaskSourceProvider } from '@/features/notifications/NotificationTaskSource'
import { RuntimeInteractionsProvider } from '@/features/notifications/RuntimeInteractionsProvider'
import { RuntimeInteractionNotice } from '@/features/notifications/RuntimeInteractionNotice'
import { PluginPythonRuntimeNotice } from '@/components/plugins/PluginPythonRuntimeNotice'
import { INTERACTIONS_PATH } from '@/features/notifications/RuntimeInteractionsContext'
import {
  COLLABORATION_EXP_PATH,
  isCollaborationExpPath,
} from '@/features/collaboration-exp/collaborationExpFeature'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useAuth } from '@/features/auth/useAuth'
import { RunnerSelectionHost } from '@/features/collaboration/RunnerSelectionHost'
import { resolveWorkbenchOwnership } from '@/features/workbench/workbenchOwnership'
import { RuntimeTaskCloseGuard } from '@/features/workbench/RuntimeTaskCloseGuard'
import { getWorkbenchBackground, useOptionalAppearance } from '@/features/appearance'
import { ChromeTitlebar } from '@/components/topnav/ChromeTitlebar'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '@/components/layout/DesktopTopBar'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Settings } from 'lucide-react'
import { useChromeTabs } from '@/components/topnav/useChromeTabs'
import {
  getDesktopWindowLabel,
  isDesktopRuntime,
  isElectronRuntime,
} from '@/lib/runtime-environment'
import { LocalRuntimeInitializer } from '@/features/local-runtime/LocalRuntimeInitializer'
import { LocalRuntimeNotice } from '@/features/local-runtime/LocalRuntimeNotice'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { CodexHomeInitializer } from '@/features/local-runtime/CodexHomeInitializer'
import { useCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { CloudModelCatalogSyncDialogHost } from '@/features/model-settings/cloudModelCatalogSync'
import { cn } from '@/lib/utils'
import { createHttpClient } from '@/api/http'
import { createRuntimeWorkApi } from '@/api/runtimeWork'
import { KEYBINDINGS_CHANGED_EVENT } from '@/lib/keybindings'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { navigateTo } from '@/lib/navigation'
import { useTranslation } from '@/hooks/useTranslation'
import { WorkspaceTabsProvider } from '@/features/workspace-tabs/WorkspaceTabsContext'
import { createWorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'
import { harnessAppRoute } from '@/features/harness-apps/harnessAppTabs'
import { useDshClientContext } from '@/features/dsh-runtime/DshClientContext'
import { type WeworkDshRoute } from '@/features/dsh-runtime/dshRoutes'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import { deviceSurfaceExtension } from '@extensions/device-surface'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { createAppShellSession } from './appShellSession'
import { AppRoutes } from './AppWorkspaceRoutes'
import { isPopoutWindowRuntime } from './appWindowIdentity'
import { useCurrentLocation } from './appLocation'
import { WeworkDevInstanceBadge } from './WeworkDevInstanceBadge'
const COLLABORATION_EXP_TAB_PATHS = [COLLABORATION_EXP_PATH] as const
const BROWSER_WORKSPACE_SCOPE_PREFIX = 'wework-workspace-'

function browserWorkspaceTabStorageScope(): string {
  if (!window.name.startsWith(BROWSER_WORKSPACE_SCOPE_PREFIX)) {
    window.name = `${BROWSER_WORKSPACE_SCOPE_PREFIX}${crypto.randomUUID()}`
  }
  return `browser:${window.name}`
}

export function AppShell() {
  const { user } = useAuth()
  const connection = useCloudConnection()
  const { key } = resolveWorkbenchOwnership(connection, user)
  return (
    <>
      {user && <RunnerSelectionHost key={key} />}
      <AppShellContent />
    </>
  )
}

function AppShellContent() {
  const { t } = useTranslation('common')
  const dshContext = useDshClientContext()
  const appearanceContext = useOptionalAppearance()
  const workbenchBackground = appearanceContext?.appearance
    ? getWorkbenchBackground(appearanceContext.appearance, appearanceContext.resolvedMode)
    : null
  const hasWorkbenchBackground = Boolean(workbenchBackground?.imagePath)
  const registeredRoutes = useDshSlotEntries<WeworkDshRoute>(WEWORK_DSH_SLOTS.route)
  const appPreferences = useAppPreferencesState()
  const telemetryEnabled = useTelemetryEnabled()
  const sessionConsent = useSessionTelemetryConsent()
  const { pathname: path, search } = useCurrentLocation()
  const assistantPreferenceFailed = path === '/stand-in' && appPreferences?.loadStatus === 'error'
  const { user, isLoading } = useAuth()
  const cloudConnection = useCloudConnection()
  const { key: ownershipKey } = resolveWorkbenchOwnership(cloudConnection, user)
  const { activeAppKey, navigateToApp } = useChromeTabs(path)
  const openWeworkForAppshot = useCallback(() => navigateToApp('wework'), [navigateToApp])
  const isElectron = isElectronRuntime()
  const isDesktop = isDesktopRuntime()
  const isPopoutWindow = isPopoutWindowRuntime()
  const currentWindowLabel = isElectron ? getDesktopWindowLabel() : null
  const isMainWindow = currentWindowLabel === 'main'
  const isWorkspaceWindow = currentWindowLabel?.startsWith('workspace-') === true
  const localExecutorCloudInput = useMemo(
    () =>
      !isPopoutWindow && !isWorkspaceWindow
        ? {
            apiBaseUrl: cloudConnection.apiBaseUrl,
            backendUrl: cloudConnection.backendUrl,
            socketBaseUrl: cloudConnection.socketBaseUrl,
            isConnected: cloudConnection.isConnected,
            token: cloudConnection.token,
            user: cloudConnection.user,
            preferencesLoaded: appPreferences?.loaded ?? false,
          }
        : undefined,
    [
      isPopoutWindow,
      isWorkspaceWindow,
      cloudConnection.apiBaseUrl,
      cloudConnection.backendUrl,
      cloudConnection.socketBaseUrl,
      cloudConnection.isConnected,
      cloudConnection.token,
      cloudConnection.user,
      appPreferences?.loaded,
    ]
  )
  const cloudApiBaseUrl = cloudConnection.apiBaseUrl
  const cloudToken = cloudConnection.token
  const titlebarOverlaysContent = false
  const showChromeTitlebar = (isDesktop || isElectron) && !isPopoutWindow
  const isIsolatedSurface = deviceSurfaceExtension.isIsolatedSurface(path, search)
  const workspaceTabStorageScope = useMemo(
    () => (isElectron ? (currentWindowLabel ?? 'main') : browserWorkspaceTabStorageScope()),
    [currentWindowLabel, isElectron]
  )
  const workspaceTabLabels = useMemo(
    () => ({
      task: t('workbench.workspace_tab_task', '任务'),
      board: t('workbench.workspace_tab_board', '协作'),
      agent: t('workbench.workspace_tab_agent', '智能体'),
      auxiliary: t('workbench.workspace_tab_auxiliary', '工作区'),
      auxiliaryRoutes: {
        ...Object.fromEntries(
          registeredRoutes.map(route => [
            route.path,
            t(route.titleKey ?? route.id, route.title ?? route.label ?? route.id),
          ])
        ),
        [INTERACTIONS_PATH]: t('interactions.title', '待你处理'),
        [COLLABORATION_EXP_PATH]: t('workbench.workspace_tab_collaboration_exp', '协作 exp'),
      },
    }),
    [registeredRoutes, t]
  )
  const fixedWorkspaceTabs = useMemo(
    () =>
      appPreferences?.loaded
        ? appPreferences.preferences.fixedWorkspaceTabs.flatMap(preference => {
            const belongsToCurrentWindow = isMainWindow
              ? !preference.windowLabel
              : preference.windowLabel === currentWindowLabel
            if (!belongsToCurrentWindow) return []
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
                ...(preference.title ? { title: preference.title } : {}),
                ...(preference.contentRoute ? { contentRoute: preference.contentRoute } : {}),
                fixed: true,
              }),
            ]
          })
        : [],
    [appPreferences, currentWindowLabel, isMainWindow, t, workspaceTabLabels]
  )
  const startupWorkspaceTabId = useMemo(() => {
    if (!isMainWindow || !appPreferences?.loaded) return undefined
    const visibleFixedTabs = fixedWorkspaceTabs.filter(
      tab =>
        appPreferences.preferences.collaborationExperienceEnabled ||
        !isCollaborationExpPath(tab.contentRoute)
    )
    const preferredId = appPreferences.preferences.startupWorkspaceTabId
    return visibleFixedTabs.some(tab => tab.id === preferredId)
      ? preferredId
      : visibleFixedTabs[0]?.id
  }, [appPreferences, fixedWorkspaceTabs, isMainWindow])
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
  const idleMaintenanceEligible =
    isMainWindow &&
    isElectron &&
    !isLoading &&
    Boolean(user) &&
    appPreferences?.loaded === true &&
    !isIsolatedSurface &&
    path !== '/login' &&
    path !== '/login/oidc'
  const [appSession] = useState(createAppShellSession)
  const subscribeApp = useCallback(
    (listener: () => void) =>
      appSession.subscribe(listener, {
        ownershipKey,
        telemetry: {
          user: cloudConnection.user ?? user,
          isLoading,
          enabled: telemetryEnabled,
          explicitlyDisabled:
            sessionConsent === false ||
            (appPreferences?.loaded === true &&
              appPreferences.preferences.telemetryConsentAsked === true &&
              appPreferences.preferences.telemetryEnabled !== true),
          electronRuntime: isElectron,
          pathname: path,
          search,
          feature: registeredRoutes.find(route => route.path === path)?.telemetryFeature,
        },
        dshContext,
        t,
        isDesktop,
        isElectron,
        isMainWindow,
        isPopoutWindow,
        isLoading,
        path,
        assistantPreferenceFailed,
        idleMaintenanceEligible,
        imPresence: {
          enabled: isMainWindow && isElectron && cloudConnection.isConnected,
          scopeKey: ownershipKey,
          updatePresence: updateImNotificationPresence,
        },
      }),
    [
      appSession,
      ownershipKey,
      cloudConnection.user,
      user,
      telemetryEnabled,
      sessionConsent,
      appPreferences,
      search,
      registeredRoutes,
      dshContext,
      t,
      isDesktop,
      isElectron,
      isMainWindow,
      isPopoutWindow,
      isLoading,
      path,
      assistantPreferenceFailed,
      idleMaintenanceEligible,
      cloudConnection.isConnected,
      updateImNotificationPresence,
    ]
  )
  const appSnapshot = useSyncExternalStore(
    subscribeApp,
    appSession.getSnapshot,
    appSession.getSnapshot
  )
  const workbenchStartupReady =
    appSnapshot.ownershipKey === ownershipKey && appSnapshot.workbenchStartupReady
  const setWorkbenchStartupReady = useCallback(
    (ready: boolean) => appSession.setWorkbenchStartupReady(ownershipKey, ready),
    [appSession, ownershipKey]
  )
  useDOMEvent<KeyboardEvent>('window', 'keydown', appSession.handleKeyDown, {
    enabled: isDesktop && !isPopoutWindow,
    capture: true,
  })
  useDOMEvent<MouseEvent>('window', 'mouseup', appSession.handleMouseUp, {
    enabled: isDesktop && !isPopoutWindow,
  })
  useDOMEvent(
    'window',
    KEYBINDINGS_CHANGED_EVENT,
    () => {
      void appSession.loadKeybindings()
    },
    { enabled: isDesktop && !isPopoutWindow }
  )
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
          <div className="flex h-dvh flex-col" data-testid="workbench-startup">
            <MacOSTitleBarDragRegion className="h-10 shrink-0" />
            <LocalRuntimeNotice />
          </div>
        </LocalRuntimeInitializer>
      </CodexHomeInitializer>
    )
  }

  if (!user) {
    return <AppRoutes />
  }

  if (isIsolatedSurface) {
    const isolatedShell = (
      <div
        data-testid="app-shell"
        className="fixed inset-0 flex flex-col overflow-hidden bg-background"
      >
        <LocalRuntimeNotice />
        <div data-testid="app-route-host" className="min-h-0 flex-1 overflow-hidden">
          <AppRoutes />
        </div>
      </div>
    )
    return (
      <CodexHomeInitializer>
        <LocalRuntimeInitializer
          startupReady={workbenchStartupReady}
          cloudConnection={localExecutorCloudInput}
        >
          {isolatedShell}
        </LocalRuntimeInitializer>
      </CodexHomeInitializer>
    )
  }

  const shell = (
    <NotificationTaskSourceProvider key={ownershipKey}>
      <WorkspaceTabsProvider
        pathname={path}
        search={search}
        storageScope={
          isMainWindow ? `${workspaceTabStorageScope}:${ownershipKey}` : workspaceTabStorageScope
        }
        labels={workspaceTabLabels}
        fixedTabs={fixedWorkspaceTabs}
        startupTabId={startupWorkspaceTabId}
        restoreSessionTabs={!isMainWindow}
        retainedTabPaths={isMainWindow ? COLLABORATION_EXP_TAB_PATHS : undefined}
        hiddenTabPaths={
          appPreferences?.preferences.collaborationExperienceEnabled
            ? undefined
            : COLLABORATION_EXP_TAB_PATHS
        }
      >
        <RuntimeInteractionsProvider accountKey={ownershipKey}>
          <div
            data-testid="app-shell"
            className={cn(
              isDesktop ? 'fixed inset-0' : 'h-dvh',
              isPopoutWindow
                ? 'overflow-visible bg-transparent'
                : isWorkspaceWindow
                  ? 'overflow-hidden bg-[rgb(var(--color-titlebar))]'
                  : hasWorkbenchBackground
                    ? 'overflow-hidden bg-transparent'
                    : 'overflow-hidden bg-surface',
              titlebarOverlaysContent ? 'relative' : 'flex flex-col'
            )}
          >
            {showChromeTitlebar && (
              <ChromeTitlebar
                showWorkspacePortals={activeAppKey !== 'wework'}
                afterTabs={
                  isCollaborationExpPath(path) &&
                  appPreferences?.preferences.collaborationExperienceEnabled ? (
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      className={DESKTOP_TOP_BAR_BUTTON_CLASS}
                      aria-label={t('workbench.settings')}
                      title={t('workbench.settings')}
                      data-testid="collaboration-host-settings"
                      onClick={() => navigateTo('/settings')}
                    >
                      <Settings aria-hidden="true" />
                    </ControlButton>
                  ) : undefined
                }
              />
            )}
            {isDesktop && !isPopoutWindow && !isWorkspaceWindow ? <RuntimeTaskCloseGuard /> : null}
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
            {!isPopoutWindow && !isWorkspaceWindow && <RuntimeInteractionNotice />}
            {isElectron && !isPopoutWindow && !isWorkspaceWindow && <PluginPythonRuntimeNotice />}
          </div>
        </RuntimeInteractionsProvider>
      </WorkspaceTabsProvider>
    </NotificationTaskSourceProvider>
  )

  if (isPopoutWindow) {
    return shell
  }

  return (
    <CodexHomeInitializer>
      <LocalRuntimeInitializer
        startupReady={workbenchStartupReady}
        cloudConnection={localExecutorCloudInput}
      >
        {shell}
      </LocalRuntimeInitializer>
    </CodexHomeInitializer>
  )
}
