import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  createAuthApi,
  isAuthenticated,
  removeToken,
  type LoginRequest,
} from '@/api/auth'
import { createHttpClient } from '@/api/http'
import { getRuntimeConfig } from '@/config/runtime'
import type { User } from '@/types/api'
import {
  LOGIN_PATH,
  OIDC_CALLBACK_PATH,
  getCurrentRedirectTarget,
  redirectToLogin,
} from './redirect'
import { AuthContext, type AuthContextValue } from './useAuth'

type AuthApi = ReturnType<typeof createAuthApi>

interface AuthProviderProps {
  children: ReactNode
  authApi?: AuthApi
}

function createDefaultAuthApi(): AuthApi {
  const { apiBaseUrl } = getRuntimeConfig()
  return createAuthApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function isAuthRoute(pathname: string) {
  return pathname === LOGIN_PATH || pathname === OIDC_CALLBACK_PATH
}

export function AuthProvider({ children, authApi }: AuthProviderProps) {
  const resolvedAuthApi = useMemo(() => authApi ?? createDefaultAuthApi(), [authApi])
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const userRef = useRef<User | null>(null)

  useEffect(() => {
    userRef.current = user
  }, [user])

  const refresh = useCallback(async () => {
    setIsLoading(true)

    try {
      if (!isAuthenticated()) {
        setUser(null)
        if (!isAuthRoute(window.location.pathname)) {
          redirectToLogin()
        }
        return
      }

      const currentUser = await resolvedAuthApi.getCurrentUser()
      setUser(currentUser)
    } catch {
      removeToken()
      setUser(null)
      if (!isAuthRoute(window.location.pathname)) {
        redirectToLogin()
      }
    } finally {
      setIsLoading(false)
    }
  }, [resolvedAuthApi])

  useEffect(() => {
    refresh()

    const interval = window.setInterval(() => {
      if (!isAuthenticated() && userRef.current) {
        setUser(null)
        redirectToLogin()
      }
    }, 10000)

    return () => window.clearInterval(interval)
  }, [refresh])

  const login = useCallback(
    async (data: LoginRequest) => {
      setIsLoading(true)
      try {
        const loggedInUser = await resolvedAuthApi.login(data)
        setUser(loggedInUser)
        return loggedInUser
      } finally {
        setIsLoading(false)
      }
    },
    [resolvedAuthApi],
  )

  const logout = useCallback(() => {
    resolvedAuthApi.logout()
    setUser(null)
    redirectToLogin()
  }, [resolvedAuthApi])

  const loginWithOidcToken = useCallback(
    async (accessToken: string) => {
      await resolvedAuthApi.loginWithOidcToken(accessToken)
    },
    [resolvedAuthApi],
  )

  const value: AuthContextValue = {
    user,
    isLoading,
    login,
    logout,
    refresh,
    loginWithOidcToken,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export { getCurrentRedirectTarget }
