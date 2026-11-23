import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { createAuthApi } from '@/api/auth'
import { createHttpClient } from '@/api/http'
import { getRuntimeConfig } from '@/config/runtime'
import { AuthContext, type AuthContextValue } from './useAuth'
import { createAuthSession, type AuthApi } from './authSession'

interface AuthProviderProps {
  children: ReactNode
  authApi?: AuthApi
}

function createDefaultAuthApi(captureOwnership: () => () => boolean): AuthApi {
  const { apiBaseUrl } = getRuntimeConfig()
  // The session checks request ownership before clearing credentials or redirecting.
  return createAuthApi(createHttpClient({ baseUrl: apiBaseUrl, redirectOnUnauthorized: false }), {
    captureOwnership,
  })
}

export function AuthProvider({ children, authApi }: AuthProviderProps) {
  const source = useMemo(
    () => createAuthSession(authApi ?? createDefaultAuthApi, authApi === undefined),
    [authApi]
  )
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const value = useMemo<AuthContextValue>(
    () => ({
      user: snapshot.user,
      isLoading: snapshot.isLoading,
      adminPasswordSetupRequired: snapshot.adminPasswordSetupRequired,
      adminUsername: snapshot.adminUsername,
      login: source.login,
      logout: source.logout,
      refresh: source.refresh,
      loginWithOidcToken: source.loginWithOidcToken,
      setupAdminPassword: source.setupAdminPassword,
    }),
    [source, snapshot]
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
