import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { ApiError } from '@/api/http'
import { getConfiguredSocketBaseUrl, getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import {
  commitDesktopCloudAuthorization,
  clearDesktopCloudCredentials,
  discardDesktopCloudAuthorization,
  DesktopCloudCredentialError,
  prepareDesktopCloudAuthorization,
  refreshDesktopCloudAccessToken,
} from '@/desktop/cloudCredentials'
import { raceWithTimeout } from '@/lib/promise-timeout'
import { getAppPreferences, updateAppPreferences } from '@/desktop/appPreferences'
import { subscribeSystemResume } from '@/desktop/systemResume'
import {
  DESKTOP_E2E_CLOUD_SESSION_CHANGED_EVENT,
  getDesktopE2ERuntimeConfig,
} from '@/e2e/runtime-config'
import type { User } from '@/types/api'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
  type CloudAuthorizationHandle,
  type CloudConnectionContextValue,
  type OpenCloudAuthorizationUrl,
} from './CloudConnectionContext'
import { track } from '@/telemetry/client'
import {
  checkCloudHealth,
  createWeworkAuthSession,
  fetchCloudConfig,
  fetchCloudUser,
  pollWeworkAuthSession,
  rawErrorMessage,
} from './cloudConnectionRequests'
import {
  clearStoredCloudConnection,
  getJwtExpiry,
  normalizeCloudBackendUrl,
  normalizeStoredCloudConnection,
  readStoredCloudConnection,
  saveStoredCloudConnection,
  type CloudCredentialMode,
  type CloudConnectionRuntimeConfig,
  type CloudConnectionSnapshot,
} from './cloudConnectionStorage'

const DEFAULT_AUTH_POLL_INTERVAL_MS = 2000
const CLOUD_AUTHORIZATION_CLOSED_MESSAGE = '云端授权窗口已关闭，请重新连接'
const CLOUD_STARTUP_REQUEST_TIMEOUT_MS = 8000
const ACCESS_TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000
const ACCESS_TOKEN_REFRESH_RETRY_MS = 60 * 1000
const ACCESS_TOKEN_REFRESH_TIMEOUT_MS = 45 * 1000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
/** Stable code the main process reports when a cloud credential call times out. */
const CLOUD_CREDENTIAL_REQUEST_TIMEOUT_CODE = 'request_timeout'

function isLocalBackendSocketMirror(backendUrl: string, socketUrl: string): boolean {
  try {
    const backend = new URL(backendUrl)
    const socket = new URL(socketUrl)
    const sameTransportSecurity =
      backend.protocol === 'http:'
        ? socket.protocol === 'http:' || socket.protocol === 'ws:'
        : socket.protocol === 'https:' || socket.protocol === 'wss:'
    return (
      LOOPBACK_HOSTS.has(backend.hostname) &&
      backend.hostname !== socket.hostname &&
      backend.port === socket.port &&
      backend.pathname.replace(/\/+$/, '') === socket.pathname.replace(/\/+$/, '') &&
      sameTransportSecurity
    )
  } catch {
    return false
  }
}
/**
 * Refresh the desktop access token with a bound.
 *
 * A request that never settles must not keep the provider waiting forever:
 * the renderer owns the "one refresh in flight" state, and a hang there blocks
 * every later trigger (expiry timer, system resume, `online`, retry interval).
 */
async function requestDesktopCloudAccessToken(apiBaseUrl: string, userId: number): Promise<string> {
  const startedAt = Date.now()
  console.info('[CloudConnection] access token refresh started', { apiBaseUrl })
  try {
    const refreshed = await raceWithTimeout(
      refreshDesktopCloudAccessToken(apiBaseUrl, userId),
      ACCESS_TOKEN_REFRESH_TIMEOUT_MS,
      timeoutMs =>
        new DesktopCloudCredentialError(
          'request_timeout',
          `Cloud credential refresh timed out after ${Math.round(timeoutMs / 1000)}s`,
          null
        )
    )
    console.info('[CloudConnection] access token refresh finished', {
      apiBaseUrl,
      elapsedMs: Date.now() - startedAt,
    })
    return refreshed.accessToken
  } catch (error) {
    console.warn('[CloudConnection] access token refresh failed', {
      apiBaseUrl,
      elapsedMs: Date.now() - startedAt,
      error: rawErrorMessage(error),
    })
    throw error
  }
}

