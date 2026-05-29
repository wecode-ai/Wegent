import { useEffect, useState } from 'react'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { useAuth } from '@/features/auth/useAuth'
import { WorkbenchProvider } from '@/features/workbench/WorkbenchProvider'
import { OidcCallbackPage } from '@/pages/OidcCallbackPage'
import { LoginPage } from '@/pages/LoginPage'
import { WorkbenchPage } from '@/pages/WorkbenchPage'
import { PluginsPage } from '@/pages/PluginsPage'
import { PluginManagementPage } from '@/pages/PluginManagementPage'
import { stripAppBasePath } from '@/config/runtime'

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

  if (path === '/login') {
    return <LoginPage />
  }

  if (path === '/login/oidc') {
    return <OidcCallbackPage />
  }

  if (isLoading || !user) {
    return null
  }

  return (
    <WorkbenchProvider user={user}>
      {path === '/plugins/manage' ? (
        <PluginManagementPage />
      ) : path === '/plugins' ? (
        <PluginsPage />
      ) : (
        <WorkbenchPage />
      )}
    </WorkbenchProvider>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  )
}
