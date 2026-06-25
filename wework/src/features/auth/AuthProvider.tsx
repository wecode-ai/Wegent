import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createAuthApi, isAuthenticated, removeToken, type LoginRequest } from '@/api/auth'
import { ApiError, createHttpClient } from '@/api/http'
import { getLocalUser } from '@/api/local/localSession'
import { getRuntimeConfig, stripAppBasePath } from '@/config/runtime'
import { isTauriRuntime } from '@/lib/runtime-environment'
import type { User } from '@/types/api'
import {
  getAdminUsernameFromSetupError,
  INITIAL_ADMIN_USERNAME,
  isAdminPasswordSetupRequiredError,
} from './adminPasswordSetup'
import { LOGIN_PATH, OIDC_CALLBACK_PATH, redirectToLogin } from './redirect'
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

function isLocalFirstRuntime(): boolean {
  return getRuntimeConfig().runtimeMode === 'local-first' && isTauriRuntime()
}

function isAuthRoute(pathname: string) {
  const appPath = stripAppBasePath(pathname)
  return appPath === LOGIN_PATH || appPath === OIDC_CALLBACK_PATH
}

export function AuthProvider({ children, authApi }: AuthProviderProps) {
  const resolvedAuthApi = useMemo(() => authApi ?? createDefaultAuthApi(), [authApi])
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [adminPasswordSetupRequired, setAdminPasswordSetupRequired] = useState(false)
  const [adminUsername, setAdminUsername] = useState(INITIAL_ADMIN_USERNAME)
  const userRef = useRef<User | null>(null)

  useEffect(() => {
    userRef.current = user
  }, [user])

  const clearAdminPasswordSetupState = useCallback(() => {
    setAdminPasswordSetupRequired(false)
    setAdminUsername(INITIAL_ADMIN_USERNAME)
  }, [])

  const applyAdminPasswordSetupError = useCallback((error: ApiError) => {
    setUser(null)
    setAdminPasswordSetupRequired(true)
    setAdminUsername(getAdminUsernameFromSetupError(error))
    if (!isAuthRoute(window.location.pathname)) {
      redirectToLogin()
    }
  }, [])

  const fetchAnonymousLoginHandshake = useCallback(async () => {
    clearAdminPasswordSetupState()
    try {
      const currentUser = await resolvedAuthApi.getCurrentUserWithoutAuthRedirect()
      setUser(currentUser)
    } catch (error) {
      if (isAdminPasswordSetupRequiredError(error)) {
        applyAdminPasswordSetupError(error)
        return
      }
      if (error instanceof ApiError && error.status === 401) {
        return
      }
      console.error('Failed to check admin password setup state:', error)
    }
  }, [applyAdminPasswordSetupError, clearAdminPasswordSetupState, resolvedAuthApi])

  const refresh = useCallback(async () => {
    setIsLoading(true)

    try {
      if (isLocalFirstRuntime()) {
        setUser(getLocalUser())
        clearAdminPasswordSetupState()
        return
      }

      if (!isAuthenticated()) {
        setUser(null)
        if (isAuthRoute(window.location.pathname)) {
          await fetchAnonymousLoginHandshake()
        } else {
          clearAdminPasswordSetupState()
          redirectToLogin()
        }
        return
      }

      const currentUser = await resolvedAuthApi.getCurrentUser()
      setUser(currentUser)
      clearAdminPasswordSetupState()
    } catch (error) {
      if (isAdminPasswordSetupRequiredError(error)) {
        applyAdminPasswordSetupError(error)
        return
      }
      removeToken()
      setUser(null)
      clearAdminPasswordSetupState()
      if (!isAuthRoute(window.location.pathname)) {
        redirectToLogin()
      }
    } finally {
      setIsLoading(false)
    }
  }, [
    applyAdminPasswordSetupError,
    clearAdminPasswordSetupState,
    fetchAnonymousLoginHandshake,
    resolvedAuthApi,
  ])

  useEffect(() => {
    void Promise.resolve().then(() => refresh())

    const interval = window.setInterval(() => {
      if (isLocalFirstRuntime()) {
        return
      }
      if (!isAuthenticated() && userRef.current) {
        setUser(null)
        clearAdminPasswordSetupState()
        redirectToLogin()
      }
    }, 10000)

    return () => window.clearInterval(interval)
  }, [clearAdminPasswordSetupState, refresh])

  const login = useCallback(
    async (data: LoginRequest) => {
      setIsLoading(true)
      try {
        const loggedInUser = await resolvedAuthApi.login(data)
        setUser(loggedInUser)
        clearAdminPasswordSetupState()
        return loggedInUser
      } catch (error) {
        if (isAdminPasswordSetupRequiredError(error)) {
          applyAdminPasswordSetupError(error)
        }
        throw error
      } finally {
        setIsLoading(false)
      }
    },
    [applyAdminPasswordSetupError, clearAdminPasswordSetupState, resolvedAuthApi]
  )

  const logout = useCallback(() => {
    if (isLocalFirstRuntime()) {
      removeToken()
      setUser(getLocalUser())
      clearAdminPasswordSetupState()
      return
    }

    resolvedAuthApi.logout()
    setUser(null)
    clearAdminPasswordSetupState()
    redirectToLogin()
  }, [clearAdminPasswordSetupState, resolvedAuthApi])

  const loginWithOidcToken = useCallback(
    async (accessToken: string) => {
      await resolvedAuthApi.loginWithOidcToken(accessToken)
      clearAdminPasswordSetupState()
    },
    [clearAdminPasswordSetupState, resolvedAuthApi]
  )

  const setupAdminPassword = useCallback(
    async (password: string) => {
      setIsLoading(true)
      try {
        const adminUser = await resolvedAuthApi.setupAdminPassword(password)
        setUser(adminUser)
        clearAdminPasswordSetupState()
        return adminUser
      } finally {
        setIsLoading(false)
      }
    },
    [clearAdminPasswordSetupState, resolvedAuthApi]
  )

  const value: AuthContextValue = {
    user,
    isLoading,
    adminPasswordSetupRequired,
    adminUsername,
    login,
    logout,
    refresh,
    loginWithOidcToken,
    setupAdminPassword,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
