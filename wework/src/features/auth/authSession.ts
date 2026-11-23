import {
  createAuthApi,
  getToken,
  isAuthenticated,
  removeToken,
  type LoginRequest,
} from '@/api/auth'
import { ApiError } from '@/api/http'
import { getLocalUser } from '@/api/local/localSession'
import { stripAppBasePath } from '@/config/runtime'
import { isLocalFirstAppRuntime } from '@/lib/runtime-mode'
import { clearPluginMarketplaceCache } from '@/features/plugins/pluginMarketplaceCache'
import { track } from '@/telemetry/client'
import type { User } from '@/types/api'
import {
  getAdminUsernameFromSetupError,
  INITIAL_ADMIN_USERNAME,
  isAdminPasswordSetupRequiredError,
} from './adminPasswordSetup'
import { LOGIN_PATH, OIDC_CALLBACK_PATH, redirectToLogin } from './redirect'

export type AuthApi = ReturnType<typeof createAuthApi>

interface AuthSnapshot {
  user: User | null
  isLoading: boolean
  adminPasswordSetupRequired: boolean
  adminUsername: string
  error: unknown
}

function isAuthRoute() {
  const path = stripAppBasePath(window.location.pathname)
  return path === LOGIN_PATH || path === OIDC_CALLBACK_PATH
}

