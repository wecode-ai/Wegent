import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, createHttpClient } from '@/api/http'
import { getConfiguredSocketBaseUrl, getRuntimeConfig } from '@/config/runtime'
import {
  claimDesktopCloudAuthorization,
  clearDesktopCloudCredentials,
  DesktopCloudCredentialError,
  getDesktopDevicePublicKey,
  refreshDesktopCloudAccessToken,
} from '@/desktop/cloudCredentials'
import { raceWithTimeout } from '@/lib/promise-timeout'
import { getAppPreferences, updateAppPreferences } from '@/desktop/appPreferences'
import { subscribeSystemResume } from '@/desktop/systemResume'
import { getDesktopE2ERuntimeConfig } from '@/e2e/runtime-config'
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

interface WeworkAuthSessionCreateResponse {
  session_id: string
  poll_token: string
  authorize_url: string
  web_url: string
  expires_at: number
  poll_interval_seconds: number
}

interface WeworkAuthSessionPollResponse {
  status: 'pending' | 'success' | 'declined' | 'failed'
  accessToken?: string
  tokenType?: string
  username?: string
  credentialMode?: CloudCredentialMode
  error?: string
}

interface WeworkCloudConfigResponse {
  web_url?: unknown
  socket_url?: unknown
}

const DEFAULT_AUTH_POLL_INTERVAL_MS = 2000
const CLOUD_AUTHORIZATION_CLOSED_MESSAGE = '云端授权窗口已关闭，请重新连接'
const CLOUD_STARTUP_REQUEST_TIMEOUT_MS = 8000
const ACCESS_TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000
const ACCESS_TOKEN_REFRESH_RETRY_MS = 60 * 1000
const MAX_TIMER_DELAY_MS = 2_147_483_647

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
  return backendSocketUrl?.trim()
    ? normalizeCloudBackendUrl(backendUrl, backendSocketUrl)
    : normalized
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
    normalizedConfig = resolveCloudRuntimeConfig(stored.backendUrl, stored.socketBaseUrlOverride)
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

function createCloudClient(config: CloudConnectionRuntimeConfig, token: string | null) {
  return createHttpClient({
    baseUrl: config.apiBaseUrl,
    getToken: () => token,
    redirectOnUnauthorized: false,
  })
}

function cloudRequestUrl(config: CloudConnectionRuntimeConfig, endpoint: string): string {
  return `${config.apiBaseUrl}${endpoint}`
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message || `HTTP ${error.status}`
  if (error instanceof Error && error.message) return error.message
  return 'Cloud connection failed'
}

function isDesktopHttpPermissionError(error: unknown): boolean {
  const message = rawErrorMessage(error).toLowerCase()
  return message.includes('scope') || message.includes('not allowed') || message.includes('denied')
}

function cloudStepErrorMessage(
  stage: string,
  config: CloudConnectionRuntimeConfig,
  endpoint: string,
  error: unknown
): string {
  const url = cloudRequestUrl(config, endpoint)
  if (isDesktopHttpPermissionError(error)) {
    return `${stage}失败（${url}）：桌面端 HTTP 权限拦截了这个 Backend 地址。请重启 App 后再试。`
  }
  return `${stage}失败（${url}）：${rawErrorMessage(error)}`
}

async function runCloudRequest<T>(
  stage: string,
  config: CloudConnectionRuntimeConfig,
  endpoint: string,
  request: () => Promise<T>,
  options: {
    preserveErrorCodes?: string[]
    preserveStatuses?: number[]
    timeoutMs?: number
  } = {}
): Promise<T> {
  const url = cloudRequestUrl(config, endpoint)
  console.info('[CloudConnection] request start', { stage, url })
  try {
    const response = await raceWithTimeout(request(), options.timeoutMs, timeoutMs => {
      return new Error(`Request timed out after ${timeoutMs}ms`)
    })
    console.info('[CloudConnection] request success', { stage, url })
    return response
  } catch (error) {
    console.error('[CloudConnection] request failed', { stage, url, error })
    if (
      error instanceof ApiError &&
      ((typeof error.errorCode === 'string' &&
        options.preserveErrorCodes?.includes(error.errorCode)) ||
        options.preserveStatuses?.includes(error.status))
    ) {
      throw error
    }
    throw new Error(cloudStepErrorMessage(stage, config, endpoint, error), { cause: error })
  }
}

async function checkCloudHealth(config: CloudConnectionRuntimeConfig): Promise<void> {
  const client = createCloudClient(config, null)
  await runCloudRequest('健康检查', config, '/health', () =>
    client.get('/health', { redirectOnUnauthorized: false })
  )
}

