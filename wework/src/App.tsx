import { useEffect, useState } from 'react'
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
import { LocalRuntimeInitializer } from '@/features/local-runtime/LocalRuntimeInitializer'
import { CloudConnectionProvider } from '@/features/cloud-connection/CloudConnectionProvider'
import { LocalExecutorCloudBridge } from '@/features/cloud-connection/LocalExecutorCloudBridge'

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
  const [workbenchStartupReady, setWorkbenchStartupReady] = useState(false)
  const [workbenchStartupRevealTimedOut, setWorkbenchStartupRevealTimedOut] = useState(false)

  useEffect(() => {
    if (path === '/login' || path === '/login/oidc' || isLoading || !user || workbenchStartupReady) {
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
      <div className="flex h-screen flex-col overflow-hidden bg-surface">
        {isTauri && (
          <ChromeTitlebar
            tabs={tabs}
            activeKey={activeAppKey}
            onNavigate={navigateToApp}
            afterTabs={<AppUpdateTitlebarButton />}
          />
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          <AppRoutes onWorkbenchStartupReadyChange={setWorkbenchStartupReady} />
        </div>
      </div>
    </LocalRuntimeInitializer>
  )
}