async function resolveAccessToken(
  apiBaseUrl: string,
  credentialMode: CloudCredentialMode,
  existingToken: string | null,
  userId: number
): Promise<string | null> {
  if (credentialMode === 'legacy_access_token') return existingToken
  return requestDesktopCloudAccessToken(apiBaseUrl, userId)
}

function resolveCloudRuntimeConfig(
  backendUrl: string,
  socketBaseUrlOverride?: string,
  backendSocketUrl?: string
): CloudConnectionRuntimeConfig {
  const normalized = normalizeCloudBackendUrl(backendUrl)
  if (socketBaseUrlOverride?.trim()) {
    return normalizeCloudBackendUrl(backendUrl, socketBaseUrlOverride)
  }
  const runtimeConfig = getRuntimeConfig()
  if (runtimeConfig.wegentBackendUrl) {
    const configuredBackend = normalizeCloudBackendUrl(runtimeConfig.wegentBackendUrl)
    const configuredSocketBaseUrl = getConfiguredSocketBaseUrl()
    if (normalized.backendUrl === configuredBackend.backendUrl && configuredSocketBaseUrl) {
      return normalizeCloudBackendUrl(backendUrl, configuredSocketBaseUrl)
    }
  }
  if (
    !backendSocketUrl?.trim() ||
    isLocalBackendSocketMirror(normalized.backendUrl, backendSocketUrl)
  ) {
    return normalized
  }
  return normalizeCloudBackendUrl(backendUrl, backendSocketUrl)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms)
  })
}

function authWindowClosedPromise(handle: CloudAuthorizationHandle | void): Promise<never> | null {
  if (!handle?.closed) return null
  return handle.closed.then(() => {
    throw new Error(CLOUD_AUTHORIZATION_CLOSED_MESSAGE)
  })
}

function snapshotFromConnection(
  stored: ReturnType<typeof readStoredCloudConnection>
): CloudConnectionSnapshot {
  if (!stored) return DISCONNECTED_STATE
  let normalizedConfig: CloudConnectionRuntimeConfig
  try {
    normalizedConfig = resolveCloudRuntimeConfig(
      stored.backendUrl,
      stored.socketBaseUrlOverride,
      stored.socketBaseUrl
    )
  } catch {
    clearStoredCloudConnection()
    return DISCONNECTED_STATE
  }
  const migrated = {
    ...stored,
    ...normalizedConfig,
  }
  if (
    migrated.apiBaseUrl !== stored.apiBaseUrl ||
    migrated.socketBaseUrl !== stored.socketBaseUrl ||
    migrated.socketPath !== stored.socketPath
  ) {
    saveStoredCloudConnection(migrated)
  }

  const e2eAccessToken =
    import.meta.env.VITE_WEWORK_E2E === 'true'
      ? (getDesktopE2ERuntimeConfig().cloudToken ??
        import.meta.env.VITE_WEWORK_E2E_CLOUD_TOKEN?.trim() ??
        null)
      : null
  const credentialMode =
    migrated.credentialMode ?? (migrated.token ? 'legacy_access_token' : 'desktop_refresh')
  const legacyToken = credentialMode === 'legacy_access_token' ? (migrated.token ?? null) : null
  const legacyTokenExpiresAt =
    credentialMode === 'legacy_access_token'
      ? (migrated.tokenExpiresAt ?? (legacyToken ? getJwtExpiry(legacyToken) : null))
      : null
  const legacyTokenExpired = legacyTokenExpiresAt !== null && legacyTokenExpiresAt <= Date.now()
  return {
    status: e2eAccessToken
      ? 'connected'
      : credentialMode === 'desktop_refresh'
        ? 'restoring'
        : legacyToken && !legacyTokenExpired
          ? 'connected'
          : 'expired',
    webUrl: migrated.webUrl,
    backendUrl: migrated.backendUrl,
    apiBaseUrl: migrated.apiBaseUrl,
    socketBaseUrl: migrated.socketBaseUrl,
    socketPath: migrated.socketPath,
    socketBaseUrlOverride: migrated.socketBaseUrlOverride,
    credentialMode,
    token: e2eAccessToken ?? (legacyTokenExpired ? null : legacyToken),
    tokenExpiresAt: e2eAccessToken ? getJwtExpiry(e2eAccessToken) : legacyTokenExpiresAt,
    user: migrated.user,
    connectedAt: migrated.connectedAt,
    error: null,
  }
}

