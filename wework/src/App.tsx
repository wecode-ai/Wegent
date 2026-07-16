import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, PanelLeft } from 'lucide-react'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { useAuth } from '@/features/auth/useAuth'
import { WorkbenchProvider } from '@/features/workbench/WorkbenchProvider'
import { OidcCallbackPage } from '@/pages/OidcCallbackPage'
import { LoginPage } from '@/pages/LoginPage'
import { WorkbenchPage } from '@/pages/WorkbenchPage'
import { PluginsPage } from '@/pages/PluginsPage'
import { PluginCreatePage } from '@/pages/PluginCreatePage'
import { PluginManagementPage } from '@/pages/PluginManagementPage'
import { AppsPage } from '@/pages/AppsPage'
import { stripAppBasePath } from '@/config/runtime'
import { AppearanceProvider } from '@/features/appearance'
import { ChromeTitlebar } from '@/components/topnav/ChromeTitlebar'
import { AppIframe } from '@/components/topnav/AppIframe'
import { useChromeTabs } from '@/components/topnav/useChromeTabs'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { AppUpdateProvider } from '@/features/app-update/AppUpdateProvider'
import { AppUpdateTitlebarButton } from '@/components/topnav/AppUpdateTitlebarButton'
import { TitlebarTooltip } from '@/components/topnav/TitlebarTooltip'
import { LocalRuntimeInitializer } from '@/features/local-runtime/LocalRuntimeInitializer'
import { CodexHomeInitializer } from '@/features/local-runtime/CodexHomeInitializer'
import { CloudConnectionProvider } from '@/features/cloud-connection/CloudConnectionProvider'
import { LocalExecutorCloudBridge } from '@/features/cloud-connection/LocalExecutorCloudBridge'
import {
  requestDesktopSidebarToggle,
  useDesktopSidebarCollapsed,
} from '@/components/layout/useDesktopSidebarCollapsed'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '@/components/layout/DesktopTopBar'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { navigateTo } from '@/lib/navigation'
import { createLocalAppServices } from '@/api/local/localServices'
import { defaultAppPreferences, getAppPreferences } from '@/tauri/appPreferences'
import { applyLanguagePreference } from '@/i18n/languagePreference'
import {
  KEYBINDINGS_CHANGED_EVENT,
  GO_BACK_COMMAND,
  GO_FORWARD_COMMAND,
  INCREASE_FONT_SIZE_COMMAND,
  DECREASE_FONT_SIZE_COMMAND,
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

const WORKBENCH_STARTUP_REVEAL_TIMEOUT_MS = 6000

function useCurrentPath() {
  const [path, setPath] = useState(stripAppBasePath(window.location.pathname))

  useEffect(() => {
    const handlePopState = () => setPath(stripAppBasePath(window.location.pathname))
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  return path
}

interface AppRoutesProps {
  onWorkbenchStartupReadyChange?: (ready: boolean) => void
  onOpenWeworkForAppshot?: () => void
}

function AppRoutes({ onWorkbenchStartupReadyChange, onOpenWeworkForAppshot }: AppRoutesProps = {}) {
  const path = useCurrentPath()
  const { user, isLoading } = useAuth()
  const { activeTab, isNativeApp } = useChromeTabs(path)
  const isAuxiliaryRoute =
    (!isNativeApp && activeTab?.mode === 'iframe' && Boolean(activeTab.url)) ||
    path === '/plugins/manage' ||
    path === '/plugins/create' ||
    path === '/plugins' ||
    path === '/apps'
  const [hasMountedWorkbench, setHasMountedWorkbench] = useState(() => !isAuxiliaryRoute)
  if (!isAuxiliaryRoute && !hasMountedWorkbench) setHasMountedWorkbench(true)

  useEffect(() => {
    if (isLoading || !user || isNativeApp || !activeTab?.url) return
    onWorkbenchStartupReadyChange?.(true)
  }, [activeTab?.url, isLoading, isNativeApp, onWorkbenchStartupReadyChange, user])

  if (path === '/login') {
    return <LoginPage />
  }

  if (path === '/login/oidc') {
    return <OidcCallbackPage />
  }

  if (isLoading || !user) {
    return null
  }

  const auxiliaryPage =
    !isNativeApp && activeTab?.mode === 'iframe' && activeTab.url ? (
      <AppIframe src={activeTab.url} title={activeTab.label} />
    ) : path === '/plugins/manage' ? (
      <PluginManagementPage />
    ) : path === '/plugins/create' ? (
      <PluginCreatePage />
    ) : path === '/plugins' ? (
      <PluginsPage />
    ) : path === '/apps' ? (
      <AppsPage />
    ) : null
  // Keep the workbench mounted while another top-level surface is visible. The
  // composer, terminals and in-app browser own live, non-serializable state, so
  // reconstructing them after every route change is both lossy and expensive.
  return (
    <WorkbenchProvider user={user} onStartupReadyChange={onWorkbenchStartupReadyChange}>
      {onOpenWeworkForAppshot ? <AppshotBridge onOpenWework={onOpenWeworkForAppshot} /> : null}
      {(!auxiliaryPage || hasMountedWorkbench) && (
        <div
          className={cn('h-full', auxiliaryPage && 'hidden')}
          aria-hidden={Boolean(auxiliaryPage)}
        >
          <WorkbenchPage />
        </div>
      )}
      {auxiliaryPage}
    </WorkbenchProvider>
  )
}

export default function App() {
  useEffect(() => {
    document.title = getWeworkDocumentTitle()
  }, [])

  useEffect(() => {
    let cancelled = false

    getAppPreferences()
      .then(preferences => {
        if (!cancelled) {
          return applyLanguagePreference(preferences.language)
        }
        return undefined
      })
      .catch(error => {
        console.error('[Wework] Failed to initialize language preference:', error)
        if (!cancelled) {
          return applyLanguagePreference(defaultAppPreferences.language)
        }
        return undefined
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <AppearanceProvider>
      <AppUpdateProvider>
        <CloudConnectionProvider>
          <AuthProvider>
            <AppShell />
          </AuthProvider>
        </CloudConnectionProvider>
      </AppUpdateProvider>
    </AppearanceProvider>
  )
}

function AppShell() {
  const path = useCurrentPath()
  const { user, isLoading } = useAuth()
  const { activeAppKey, tabs, navigateToApp } = useChromeTabs(path)
  const isTauri = isTauriRuntime()
  const titlebarOverlaysContent = isTauri && activeAppKey === 'wework'
  const showChromeTitlebar = isTauri && activeAppKey !== 'wework'
  const [workbenchStartupReady, setWorkbenchStartupReady] = useState(false)
  const [workbenchStartupRevealTimedOut, setWorkbenchStartupRevealTimedOut] = useState(false)
  const openWeworkForAppshot = useCallback(() => {
    navigateToApp('wework')
  }, [navigateToApp])

  useEffect(() => {
    if (!isTauri) return undefined

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
      if (event.defaultPrevented) return
      const terminalKey = activeBindings[OPEN_TERMINAL_COMMAND]
      const settingsKey = activeBindings[OPEN_SETTINGS_COMMAND]
      const goBackKey = activeBindings[GO_BACK_COMMAND]
      const goForwardKey = activeBindings[GO_FORWARD_COMMAND]
      const sidebarKey = activeBindings[TOGGLE_SIDEBAR_COMMAND]
      const sidePanelKey = activeBindings[TOGGLE_SIDE_PANEL_COMMAND]
      const modelSelectorKey = activeBindings[TOGGLE_MODEL_SELECTOR_COMMAND]
      const increaseFontSizeKey = activeBindings[INCREASE_FONT_SIZE_COMMAND]
      const decreaseFontSizeKey = activeBindings[DECREASE_FONT_SIZE_COMMAND]
      const eventKey = keybindingFromKeyboardEvent(event)
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
  }, [isTauri])

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
    return (
      <LocalRuntimeInitializer startupReady={false}>
        <div />
      </LocalRuntimeInitializer>
    )
  }

  if (!user) {
    return <AppRoutes />
  }

  return (
    <CodexHomeInitializer>
      <LocalRuntimeInitializer
        startupReady={workbenchStartupReady || workbenchStartupRevealTimedOut}
      >
        <LocalExecutorCloudBridge />
        <div
          className={cn(
            'h-dvh overflow-hidden bg-surface',
            titlebarOverlaysContent ? 'relative' : 'flex flex-col'
          )}
        >
          {showChromeTitlebar && (
            <ChromeTitlebar
              tabs={tabs}
              activeKey={activeAppKey}
              onNavigate={appKey =>
                appKey === 'todo' ? navigateTo('/todo') : navigateToApp(appKey)
              }
              beforeTabs={<TitlebarSidebarToggle />}
              afterTabs={<AppUpdateTitlebarButton />}
              iconOnlyTabs={isTauri}
              className={
                titlebarOverlaysContent
                  ? 'absolute inset-x-0 top-0 z-system bg-transparent'
                  : undefined
              }
            />
          )}
          <div
            className={cn('min-h-0 overflow-hidden', titlebarOverlaysContent ? 'h-full' : 'flex-1')}
          >
            <AppRoutes
              onWorkbenchStartupReadyChange={setWorkbenchStartupReady}
              onOpenWeworkForAppshot={isTauri ? openWeworkForAppshot : undefined}
            />
          </div>
          <WeworkDevInstanceBadge />
        </div>
      </LocalRuntimeInitializer>
    </CodexHomeInitializer>
  )
}

function WeworkDevInstanceBadge() {
  const info = getWeworkDevInstanceInfo()
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  if (!info) return null

  const rows = getWeworkDevInstanceRows(info)
  const copyValue = async (key: string, value: string) => {
    await navigator.clipboard?.writeText(value)
    setCopiedKey(key)
    window.setTimeout(() => setCopiedKey(current => (current === key ? null : current)), 1200)
  }

  return (
    <div
      data-testid="wework-dev-instance-badge"
      className="group pointer-events-auto fixed bottom-3 right-3 z-critical max-w-[min(460px,calc(100vw-1.5rem))]"
    >
      <div className="ml-auto max-w-[min(240px,calc(100vw-1.5rem))] truncate rounded-md border border-border/80 bg-background/95 px-2.5 py-1.5 text-xs font-medium text-text-secondary shadow-[0_8px_24px_rgba(0,0,0,0.12)] backdrop-blur">
        <span className="text-text-primary">{info.title}</span>
      </div>
      <div className="pointer-events-none absolute bottom-full right-0 w-[min(460px,calc(100vw-1.5rem))] translate-y-1 pb-2 text-xs opacity-0 transition group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100">
        <div className="rounded-lg border border-border/80 bg-background/98 p-2 shadow-[0_18px_48px_rgba(0,0,0,0.18)] backdrop-blur">
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

function TitlebarSidebarToggle() {
  const { t } = useTranslation('common')
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  const label = sidebarCollapsed
    ? t('workbench.expand_sidebar', '展开侧边栏')
    : t('workbench.collapse_sidebar', '收起侧边栏')

  return (
    <TitlebarTooltip
      label={t('workbench.toggle_sidebar', '切换边栏')}
      shortcut="Command+B"
      align="start"
    >
      <button
        type="button"
        data-testid={sidebarCollapsed ? 'expand-sidebar-button' : 'collapse-sidebar-button'}
        onClick={() => {
          if (!requestDesktopSidebarToggle()) {
            setSidebarCollapsed(!sidebarCollapsed)
          }
        }}
        className={DESKTOP_TOP_BAR_BUTTON_CLASS}
        aria-label={label}
        aria-pressed={sidebarCollapsed}
      >
        <PanelLeft />
      </button>
    </TitlebarTooltip>
  )
}
