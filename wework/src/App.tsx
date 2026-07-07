import { useEffect, useState } from 'react'
import { PanelLeft } from 'lucide-react'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { useAuth } from '@/features/auth/useAuth'
import { WorkbenchProvider } from '@/features/workbench/WorkbenchProvider'
import { OidcCallbackPage } from '@/pages/OidcCallbackPage'
import { LoginPage } from '@/pages/LoginPage'
import { WorkbenchPage } from '@/pages/WorkbenchPage'
import { PluginsPage } from '@/pages/PluginsPage'
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
import { CloudConnectionProvider } from '@/features/cloud-connection/CloudConnectionProvider'
import { LocalExecutorCloudBridge } from '@/features/cloud-connection/LocalExecutorCloudBridge'
import {
  requestDesktopSidebarToggle,
  useDesktopSidebarCollapsed,
} from '@/components/layout/useDesktopSidebarCollapsed'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from '@/components/layout/DesktopTopBar'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { createLocalAppServices } from '@/api/local/localServices'
import { defaultAppPreferences, getAppPreferences } from '@/tauri/appPreferences'
import { applyLanguagePreference } from '@/i18n/languagePreference'
import {
  KEYBINDINGS_CHANGED_EVENT,
  GO_BACK_COMMAND,
  GO_FORWARD_COMMAND,
  OPEN_SETTINGS_COMMAND,
  OPEN_TERMINAL_COMMAND,
  TOGGLE_SIDEBAR_COMMAND,
  TOGGLE_SIDE_PANEL_COMMAND,
  dispatchGoBackShortcut,
  dispatchGoForwardShortcut,
  dispatchOpenSettingsShortcut,
  dispatchOpenTerminalShortcut,
  dispatchToggleSidebarShortcut,
  dispatchToggleSidePanelShortcut,
  isEditableShortcutTarget,
  keybindingFromKeyboardEvent,
  mergeKeybindings,
} from '@/lib/keybindings'

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
}

function AppRoutes({ onWorkbenchStartupReadyChange }: AppRoutesProps = {}) {
  const path = useCurrentPath()
  const { user, isLoading } = useAuth()
  const { activeTab, isNativeApp } = useChromeTabs(path)

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

  // iframe-based apps (Wegent, etc.)
  if (!isNativeApp && activeTab?.mode === 'iframe' && activeTab.url) {
    return <AppIframe src={activeTab.url} title={activeTab.label} />
  }

  // native WeWork routes
  return (
    <WorkbenchProvider user={user} onStartupReadyChange={onWorkbenchStartupReadyChange}>
      {path === '/plugins/manage' ? (
        <PluginManagementPage />
      ) : path === '/plugins' ? (
        <PluginsPage />
      ) : path === '/apps' ? (
        <AppsPage />
      ) : (
        <WorkbenchPage />
      )}
    </WorkbenchProvider>
  )
}

export default function App() {
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

  useEffect(() => {
    if (!isTauri) return undefined

    let activeBindings = mergeKeybindings([])
    let disposed = false

    const loadKeybindings = async () => {
      try {
        const services = createLocalAppServices()
        const response = await services.runtimeWorkApi?.getKeybindings()
        if (!disposed) {
          activeBindings = mergeKeybindings(response?.keybindings ?? [])
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
      const eventKey = keybindingFromKeyboardEvent(event)
      const matchesRegisteredShortcut = [
        terminalKey,
        settingsKey,
        goBackKey,
        goForwardKey,
        sidebarKey,
        sidePanelKey,
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
    <LocalRuntimeInitializer startupReady={workbenchStartupReady || workbenchStartupRevealTimedOut}>
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
            onNavigate={navigateToApp}
            beforeTabs={
              activeAppKey === 'wework' ? (
                <TitlebarSidebarToggle />
              ) : (
                <TitlebarSidebarTogglePlaceholder />
              )
            }
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
          <AppRoutes onWorkbenchStartupReadyChange={setWorkbenchStartupReady} />
        </div>
      </div>
    </LocalRuntimeInitializer>
  )
}

function TitlebarSidebarTogglePlaceholder() {
  return (
    <div
      data-testid="titlebar-sidebar-toggle-placeholder"
      aria-hidden="true"
      className={cn(DESKTOP_TOP_BAR_BUTTON_CLASS, 'invisible pointer-events-none')}
    />
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