async function fetchCloudConfig(
  config: CloudConnectionRuntimeConfig,
  timeoutMs?: number
): Promise<{ webUrl: string; socketUrl?: string }> {
  const client = createCloudClient(config, null)
  const metadata = await runCloudRequest(
    '读取云端配置',
    config,
    '/auth/wework/config',
    () =>
      client.get<WeworkCloudConfigResponse>('/auth/wework/config', {
        redirectOnUnauthorized: false,
      }),
    { timeoutMs }
  )
  if (typeof metadata.web_url !== 'string' || !metadata.web_url.trim()) {
    throw new Error('Cloud Backend did not provide a Web URL')
  }
  const socketUrl =
    typeof metadata.socket_url === 'string' && metadata.socket_url.trim()
      ? metadata.socket_url.trim()
      : undefined
  return {
    webUrl: metadata.web_url.replace(/\/+$/, ''),
    socketUrl,
  }
}

async function fetchCloudUser(
  config: CloudConnectionRuntimeConfig,
  token: string,
  timeoutMs?: number
): Promise<User> {
  const client = createCloudClient(config, token)
  return runCloudRequest(
    '读取云端用户',
    config,
    '/users/me',
    () => client.get<User>('/users/me', { redirectOnUnauthorized: false }),
    { preserveStatuses: [401], timeoutMs }
  )
}

async function createWeworkAuthSession(
  config: CloudConnectionRuntimeConfig
): Promise<WeworkAuthSessionCreateResponse> {
  const devicePublicKey = await getDesktopDevicePublicKey()
  const client = createCloudClient(config, null)
  return runCloudRequest('创建云端授权会话', config, '/auth/wework/sessions', () =>
    client.post<WeworkAuthSessionCreateResponse>('/auth/wework/sessions', {
      device_public_key: devicePublicKey,
    })
  )
}

async function pollWeworkAuthSession(
  config: CloudConnectionRuntimeConfig,
  session: WeworkAuthSessionCreateResponse
): Promise<WeworkAuthSessionPollResponse> {
  const endpoint = `/auth/wework/sessions/${encodeURIComponent(
    session.session_id
  )}/poll?poll_token=${encodeURIComponent(session.poll_token)}`
  return runCloudRequest('等待云端授权', config, endpoint, () =>
    claimDesktopCloudAuthorization({
      apiBaseUrl: config.apiBaseUrl,
      sessionId: session.session_id,
      pollToken: session.poll_token,
    })
  )
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

function getCloudErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Cloud login has expired'
  return rawErrorMessage(error)
}

interface CloudConnectionProviderProps {
  children: ReactNode
}

