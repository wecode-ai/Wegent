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
import { DeviceOnboardingGate } from '@wecode/features/local-executor/DeviceOnboardingGate'

function useCurrentPath() {
  const [path, setPath] = useState(stripAppBasePath(window.location.pathname))

  useEffect(() => {
    const handlePopState = () => setPath(stripAppBasePath(window.location.pathname))
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  return path
}

function AppRoutes() {
  const path = useCurrentPath()
  const { user, isLoading } = useAuth()
  const { activeTab, isNativeApp } = useChromeTabs(path)

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
    <WorkbenchProvider user={user}>
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
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </AppearanceProvider>
  )
}

function AppShell() {
  const path = useCurrentPath()
  const { user } = useAuth()
  const { activeAppKey, tabs, navigateToApp, activeTab, isNativeApp } = useChromeTabs(path)
  const isTauri = isTauriRuntime()

  // No chrome on login/setup pages
  if (path === '/login' || path === '/login/oidc' || !user) {
    return <AppRoutes />
  }

  const shell = (
    <div className="flex h-screen flex-col overflow-hidden bg-surface">
      {isTauri && (
        <ChromeTitlebar tabs={tabs} activeKey={activeAppKey} onNavigate={navigateToApp} />
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <AppRoutes />
      </div>
    </div>
  )

  // Device onboarding gates entry to the main workbench only. While onboarding,
  // the gate renders a standalone full-screen page without the chrome titlebar.
  const isIframeApp = !isNativeApp && activeTab?.mode === 'iframe' && Boolean(activeTab.url)
  const isMainWorkbenchRoute =
    !isIframeApp &&
    path !== '/plugins' &&
    path !== '/plugins/manage' &&
    path !== '/apps'

  if (isMainWorkbenchRoute) {
    return <DeviceOnboardingGate>{shell}</DeviceOnboardingGate>
  }

  return shell
}