function snapshotFromStored(): CloudConnectionSnapshot {
  return snapshotFromConnection(readStoredCloudConnection())
}

function connectionSnapshot(
  config: CloudConnectionRuntimeConfig,
  webUrl: string,
  token: string,
  user: User,
  credentialMode: CloudCredentialMode,
  socketBaseUrlOverride?: string
): CloudConnectionSnapshot {
  return {
    ...config,
    socketBaseUrlOverride: socketBaseUrlOverride?.trim() || undefined,
    webUrl: webUrl.replace(/\/+$/, ''),
    status: 'connected',
    credentialMode,
    token,
    tokenExpiresAt: getJwtExpiry(token),
    user,
    connectedAt: new Date().toISOString(),
    error: null,
  }
}

function persistSnapshot(snapshot: CloudConnectionSnapshot): void {
  if (
    snapshot.status !== 'connected' ||
    !snapshot.backendUrl ||
    !snapshot.apiBaseUrl ||
    !snapshot.socketBaseUrl ||
    !snapshot.socketPath ||
    !snapshot.token ||
    !snapshot.user ||
    !snapshot.connectedAt
  ) {
    return
  }

  const stored = {
    backendUrl: snapshot.backendUrl,
    apiBaseUrl: snapshot.apiBaseUrl,
    socketBaseUrl: snapshot.socketBaseUrl,
    socketPath: snapshot.socketPath,
    socketBaseUrlOverride: snapshot.socketBaseUrlOverride,
    webUrl: snapshot.webUrl,
    credentialMode: snapshot.credentialMode ?? 'desktop_refresh',
    token: snapshot.credentialMode === 'legacy_access_token' ? snapshot.token : undefined,
    tokenExpiresAt:
      snapshot.credentialMode === 'legacy_access_token' ? snapshot.tokenExpiresAt : undefined,
    user: snapshot.user,
    connectedAt: snapshot.connectedAt,
  }
  saveStoredCloudConnection(stored)
  void updateAppPreferences({ cloudConnection: stored }).catch(error => {
    console.error('[CloudConnection] Failed to persist desktop cloud connection', error)
  })
}

function getCloudErrorMessage(error: unknown, t: TFunction): string {
  // The re-login banner keys off this exact sentinel.
  if (error instanceof ApiError && error.status === 401) return 'Cloud login has expired'
  if (
    error instanceof DesktopCloudCredentialError &&
    error.code === CLOUD_CREDENTIAL_REQUEST_TIMEOUT_CODE
  ) {
    return t('workbench.cloud_connection_request_timeout', '云端请求超时，请稍后重试。')
  }
  return rawErrorMessage(error)
}

interface CloudConnectionProviderProps {
  children: ReactNode
}

interface CloudAuthorizationState {
  generation: number
}

