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
import { Check, Copy, Info, Minimize2 } from 'lucide-react'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { useAuth } from '@/features/auth/useAuth'
import { WorkbenchProvider } from '@/features/workbench/WorkbenchProvider'
import { RuntimeTaskCloseGuard } from '@/features/workbench/RuntimeTaskCloseGuard'
import { OidcCallbackPage } from '@/pages/OidcCallbackPage'
import { LoginPage } from '@/pages/LoginPage'
import { WorkbenchPage } from '@/pages/WorkbenchPage'
import { PluginsPage } from '@/pages/PluginsPage'
import { PluginCreatePage } from '@/pages/PluginCreatePage'
import { PluginManagementPage } from '@/pages/PluginManagementPage'
import { AppsPage } from '@/pages/AppsPage'
import { SitesPage } from '@/pages/SitesPage'
import { AutomationsPage } from '@/pages/AutomationsPage'
import { CloudWorkPage } from '@/pages/CloudWorkPage'
import { PopoutWorkbenchPage } from '@/pages/PopoutWorkbenchPage'
import { stripAppBasePath } from '@/config/runtime'
import { AppearanceProvider } from '@/features/appearance'
import { ChromeTitlebar } from '@/components/topnav/ChromeTitlebar'
import { AppIframe } from '@/components/topnav/AppIframe'
import { useChromeTabs } from '@/components/topnav/useChromeTabs'
import { APP_TABS } from '@/config/apps'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { getPlatform } from '@/lib/platform'
import { AppUpdateProvider } from '@/features/app-update/AppUpdateProvider'
import { LocalRuntimeInitializer } from '@/features/local-runtime/LocalRuntimeInitializer'
import { CodexHomeInitializer } from '@/features/local-runtime/CodexHomeInitializer'
import { CloudConnectionProvider } from '@/features/cloud-connection/CloudConnectionProvider'
import { useCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { LocalExecutorCloudBridge } from '@/features/cloud-connection/LocalExecutorCloudBridge'
import { cn } from '@/lib/utils'
import { navigateTo } from '@/lib/navigation'
import { createLocalAppServices } from '@/api/local/localServices'
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
import { SystemDragPanel } from '@/features/system-drag/SystemDragPanel'
import { SystemDragBridge } from '@/features/system-drag/SystemDragBridge'
import { installMacOSInputArrowKeyGuard } from '@/lib/macosInputArrowKeyGuard'
import { useExperimentalFeaturesState } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { AppPreferencesProvider } from '@/features/app-preferences/AppPreferencesProvider'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useTranslation } from '@/hooks/useTranslation'
import { WorkspaceTabsProvider } from '@/features/workspace-tabs/WorkspaceTabsContext'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import type { WorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'
import type { User } from '@/types/api'
import { WorkspaceTabPortalOwner } from '@/components/topnav/TitlebarActionsPortal'
import { setActiveWorkspaceTabPortalOwner } from '@/components/topnav/workspaceTabPortalOwnership'

const WORKBENCH_STARTUP_REVEAL_TIMEOUT_MS = 6000
const POPOUT_WINDOW_LABEL = 'popout-window'

function isPopoutWindowRuntime() {
  return isTauriRuntime() && getCurrentWindow().label === POPOUT_WINDOW_LABEL
}

function hasTauriIpc() {
  const internals = (
    window as typeof window & {
      __TAURI_INTERNALS__?: { invoke?: unknown; transformCallback?: unknown }
    }
  ).__TAURI_INTERNALS__
  return (
    typeof internals?.invoke === 'function' && typeof internals.transformCallback === 'function'
  )
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
): { src: string; title: string } | null {
  const match = workspaceTabPath(tab).match(/^\/app\/([^/]+)/)
  if (!match) return null
  const app = APP_TABS.find(candidate => candidate.key === match[1])
  if (!app || app.mode !== 'iframe') return null
  const src = app.key === 'wegent' ? wegentUrl : app.url
  return src ? { src, title: app.label } : null
}

function workspaceTabAuxiliaryPage(path: string, experimentalFeaturesEnabled: boolean) {
  if (path === '/plugins/manage') return <PluginManagementPage />
  if (path === '/plugins/create') return <PluginCreatePage />
  if (path === '/plugins') return <PluginsPage />
  if (path === '/cloud-work') return <CloudWorkPage />
  if (path === '/sites') return <SitesPage />
  if (path === '/automations' && experimentalFeaturesEnabled) return <AutomationsPage />
  if (path === '/apps') return <AppsPage />
  return null
}

interface WorkspaceTabSurfaceProps {
  active: boolean
  cloudWebUrl: string | null | undefined
  experimentalFeaturesEnabled: boolean
  onOpenWeworkForAppshot?: () => void
  onWorkbenchStartupReadyChange?: (ready: boolean) => void
  tab: WorkspaceTab
  user: User
}

function WorkspaceTabSurface({
  active,
  cloudWebUrl,
  experimentalFeaturesEnabled,
  onOpenWeworkForAppshot,
  onWorkbenchStartupReadyChange,
  tab,
  user,
}: WorkspaceTabSurfaceProps) {
  const tabPath = workspaceTabPath(tab)
  const iframe = workspaceTabIframe(tab, cloudWebUrl)
  const auxiliaryPage = workspaceTabAuxiliaryPage(tabPath, experimentalFeaturesEnabled)
  const auxiliaryActive = Boolean(auxiliaryPage)
  const nativeWorkbenchActive = !iframe && !auxiliaryActive
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
  const usesAuxiliaryDesktopSurface = auxiliaryActive && isTauriRuntime()
  const usesWorkbenchDesktopSurface = nativeWorkbenchActive && isTauriRuntime()

  return (
    <WorkspaceTabPortalOwner ownerId={tab.id}>
      <Activity mode={active ? 'visible' : 'hidden'}>
        <div
          className="h-full"
          data-testid={`workspace-tab-content-${tab.id}`}
          data-workspace-tab-content={tab.id}
        >
          {renderProvider ? (
            <WorkbenchProvider
              user={user}
              onStartupReadyChange={active && !iframe ? onWorkbenchStartupReadyChange : undefined}
              workspaceTabId={tab.id}
            >
              {onOpenWeworkForAppshot && active && !iframe ? (
                <AppshotBridge onOpenWework={onOpenWeworkForAppshot} />
              ) : null}
              {renderWorkbench ? (
                <div
                  data-testid="desktop-workbench-surface"
                  className={cn(
                    'h-full',
                    usesWorkbenchDesktopSurface &&
                      'app-view-surface overflow-hidden rounded-xl border border-border/60 bg-background shadow-[0_3px_16px_rgba(0,0,0,0.04)]',
                    !nativeWorkbenchActive && 'hidden'
                  )}
                  aria-hidden={!nativeWorkbenchActive}
                >
                  <WorkbenchPage routeActive={active && nativeWorkbenchActive} />
                </div>
              ) : null}
              {auxiliaryPage ? (
                <div
                  data-testid="desktop-auxiliary-surface"
                  className={cn(
                    'h-full',
                    usesAuxiliaryDesktopSurface &&
                      'app-view-surface overflow-hidden rounded-xl border border-border/60 bg-background shadow-[0_3px_16px_rgba(0,0,0,0.04)]'
                  )}
                >
                  {auxiliaryPage}
                </div>
              ) : null}
            </WorkbenchProvider>
          ) : null}
          {renderedIframe ? (
            <div className={cn('h-full', !iframe && 'hidden')} aria-hidden={!iframe}>
              <AppIframe
                active={active && Boolean(iframe)}
                src={renderedIframe.src}
                title={renderedIframe.title}
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
  const isPopoutWindow = isPopoutWindowRuntime()
  const { user, isLoading } = useAuth()
  const cloudConnection = useCloudConnection()
  const experimentalFeatures = useExperimentalFeaturesState()
  const workspaceTabs = useOptionalWorkspaceTabs()
  const [mountedTabs, setMountedTabs] = useState(() => ({
    activeTabId: workspaceTabs?.activeTabId ?? null,
    ids: new Set(workspaceTabs ? [workspaceTabs.activeTabId] : []),
  }))
  if (workspaceTabs && mountedTabs.activeTabId !== workspaceTabs.activeTabId) {
    setMountedTabs({
      activeTabId: workspaceTabs.activeTabId,
      ids: new Set([...mountedTabs.ids, workspaceTabs.activeTabId]),
    })
  }

  useLayoutEffect(() => {
    setActiveWorkspaceTabPortalOwner(workspaceTabs?.activeTabId ?? null)
  }, [workspaceTabs?.activeTabId])

  useEffect(() => {
    if (path === '/automations' && experimentalFeatures.loaded && !experimentalFeatures.enabled) {
      navigateTo('/')
    }
  }, [experimentalFeatures.enabled, experimentalFeatures.loaded, path])

  if (path === '/login') {
    return <LoginPage />
  }

  if (path === '/login/oidc') {
    return <OidcCallbackPage />
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
      <WorkbenchProvider user={user} onStartupReadyChange={onWorkbenchStartupReadyChange}>
        {hasTauriIpc() && <SystemDragBridge />}
        <PopoutWorkbenchPage />
      </WorkbenchProvider>
    )
  }

  if (!workspaceTabs) return null

  return workspaceTabs.tabs.map(tab => {
    if (tab.id !== workspaceTabs.activeTabId && !mountedTabs.ids.has(tab.id)) return null
    return (
      <WorkspaceTabSurface
        key={tab.id}
        active={tab.id === workspaceTabs.activeTabId}
        cloudWebUrl={
          cloudConnection.webUrl
            ? buildCloudAppUrl(cloudConnection.webUrl, cloudConnection.token)
            : cloudConnection.webUrl
        }
        experimentalFeaturesEnabled={experimentalFeatures.enabled}
        onOpenWeworkForAppshot={onOpenWeworkForAppshot}
        onWorkbenchStartupReadyChange={onWorkbenchStartupReadyChange}
        tab={tab}
        user={user}
      />
    )
  })
}

export default function App() {
  const path = useCurrentPath()
  if (isTauriRuntime() && path === '/system-drag') {
    return <SystemDragPanel />
  }

  return <MainApp />
}

function MainApp() {
  const isPopoutWindow = isPopoutWindowRuntime()

  useEffect(() => {
    document.title = getWeworkDocumentTitle()
  }, [])

  return (
    <AppearanceProvider>
      <AppPreferencesProvider>
        <LanguagePreferenceInitializer />
        <AppUpdateProvider>
          <CloudConnectionProvider initializeSitesPlugin={!isPopoutWindow}>
            <AuthProvider>
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
  const { pathname: path, search } = useCurrentLocation()
  const { user, isLoading } = useAuth()
  const cloudConnection = useCloudConnection()
  const initialCloudConnection = {
    backendUrl: cloudConnection.backendUrl,
    socketBaseUrl: cloudConnection.socketBaseUrl,
    isConnected: cloudConnection.isConnected,
    token: cloudConnection.token,
  }
  const { activeAppKey, navigateToApp } = useChromeTabs(path)
  const isTauri = isTauriRuntime()
  const isPopoutWindow = isPopoutWindowRuntime()
  const isWorkspaceWindow = isTauri && getCurrentWindow().label?.startsWith('workspace-') === true
  const usesDesktopVibrancy = isTauri && !isPopoutWindow && getPlatform() === 'mac'
  const titlebarOverlaysContent = false
  const showChromeTitlebar = isTauri && !isPopoutWindow
  const workspaceTabStorageScope = useMemo(
    () => (isTauri ? getCurrentWindow().label : browserWorkspaceTabStorageScope()),
    [isTauri]
  )
  const workspaceTabLabels = useMemo(
    () => ({
      task: t('workbench.workspace_tab_task', '任务'),
      board: t('workbench.workspace_tab_board', '项目空间'),
      agent: t('workbench.workspace_tab_agent', '智能体'),
      auxiliary: t('workbench.workspace_tab_auxiliary', '工作区'),
      auxiliaryRoutes: {
        plugins: t('workbench.workspace_tab_plugins', '插件'),
        sites: t('workbench.workspace_tab_sites', '应用'),
        automations: t('workbench.workspace_tab_automations', '自动化'),
        cloud: t('workbench.workspace_tab_cloud', '云端工作'),
        apps: t('workbench.workspace_tab_apps', '应用'),
      },
    }),
    [t]
  )
  const [workbenchStartupReady, setWorkbenchStartupReady] = useState(false)
  const [workbenchStartupRevealTimedOut, setWorkbenchStartupRevealTimedOut] = useState(false)
  const openWeworkForAppshot = useCallback(() => {
    navigateToApp('wework')
  }, [navigateToApp])

  useEffect(() => {
    if (!usesDesktopVibrancy) return undefined

    document.documentElement.dataset.desktopVibrancy = 'true'
    return () => {
      delete document.documentElement.dataset.desktopVibrancy
    }
  }, [usesDesktopVibrancy])

  useEffect(() => {
    if (!isTauri || isPopoutWindow) return undefined

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
  }, [isPopoutWindow, isTauri])

  useEffect(() => {
    return installMacOSInputArrowKeyGuard()
  }, [])

  useEffect(() => {
    if (
      path === '/login' ||
      path === '/login/oidc' ||
      isLoading ||
      !user ||
      workbenchStartupReady
    ) {
      return undefined
    }

    const timer = window.setTimeout(() => {
      console.warn(
        `[Wework] Workbench startup has not completed after ${WORKBENCH_STARTUP_REVEAL_TIMEOUT_MS}ms; revealing shell while requests continue.`
      )
      setWorkbenchStartupRevealTimedOut(true)
    }, WORKBENCH_STARTUP_REVEAL_TIMEOUT_MS)

    return () => window.clearTimeout(timer)
  }, [activeAppKey, isLoading, path, user, workbenchStartupReady])

  // No chrome on login/setup pages
  if (path === '/login' || path === '/login/oidc') {
    return <AppRoutes />
  }

  if (isLoading) {
    if (isPopoutWindow) {
      return <div className="h-dvh bg-transparent" />
    }
    return (
      <CodexHomeInitializer>
        <LocalRuntimeInitializer
          initialCloudConnection={initialCloudConnection}
          startupReady={false}
        >
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
    >
      <div
        className={cn(
          'h-dvh',
          isPopoutWindow
            ? 'overflow-visible bg-transparent'
            : isWorkspaceWindow
              ? 'overflow-hidden bg-[rgb(var(--color-titlebar))]'
              : usesDesktopVibrancy
                ? 'overflow-hidden bg-transparent'
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
        {isTauri && !isPopoutWindow && !isWorkspaceWindow ? <RuntimeTaskCloseGuard /> : null}
        {!isPopoutWindow && !isWorkspaceWindow ? (
          <LocalExecutorCloudBridge
            apiBaseUrl={cloudConnection.apiBaseUrl}
            backendUrl={cloudConnection.backendUrl}
            socketBaseUrl={cloudConnection.socketBaseUrl}
            isConnected={cloudConnection.isConnected}
            token={cloudConnection.token}
          />
        ) : null}
        <div
          className={cn(
            'relative min-h-0',
            isPopoutWindow ? 'overflow-visible' : 'overflow-hidden',
            titlebarOverlaysContent ? 'h-full' : 'flex-1'
          )}
        >
          <AppRoutes
            onWorkbenchStartupReadyChange={setWorkbenchStartupReady}
            onOpenWeworkForAppshot={isTauri ? openWeworkForAppshot : undefined}
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
        startupReady={workbenchStartupReady || workbenchStartupRevealTimedOut}
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