/** An API owner has one authentication snapshot; credentials remain owned by the existing API. */
export function createAuthSession(
  apiOrCreate: AuthApi | ((captureOwnership: () => () => boolean) => AuthApi),
  ownsUnauthorizedRedirect: boolean
) {
  let snapshot: AuthSnapshot = {
    user: null,
    isLoading: true,
    adminPasswordSetupRequired: false,
    adminUsername: INITIAL_ADMIN_USERNAME,
    error: null,
  }
  const listeners = new Set<() => void>()
  let generation = 0
  let revision = 0
  let disposed = false
  const captureOwnership = () => {
    const owner = generation
    const request = revision
    return () => !disposed && owner === generation && request === revision
  }
  const api = typeof apiOrCreate === 'function' ? apiOrCreate(captureOwnership) : apiOrCreate
  let interval: ReturnType<typeof setInterval> | undefined
  let mutation: number | null = null
  let expirationDeferred = false
  let bootstrapWanted = false
  const patch = (value: Partial<AuthSnapshot>) => {
    snapshot = { ...snapshot, ...value }
    listeners.forEach(listener => listener())
  }
  const clearSetup = () => ({
    adminPasswordSetupRequired: false,
    adminUsername: INITIAL_ADMIN_USERNAME,
  })
  const begin = () => {
    const request = ++revision
    const owner = generation
    return { request, current: () => !disposed && request === revision && owner === generation }
  }
  const applySetupError = (error: ApiError) => {
    patch({
      user: null,
      adminPasswordSetupRequired: true,
      adminUsername: getAdminUsernameFromSetupError(error),
      error,
    })
    if (!isAuthRoute()) redirectToLogin()
  }
  const rejectUnauthorized = (error: unknown) => {
    if (!ownsUnauthorizedRedirect || !(error instanceof ApiError) || error.status !== 401) return
    removeToken()
    patch({ user: null })
    redirectToLogin()
  }
  const refresh = async () => {
    if (disposed) return
    bootstrapWanted = false
    const operation = begin()
    const local = isLocalFirstAppRuntime()
    let credential: string | null = null
    const current = () => operation.current() && (local || credential === getToken())
    patch({ isLoading: true, error: null })
    try {
      if (local) {
        patch({ user: getLocalUser(), ...clearSetup() })
        return
      }
      credential = getToken()
      if (!isAuthenticated()) {
        patch({ user: null, ...clearSetup() })
        if (!isAuthRoute()) {
          redirectToLogin()
          return
        }
        try {
          const user = await api.getCurrentUserWithoutAuthRedirect()
          if (current()) patch({ user })
        } catch (error) {
          if (!current()) return
          if (isAdminPasswordSetupRequiredError(error)) {
            applySetupError(error)
            return
          }
          if (error instanceof ApiError && error.status === 401) return
          patch({ error })
          console.error('Failed to check admin password setup state:', error)
        }
        return
      }
      const user = await api.getCurrentUser()
      if (current()) patch({ user, ...clearSetup() })
    } catch (error) {
      if (!current()) return
      if (isAdminPasswordSetupRequiredError(error)) {
        applySetupError(error)
        return
      }
      removeToken()
      patch({ user: null, error, ...clearSetup() })
      if (!isAuthRoute()) redirectToLogin()
    } finally {
      if (operation.current()) patch({ isLoading: false })
    }
  }
  const checkExpiration = () => {
    if (disposed || isLocalFirstAppRuntime() || isAuthenticated() || !snapshot.user) return
    if (mutation !== null) {
      expirationDeferred = true
      return
    }
    expirationDeferred = false
    revision += 1
    patch({ user: null, isLoading: false, ...clearSetup() })
    redirectToLogin()
  }
  const finishMutation = (request: number, oidc = false) => {
    if (mutation !== request) return
    mutation = null
    if (expirationDeferred) {
      expirationDeferred = false
      checkExpiration()
    }
    if (!bootstrapWanted) return
    bootstrapWanted = false
    if (oidc && listeners.size) void refresh()
  }
  const login = async (data: LoginRequest) => {
    const operation = begin()
    if (!operation.current())
      throw new DOMException('Authentication operation was cancelled', 'AbortError')
    mutation = operation.request
    patch({ isLoading: true, error: null })
    try {
      const user = await api.login(data)
      if (operation.current()) patch({ user, ...clearSetup() })
      track('authentication_completed', { method: 'password', result: 'success' })
      return user
    } catch (error) {
      track('authentication_completed', { method: 'password', result: 'failure' })
      if (operation.current()) {
        patch({ error })
        if (isAdminPasswordSetupRequiredError(error)) applySetupError(error)
        else rejectUnauthorized(error)
      }
      throw error
    } finally {
      if (operation.current()) patch({ isLoading: false })
      finishMutation(operation.request)
    }
  }
  const logout = () => {
    if (disposed) return
    revision += 1
    mutation = null
    expirationDeferred = false
    bootstrapWanted = false
    clearPluginMarketplaceCache()
    if (isLocalFirstAppRuntime()) {
      removeToken()
      patch({ user: getLocalUser(), isLoading: false, error: null, ...clearSetup() })
      return
    }
    api.logout()
    patch({ user: null, isLoading: false, error: null, ...clearSetup() })
    redirectToLogin()
  }
  const loginWithOidcToken = async (accessToken: string) => {
    const operation = begin()
    mutation = operation.request
    try {
      await api.loginWithOidcToken(accessToken)
      if (operation.current()) patch({ error: null, ...clearSetup() })
      track('authentication_completed', { method: 'oidc', result: 'success' })
    } catch (error) {
      track('authentication_completed', { method: 'oidc', result: 'failure' })
      if (operation.current()) patch({ error })
      throw error
    } finally {
      finishMutation(operation.request, true)
    }
  }
  const setupAdminPassword = async (password: string) => {
    const operation = begin()
    mutation = operation.request
    patch({ isLoading: true, error: null })
    try {
      const user = await api.setupAdminPassword(password)
      if (operation.current()) patch({ user, ...clearSetup() })
      track('authentication_completed', { method: 'admin_setup', result: 'success' })
      return user
    } catch (error) {
      track('authentication_completed', { method: 'admin_setup', result: 'failure' })
      if (operation.current()) {
        patch({ error })
        rejectUnauthorized(error)
      }
      throw error
    } finally {
      if (operation.current()) patch({ isLoading: false })
      finishMutation(operation.request)
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      disposed = false
      listeners.add(listener)
      if (listeners.size === 1) {
        const owner = generation
        bootstrapWanted = true
        queueMicrotask(() => {
          if (!listeners.size || owner !== generation || !bootstrapWanted || mutation !== null)
            return
          void refresh()
        })
        interval = setInterval(checkExpiration, 10000)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        generation += 1
        queueMicrotask(() => {
          if (!listeners.size) disposed = true
        })
        mutation = null
        expirationDeferred = false
        bootstrapWanted = false
        clearInterval(interval)
        interval = undefined
      }
    },
    login,
    logout,
    refresh,
    loginWithOidcToken,
    setupAdminPassword,
  }
}