export function CloudConnectionProvider({ children }: CloudConnectionProviderProps) {
  const [snapshot, setSnapshot] = useState<CloudConnectionSnapshot>(() => snapshotFromStored())
  const [desktopRestoreSettled, setDesktopRestoreSettled] = useState(false)
  const initialRefreshStartedRef = useRef(false)
  const desktopRestoreStartedRef = useRef(false)
  const refreshPromiseRef = useRef<Promise<User | null> | null>(null)
  const refreshGenerationRef = useRef(0)
  const disconnectRequestedRef = useRef(false)

  useEffect(() => {
    if (desktopRestoreStartedRef.current) return
    desktopRestoreStartedRef.current = true
    const restoreGeneration = refreshGenerationRef.current
    void getAppPreferences()
      .then(preferences => {
        if (disconnectRequestedRef.current || refreshGenerationRef.current !== restoreGeneration) {
          return
        }
        const stored = normalizeStoredCloudConnection(preferences.cloudConnection)
        if (!stored) return
        setSnapshot(current => {
          if (
            disconnectRequestedRef.current ||
            refreshGenerationRef.current !== restoreGeneration
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
    (nextSnapshot: CloudConnectionSnapshot, connectionGeneration: number) => {
      setSnapshot(current => {
        if (
          disconnectRequestedRef.current ||
          refreshGenerationRef.current !== connectionGeneration
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
  }, [desktopRestoreSettled, snapshot.backendUrl, snapshot.socketBaseUrlOverride, snapshot.status])

  const connectWithAuthorization = useCallback(
    async (
      backendUrl: string,
      openAuthorizationUrl?: OpenCloudAuthorizationUrl,
      socketBaseUrlOverride?: string
    ): Promise<User> => {
      disconnectRequestedRef.current = false
      const connectionGeneration = refreshGenerationRef.current + 1
      refreshGenerationRef.current = connectionGeneration
      let config = resolveCloudRuntimeConfig(backendUrl, socketBaseUrlOverride)
      setSnapshot(current => ({
        ...current,
        ...config,
        status: 'connecting',
        error: null,
      }))

      try {
        await checkCloudHealth(config)
        const metadata = await fetchCloudConfig(config)
        if (refreshGenerationRef.current !== connectionGeneration) {
          throw new Error('Cloud connection was cancelled')
        }
        config = resolveCloudRuntimeConfig(backendUrl, socketBaseUrlOverride, metadata.socketUrl)
        setSnapshot(current => ({
          ...current,
          ...config,
        }))
        const session = await createWeworkAuthSession(config)
        const authorizationHandle = await openAuthorizationUrl?.(session.authorize_url)
        const windowClosed = authWindowClosedPromise(authorizationHandle)

        const pollIntervalMs =
          Number.isFinite(session.poll_interval_seconds) && session.poll_interval_seconds > 0
            ? session.poll_interval_seconds * 1000
            : DEFAULT_AUTH_POLL_INTERVAL_MS
        const expiresAtMs = session.expires_at * 1000

        while (Date.now() < expiresAtMs) {
          if (windowClosed) {
            await Promise.race([delay(pollIntervalMs), windowClosed])
          } else {
            await delay(pollIntervalMs)
          }
          const pollResult = windowClosed
            ? await Promise.race([pollWeworkAuthSession(config, session), windowClosed])
            : await pollWeworkAuthSession(config, session)
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
            connectionGeneration
          )
          track('cloud_connection_changed', { connected: true })
          return user
        }

        throw new Error('云端授权已超时，请重新连接')
      } catch (error) {
        track('operation_failed', { operation: 'cloud_connect' })
        setSnapshot(current =>
          disconnectRequestedRef.current || refreshGenerationRef.current !== connectionGeneration
            ? current
            : {
                ...current,
                ...config,
                status: 'error',
                token: null,
                error: getCloudErrorMessage(error),
              }
        )
        throw error
      }
    },
    [applyConnectedSnapshot]
  )
  const refreshUser = useCallback((): Promise<User | null> => {
    if (disconnectRequestedRef.current) return Promise.resolve(null)
    if (refreshPromiseRef.current) return refreshPromiseRef.current
    if (!snapshot.apiBaseUrl) return Promise.resolve(null)
    const refreshGeneration = refreshGenerationRef.current
    const credentialMode = snapshot.credentialMode ?? 'desktop_refresh'
    const config = {
      backendUrl: snapshot.backendUrl ?? '',
      apiBaseUrl: snapshot.apiBaseUrl,
      socketBaseUrl: snapshot.socketBaseUrl ?? snapshot.backendUrl ?? '',
      socketPath: snapshot.socketPath ?? '/socket.io',
    }
    const refresh = (async () => {
      try {
        const accessToken =
          credentialMode === 'legacy_access_token'
            ? snapshot.token
            : (await refreshDesktopCloudAccessToken(config.apiBaseUrl)).accessToken
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
          (credentialMode === 'legacy_access_token' &&
            error instanceof ApiError &&
            error.status === 401) ||
          (error instanceof DesktopCloudCredentialError &&
            ['cloud_auth_expired', 'credentials_unavailable'].includes(error.code))
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
                error: getCloudErrorMessage(error),
              }
        )
        return null
      } finally {
        if (refreshGenerationRef.current === refreshGeneration) {
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
  ])

  const disconnect = useCallback(() => {
    disconnectRequestedRef.current = true
    refreshGenerationRef.current += 1
    refreshPromiseRef.current = null
    clearStoredCloudConnection()
    setSnapshot(DISCONNECTED_STATE)
    void updateAppPreferences({ cloudConnection: null }).catch(error => {
      console.error('[CloudConnection] Failed to clear desktop cloud connection', error)
    })
    void Promise.resolve()
      .then(clearDesktopCloudCredentials)
      .catch(error => {
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
      void refreshUser()
    }, delayMs)
    return () => window.clearTimeout(timer)
  }, [refreshUser, snapshot.credentialMode, snapshot.status, snapshot.tokenExpiresAt])

  useEffect(() => {
    const refresh = () => {
      if (snapshot.status === 'connected' && snapshot.apiBaseUrl) void refreshUser()
    }
    const unsubscribeResume = subscribeSystemResume(refresh)
    window.addEventListener('online', refresh)
    return () => {
      unsubscribeResume()
      window.removeEventListener('online', refresh)
    }
  }, [refreshUser, snapshot.apiBaseUrl, snapshot.status])

  const value = useMemo<CloudConnectionContextValue>(() => {
    const effectiveSnapshot =
      snapshot.status === 'connected' && !readStoredCloudConnection()
        ? DISCONNECTED_STATE
        : snapshot
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
  }, [connectWithAuthorization, disconnect, refreshUser, snapshot])

  return <CloudConnectionContext.Provider value={value}>{children}</CloudConnectionContext.Provider>
}