export function CloudConnectionProvider({ children }: CloudConnectionProviderProps) {
  const { t } = useTranslation('common')
  const [snapshot, setSnapshot] = useState<CloudConnectionSnapshot>(() => snapshotFromStored())
  const [authorization, setAuthorization] = useState<CloudAuthorizationState | null>(null)
  const [desktopRestoreSettled, setDesktopRestoreSettled] = useState(false)
  const [e2eSessionRevision, setE2ESessionRevision] = useState(0)
  const initialRefreshStartedRef = useRef(false)
  const desktopRestoreStartedRef = useRef(false)
  const refreshPromiseRef = useRef<Promise<User | null> | null>(null)
  const refreshAttemptIdRef = useRef(0)
  const refreshGenerationRef = useRef(0)
  const authorizationGenerationRef = useRef(0)
  const disconnectRevisionRef = useRef(0)
  const credentialCommitsRef = useRef(new Set<symbol>())
  const nextCommitRevisionRef = useRef(0)
  const publishedCommitRevisionRef = useRef(0)
  const disconnectRequestedRef = useRef(false)
  const terminalDesktopCredentialExpiryRef = useRef(false)

  useEffect(() => {
    if (import.meta.env.VITE_WEWORK_E2E !== 'true') return
    const restoreSelectedSession = () => {
      const config = getDesktopE2ERuntimeConfig()
      if (!config.controlUrl || config.disabled || !config.cloudToken) return
      // The controller has already verified /users/me and persisted the native
      // profile. Reuse normal connection consumers without remounting the app.
      refreshGenerationRef.current += 1
      authorizationGenerationRef.current += 1
      disconnectRevisionRef.current += 1
      refreshAttemptIdRef.current += 1
      refreshPromiseRef.current = null
      disconnectRequestedRef.current = false
      terminalDesktopCredentialExpiryRef.current = false
      initialRefreshStartedRef.current = true
      setAuthorization(null)
      setSnapshot(snapshotFromStored())
      setE2ESessionRevision(revision => revision + 1)
    }
    window.addEventListener(DESKTOP_E2E_CLOUD_SESSION_CHANGED_EVENT, restoreSelectedSession)
    return () =>
      window.removeEventListener(DESKTOP_E2E_CLOUD_SESSION_CHANGED_EVENT, restoreSelectedSession)
  }, [])

  useEffect(() => {
    if (desktopRestoreStartedRef.current) return
    desktopRestoreStartedRef.current = true
    const restoreGeneration = refreshGenerationRef.current
    const restoreAuthorizationGeneration = authorizationGenerationRef.current
    void getAppPreferences()
      .then(preferences => {
        if (
          disconnectRequestedRef.current ||
          refreshGenerationRef.current !== restoreGeneration ||
          authorizationGenerationRef.current !== restoreAuthorizationGeneration
        ) {
          return
        }
        const stored = normalizeStoredCloudConnection(preferences.cloudConnection)
        if (!stored) return
        setSnapshot(current => {
          if (
            disconnectRequestedRef.current ||
            refreshGenerationRef.current !== restoreGeneration ||
            authorizationGenerationRef.current !== restoreAuthorizationGeneration
          ) {
            return current
          }
          saveStoredCloudConnection(stored)
          return snapshotFromConnection(stored)
        })
      })
      .catch(error => {
        console.error('[CloudConnection] Failed to restore desktop cloud connection', error)
      })
      .finally(() => {
        setDesktopRestoreSettled(true)
      })
  }, [])

  const applyConnectedSnapshot = useCallback(
    (nextSnapshot: CloudConnectionSnapshot, commitRevision: number, disconnectRevision: number) => {
      setSnapshot(current => {
        if (
          disconnectRevisionRef.current !== disconnectRevision ||
          publishedCommitRevisionRef.current !== commitRevision
        ) {
          return current
        }
        persistSnapshot(nextSnapshot)
        return nextSnapshot
      })
    },
    []
  )

  useEffect(() => {
    if (!desktopRestoreSettled || snapshot.status !== 'connected' || !snapshot.backendUrl) return
    const configGeneration = refreshGenerationRef.current
    const backendUrl = snapshot.backendUrl
    const config = resolveCloudRuntimeConfig(backendUrl, snapshot.socketBaseUrlOverride)
    void fetchCloudConfig(config, CLOUD_STARTUP_REQUEST_TIMEOUT_MS)
      .then(metadata => {
        const resolvedConfig = resolveCloudRuntimeConfig(
          backendUrl,
          snapshot.socketBaseUrlOverride,
          metadata.socketUrl
        )
        setSnapshot(current => {
          if (disconnectRequestedRef.current || refreshGenerationRef.current !== configGeneration) {
            return current
          }
          const nextSnapshot = {
            ...current,
            ...resolvedConfig,
            webUrl: metadata.webUrl,
          }
          persistSnapshot(nextSnapshot)
          return nextSnapshot
        })
      })
      .catch(error => {
        console.error('[CloudConnection] Failed to resolve cloud configuration', error)
      })
  }, [
    desktopRestoreSettled,
    e2eSessionRevision,
    snapshot.backendUrl,
    snapshot.socketBaseUrlOverride,
    snapshot.status,
  ])

  const connectWithAuthorization = useCallback(
    async (
      backendUrl: string,
      openAuthorizationUrl?: OpenCloudAuthorizationUrl,
      socketBaseUrlOverride?: string
    ): Promise<User> => {
      disconnectRequestedRef.current = false
      terminalDesktopCredentialExpiryRef.current = false
      const authorizationGeneration = authorizationGenerationRef.current + 1
      authorizationGenerationRef.current = authorizationGeneration
      const disconnectRevision = disconnectRevisionRef.current
      let authorizationId: string | null = null
      let config = resolveCloudRuntimeConfig(backendUrl, socketBaseUrlOverride)
      // Keep candidate endpoints request-local until their authenticated user is
      // ready, so consumers never observe a new backend with the previous owner.
      setAuthorization({
        generation: authorizationGeneration,
      })

      try {
        const prepared = await prepareDesktopCloudAuthorization(config.apiBaseUrl)
        authorizationId = prepared.authorizationId
        if (authorizationGenerationRef.current !== authorizationGeneration) {
          throw new Error('Cloud connection was cancelled')
        }
        await checkCloudHealth(config)
        const metadata = await fetchCloudConfig(config)
        if (authorizationGenerationRef.current !== authorizationGeneration) {
          throw new Error('Cloud connection was cancelled')
        }
        config = resolveCloudRuntimeConfig(backendUrl, socketBaseUrlOverride, metadata.socketUrl)
        const session = await createWeworkAuthSession(config, prepared.publicKey)
        if (authorizationGenerationRef.current !== authorizationGeneration) {
          throw new Error('Cloud connection was cancelled')
        }
        const authorizationHandle = await openAuthorizationUrl?.(session.authorize_url)
        const windowClosed = authWindowClosedPromise(authorizationHandle)

        const pollIntervalMs =
          Number.isFinite(session.poll_interval_seconds) && session.poll_interval_seconds > 0
            ? session.poll_interval_seconds * 1000
            : DEFAULT_AUTH_POLL_INTERVAL_MS
        const expiresAtMs = session.expires_at * 1000

        while (Date.now() < expiresAtMs) {
          if (authorizationGenerationRef.current !== authorizationGeneration) {
            throw new Error('Cloud connection was cancelled')
          }
          if (windowClosed) {
            await Promise.race([delay(pollIntervalMs), windowClosed])
          } else {
            await delay(pollIntervalMs)
          }
          const pollResult = windowClosed
            ? await Promise.race([
                pollWeworkAuthSession(config, session, authorizationId),
                windowClosed,
              ])
            : await pollWeworkAuthSession(config, session, authorizationId)
          if (authorizationGenerationRef.current !== authorizationGeneration) {
            throw new Error('Cloud connection was cancelled')
          }
          if (pollResult.status === 'pending') continue
          if (pollResult.status === 'declined') {
            throw new Error('云端授权已取消')
          }
          if (pollResult.status === 'failed') {
            throw new Error(pollResult.error || '云端授权失败')
          }
          if (!pollResult.accessToken) {
            throw new Error('云端授权未返回登录凭证')
          }
          await Promise.resolve(authorizationHandle?.close?.()).catch(error => {
            console.warn('[CloudConnection] Failed to close authorization window', error)
          })
          const user = await fetchCloudUser(config, pollResult.accessToken)
          if (authorizationGenerationRef.current !== authorizationGeneration) {
            throw new Error('Cloud connection was cancelled')
          }
          const commit = Symbol('cloud-credential-commit')
          const commitRevision = ++nextCommitRevisionRef.current
          credentialCommitsRef.current.add(commit)
          refreshGenerationRef.current += 1
          refreshAttemptIdRef.current += 1
          refreshPromiseRef.current = null
          try {
            await commitDesktopCloudAuthorization(authorizationId, user.id)
            if (disconnectRevisionRef.current !== disconnectRevision) {
              throw new Error('Cloud connection was cancelled')
            }
            // Native commit has linearized. A newer pending candidate cannot
            // revoke this active owner; a later successful commit replaces it.
            if (commitRevision > publishedCommitRevisionRef.current) {
              publishedCommitRevisionRef.current = commitRevision
              refreshGenerationRef.current += 1
              initialRefreshStartedRef.current = true
              applyConnectedSnapshot(
                connectionSnapshot(
                  config,
                  session.web_url,
                  pollResult.accessToken,
                  user,
                  pollResult.credentialMode ?? 'desktop_refresh',
                  socketBaseUrlOverride
                ),
                commitRevision,
                disconnectRevision
              )
            }
          } finally {
            credentialCommitsRef.current.delete(commit)
          }
          setAuthorization(current =>
            current?.generation === authorizationGeneration ? null : current
          )
          track('cloud_connection_changed', { connected: true })
          return user
        }

        throw new Error('云端授权已超时，请重新连接')
      } catch (error) {
        track('operation_failed', { operation: 'cloud_connect' })
        setAuthorization(current =>
          current?.generation === authorizationGeneration ? null : current
        )
        setSnapshot(current =>
          disconnectRequestedRef.current ||
          authorizationGenerationRef.current !== authorizationGeneration ||
          (current.status === 'connected' && current.token)
            ? current
            : { ...current, status: 'error', token: null, error: getCloudErrorMessage(error, t) }
        )
        throw error
      } finally {
        if (authorizationId) {
          await discardDesktopCloudAuthorization(authorizationId).catch(error => {
            console.warn('[CloudConnection] Failed to discard cloud authorization', error)
          })
        }
      }
    },
    [applyConnectedSnapshot, t]
  )
  const refreshUser = useCallback((): Promise<User | null> => {
    if (disconnectRequestedRef.current) return Promise.resolve(null)
    if (credentialCommitsRef.current.size > 0) return Promise.resolve(null)
    if (refreshPromiseRef.current) return refreshPromiseRef.current
    if (!snapshot.apiBaseUrl || !snapshot.user) return Promise.resolve(null)
    const refreshGeneration = refreshGenerationRef.current
    const refreshAttemptId = refreshAttemptIdRef.current + 1
    refreshAttemptIdRef.current = refreshAttemptId
    const credentialMode = snapshot.credentialMode ?? 'desktop_refresh'
    const config = {
      backendUrl: snapshot.backendUrl ?? '',
      apiBaseUrl: snapshot.apiBaseUrl,
      socketBaseUrl: snapshot.socketBaseUrl ?? snapshot.backendUrl ?? '',
      socketPath: snapshot.socketPath ?? '/socket.io',
    }
    const refresh = (async () => {
      try {
        // Awaiting a resolved-token helper keeps the first suspension inside the
        // try block, so the guard below is always assigned before it is cleared.
        const accessToken = await resolveAccessToken(
          config.apiBaseUrl,
          credentialMode,
          snapshot.token,
          snapshot.user!.id
        )
        if (!accessToken) {
          throw new DesktopCloudCredentialError(
            'credentials_unavailable',
            'Cloud access token is unavailable',
            null
          )
        }
        if (refreshGenerationRef.current !== refreshGeneration) return null
        const user = await fetchCloudUser(config, accessToken, CLOUD_STARTUP_REQUEST_TIMEOUT_MS)
        if (refreshGenerationRef.current !== refreshGeneration) return null
        terminalDesktopCredentialExpiryRef.current = false
        setSnapshot(current => {
          if (
            disconnectRequestedRef.current ||
            refreshGenerationRef.current !== refreshGeneration
          ) {
            return current
          }
          const nextSnapshot = {
            ...current,
            status: 'connected' as const,
            credentialMode,
            token: accessToken,
            tokenExpiresAt: getJwtExpiry(accessToken),
            user,
            error: null,
          }
          persistSnapshot(nextSnapshot)
          return nextSnapshot
        })
        return user
      } catch (error) {
        if (refreshGenerationRef.current !== refreshGeneration) return null
        const authExpired =
          (error instanceof ApiError && error.status === 401) ||
          (error instanceof DesktopCloudCredentialError && error.code === 'cloud_auth_expired')
        if (authExpired && credentialMode === 'desktop_refresh') {
          terminalDesktopCredentialExpiryRef.current = true
        }
        setSnapshot(current =>
          authExpired
            ? {
                ...current,
                status: 'expired',
                token: null,
                tokenExpiresAt:
                  credentialMode === 'legacy_access_token' ? current.tokenExpiresAt : null,
                error: 'Cloud login has expired',
              }
            : {
                ...current,
                status: current.status === 'connected' && current.token ? 'connected' : 'error',
                error: getCloudErrorMessage(error, t),
              }
        )
        return null
      } finally {
        // Release the in-flight guard whenever this attempt settles, whatever
        // happened to it (timeout, failure, superseded generation). Keeping the
        // guard would silently disable every later automatic refresh, and a
        // newer attempt already owns it when it exists.
        if (refreshAttemptIdRef.current === refreshAttemptId) {
          refreshPromiseRef.current = null
        }
      }
    })()
    refreshPromiseRef.current = refresh
    return refresh
  }, [
    snapshot.apiBaseUrl,
    snapshot.backendUrl,
    snapshot.credentialMode,
    snapshot.socketBaseUrl,
    snapshot.socketPath,
    snapshot.token,
    snapshot.user,
    t,
  ])

  const refreshAutomatically = useCallback(() => {
    if (terminalDesktopCredentialExpiryRef.current) return
    void refreshUser()
  }, [refreshUser])

  const disconnect = useCallback(() => {
    disconnectRequestedRef.current = true
    terminalDesktopCredentialExpiryRef.current = false
    refreshGenerationRef.current += 1
    authorizationGenerationRef.current += 1
    disconnectRevisionRef.current += 1
    refreshPromiseRef.current = null
    clearStoredCloudConnection()
    setAuthorization(null)
    setSnapshot(DISCONNECTED_STATE)
    void updateAppPreferences({ cloudConnection: null }).catch(error => {
      console.error('[CloudConnection] Failed to clear desktop cloud connection', error)
    })
    void (async () => clearDesktopCloudCredentials())().catch(error => {
      console.error('[CloudConnection] Failed to clear desktop cloud credentials', error)
    })
    track('cloud_connection_changed', { connected: false })
  }, [])

  useEffect(() => {
    if (
      !desktopRestoreSettled ||
      initialRefreshStartedRef.current ||
      !snapshot.apiBaseUrl ||
      (snapshot.status !== 'restoring' &&
        !(snapshot.status === 'connected' && snapshot.credentialMode === 'legacy_access_token'))
    ) {
      return
    }
    initialRefreshStartedRef.current = true
    void refreshUser()
  }, [
    desktopRestoreSettled,
    refreshUser,
    snapshot.apiBaseUrl,
    snapshot.credentialMode,
    snapshot.status,
  ])

  useEffect(() => {
    if (snapshot.status !== 'connected' || !snapshot.tokenExpiresAt) return
    if (snapshot.credentialMode === 'legacy_access_token') {
      let timer: number | undefined
      const expireWhenDue = () => {
        const remainingMs = snapshot.tokenExpiresAt! - Date.now()
        if (remainingMs > 0) {
          timer = window.setTimeout(expireWhenDue, Math.min(MAX_TIMER_DELAY_MS, remainingMs))
          return
        }
        setSnapshot(current =>
          current.status === 'connected' &&
          current.credentialMode === 'legacy_access_token' &&
          current.tokenExpiresAt === snapshot.tokenExpiresAt
            ? {
                ...current,
                status: 'expired',
                token: null,
                error: 'Cloud login has expired',
              }
            : current
        )
      }
      expireWhenDue()
      return () => {
        if (timer !== undefined) window.clearTimeout(timer)
      }
    }
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(
        ACCESS_TOKEN_REFRESH_RETRY_MS,
        snapshot.tokenExpiresAt - Date.now() - ACCESS_TOKEN_REFRESH_LEAD_MS
      )
    )
    const timer = window.setTimeout(() => {
      refreshAutomatically()
    }, delayMs)
    return () => window.clearTimeout(timer)
  }, [refreshAutomatically, snapshot.credentialMode, snapshot.status, snapshot.tokenExpiresAt])

  useEffect(() => {
    if (
      !desktopRestoreSettled ||
      snapshot.credentialMode !== 'desktop_refresh' ||
      !snapshot.apiBaseUrl ||
      (snapshot.status !== 'restoring' &&
        snapshot.status !== 'error' &&
        !(snapshot.status === 'connected' && snapshot.error))
    ) {
      return
    }
    const timer = window.setInterval(() => {
      refreshAutomatically()
    }, ACCESS_TOKEN_REFRESH_RETRY_MS)
    return () => window.clearInterval(timer)
  }, [
    desktopRestoreSettled,
    refreshAutomatically,
    snapshot.apiBaseUrl,
    snapshot.credentialMode,
    snapshot.error,
    snapshot.status,
  ])

  useEffect(() => {
    const refresh = () => {
      if (
        snapshot.apiBaseUrl &&
        (snapshot.status === 'connected' ||
          (snapshot.credentialMode === 'desktop_refresh' &&
            (snapshot.status === 'restoring' || snapshot.status === 'error')))
      ) {
        refreshAutomatically()
      }
    }
    const unsubscribeResume = subscribeSystemResume(refresh)
    window.addEventListener('online', refresh)
    return () => {
      unsubscribeResume()
      window.removeEventListener('online', refresh)
    }
  }, [refreshAutomatically, snapshot.apiBaseUrl, snapshot.credentialMode, snapshot.status])

  const value = useMemo<CloudConnectionContextValue>(() => {
    const activeSnapshot =
      snapshot.status === 'connected' && !readStoredCloudConnection()
        ? DISCONNECTED_STATE
        : snapshot
    const effectiveSnapshot =
      authorization && activeSnapshot.status !== 'connected'
        ? {
            ...activeSnapshot,
            status: 'connecting' as const,
            error: null,
          }
        : activeSnapshot
    const isConnected = effectiveSnapshot.status === 'connected' && Boolean(effectiveSnapshot.token)
    return {
      ...effectiveSnapshot,
      isConnected,
      serviceKey: isConnected
        ? `${effectiveSnapshot.apiBaseUrl ?? ''}:${effectiveSnapshot.tokenExpiresAt ?? ''}:${effectiveSnapshot.user?.id ?? ''}`
        : effectiveSnapshot.status,
      connectWithAuthorization,
      refreshUser,
      disconnect,
    }
  }, [authorization, connectWithAuthorization, disconnect, refreshUser, snapshot])

  return <CloudConnectionContext.Provider value={value}>{children}</CloudConnectionContext.Provider>
}
