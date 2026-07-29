import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, createHttpClient } from '@/api/http'
import { createPluginApi } from '@/api/plugins'
import { getConfiguredSocketBaseUrl, getRuntimeConfig } from '@/config/runtime'
import { WEGENT_SITES_PLUGIN_NAME } from '@/features/plugins/builtinPlugins'
import type { User } from '@/types/api'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
  type CloudAuthorizationHandle,
  type CloudConnectionContextValue,
  type OpenCloudAuthorizationUrl,
} from './CloudConnectionContext'
import {
  clearStoredCloudConnection,
  getJwtExpiry,
  isCloudTokenExpired,
  normalizeCloudBackendUrl,
  readStoredCloudConnection,
  saveStoredCloudConnection,
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
  access_token?: string
  token_type?: string
  username?: string
  error?: string
}

interface WeworkCloudConfigResponse {
  web_url?: unknown
  socket_url?: unknown
}

const DEFAULT_AUTH_POLL_INTERVAL_MS = 2000
const CLOUD_AUTHORIZATION_CLOSED_MESSAGE = '云端授权窗口已关闭，请重新连接'

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

function snapshotFromStored(): CloudConnectionSnapshot {
  const stored = readStoredCloudConnection()
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

  if (isCloudTokenExpired(migrated.tokenExpiresAt)) {
    return {
      status: 'expired',
      webUrl: migrated.webUrl,
      backendUrl: migrated.backendUrl,
      apiBaseUrl: migrated.apiBaseUrl,
      socketBaseUrl: migrated.socketBaseUrl,
      socketPath: migrated.socketPath,
      socketBaseUrlOverride: migrated.socketBaseUrlOverride,
      token: null,
      tokenExpiresAt: migrated.tokenExpiresAt,
      user: migrated.user,
      connectedAt: migrated.connectedAt,
      error: 'Cloud login has expired',
    }
  }

  return {
    status: 'connected',
    webUrl: migrated.webUrl,
    backendUrl: migrated.backendUrl,
    apiBaseUrl: migrated.apiBaseUrl,
    socketBaseUrl: migrated.socketBaseUrl,
    socketPath: migrated.socketPath,
    socketBaseUrlOverride: migrated.socketBaseUrlOverride,
    token: migrated.token,
    tokenExpiresAt: migrated.tokenExpiresAt,
    user: migrated.user,
    connectedAt: migrated.connectedAt,
    error: null,
  }
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

function isTauriHttpScopeError(error: unknown): boolean {
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
  if (isTauriHttpScopeError(error)) {
    return `${stage}失败（${url}）：桌面端 HTTP 权限拦截了这个 Backend 地址。请重启 App 后再试。`
  }
  return `${stage}失败（${url}）：${rawErrorMessage(error)}`
}

async function runCloudRequest<T>(
  stage: string,
  config: CloudConnectionRuntimeConfig,
  endpoint: string,
  request: () => Promise<T>,
  options: { preserveErrorCodes?: string[] } = {}
): Promise<T> {
  const url = cloudRequestUrl(config, endpoint)
  console.info('[CloudConnection] request start', { stage, url })
  try {
    const response = await request()
    console.info('[CloudConnection] request success', { stage, url })
    return response
  } catch (error) {
    console.error('[CloudConnection] request failed', { stage, url, error })
    if (
      error instanceof ApiError &&
      typeof error.errorCode === 'string' &&
      options.preserveErrorCodes?.includes(error.errorCode)
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
  config: CloudConnectionRuntimeConfig
): Promise<{ webUrl: string; socketUrl?: string }> {
  const client = createCloudClient(config, null)
  const metadata = await client.get<WeworkCloudConfigResponse>('/auth/wework/config', {
    redirectOnUnauthorized: false,
  })
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

async function fetchCloudUser(config: CloudConnectionRuntimeConfig, token: string): Promise<User> {
  const client = createCloudClient(config, token)
  return runCloudRequest('读取云端用户', config, '/users/me', () =>
    client.get<User>('/users/me', { redirectOnUnauthorized: false })
  )
}

async function ensureCloudSitesPlugin(
  config: CloudConnectionRuntimeConfig,
  token: string
): Promise<void> {
  const pluginApi = createPluginApi(createCloudClient(config, token))
  const installedPlugins = await runCloudRequest(
    '检查云端 Sites 插件',
    config,
    '/plugins/installed',
    () => pluginApi.listInstalledPlugins()
  )
  const sitesInstalled = installedPlugins.items.some(plugin => {
    const source = plugin.spec.source
    return (
      source.type === 'marketplace' &&
      source.providerKey === 'wegent-marketplace' &&
      source.pluginKey === WEGENT_SITES_PLUGIN_NAME &&
      source.marketplace === 'wegent' &&
      plugin.spec.enabled &&
      plugin.spec.installState === 'installed'
    )
  })
  if (sitesInstalled) return

  await runCloudRequest(
    '安装云端 Sites 插件',
    config,
    `/plugins/builtin/${WEGENT_SITES_PLUGIN_NAME}/ensure-installed`,
    () => pluginApi.ensureBuiltinPluginInstalled(WEGENT_SITES_PLUGIN_NAME)
  )
}

async function createWeworkAuthSession(
  config: CloudConnectionRuntimeConfig
): Promise<WeworkAuthSessionCreateResponse> {
  const client = createCloudClient(config, null)
  return runCloudRequest('创建云端授权会话', config, '/auth/wework/sessions', () =>
    client.post<WeworkAuthSessionCreateResponse>('/auth/wework/sessions')
  )
}

async function pollWeworkAuthSession(
  config: CloudConnectionRuntimeConfig,
  session: WeworkAuthSessionCreateResponse
): Promise<WeworkAuthSessionPollResponse> {
  const client = createCloudClient(config, null)
  const endpoint = `/auth/wework/sessions/${encodeURIComponent(
    session.session_id
  )}/poll?poll_token=${encodeURIComponent(session.poll_token)}`
  return runCloudRequest('等待云端授权', config, endpoint, () =>
    client.get<WeworkAuthSessionPollResponse>(endpoint, { redirectOnUnauthorized: false })
  )
}

function connectionSnapshot(
  config: CloudConnectionRuntimeConfig,
  webUrl: string,
  token: string,
  user: User,
  socketBaseUrlOverride?: string
): CloudConnectionSnapshot {
  return {
    ...config,
    socketBaseUrlOverride: socketBaseUrlOverride?.trim() || undefined,
    webUrl: webUrl.replace(/\/+$/, ''),
    status: 'connected',
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

  saveStoredCloudConnection({
    backendUrl: snapshot.backendUrl,
    apiBaseUrl: snapshot.apiBaseUrl,
    socketBaseUrl: snapshot.socketBaseUrl,
    socketPath: snapshot.socketPath,
    socketBaseUrlOverride: snapshot.socketBaseUrlOverride,
    webUrl: snapshot.webUrl,
    token: snapshot.token,
    tokenExpiresAt: snapshot.tokenExpiresAt,
    user: snapshot.user,
    connectedAt: snapshot.connectedAt,
  })
}

function getCloudErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Cloud login has expired'
  return rawErrorMessage(error)
}

export function CloudConnectionProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<CloudConnectionSnapshot>(() => snapshotFromStored())
  const initialRefreshStartedRef = useRef(false)
  const sitesPluginInitializationKeyRef = useRef<string | null>(null)

  const applyConnectedSnapshot = useCallback((nextSnapshot: CloudConnectionSnapshot) => {
    persistSnapshot(nextSnapshot)
    setSnapshot(nextSnapshot)
  }, [])

  useEffect(() => {
    if (snapshot.status !== 'connected' || !snapshot.backendUrl) return
    const backendUrl = snapshot.backendUrl
    const config = resolveCloudRuntimeConfig(backendUrl, snapshot.socketBaseUrlOverride)
    void fetchCloudConfig(config)
      .then(metadata => {
        const resolvedConfig = resolveCloudRuntimeConfig(
          backendUrl,
          snapshot.socketBaseUrlOverride,
          metadata.socketUrl
        )
        setSnapshot(current => {
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
  }, [snapshot.backendUrl, snapshot.socketBaseUrlOverride, snapshot.status])

  useEffect(() => {
    if (
      snapshot.status !== 'connected' ||
      !snapshot.backendUrl ||
      !snapshot.apiBaseUrl ||
      !snapshot.token ||
      !snapshot.user
    ) {
      sitesPluginInitializationKeyRef.current = null
      return
    }

    const initializationKey = `${snapshot.apiBaseUrl}:${snapshot.user.id}:${snapshot.token}`
    if (sitesPluginInitializationKeyRef.current === initializationKey) return
    sitesPluginInitializationKeyRef.current = initializationKey
    const config: CloudConnectionRuntimeConfig = {
      backendUrl: snapshot.backendUrl,
      apiBaseUrl: snapshot.apiBaseUrl,
      socketBaseUrl: snapshot.socketBaseUrl ?? snapshot.backendUrl,
      socketPath: snapshot.socketPath ?? '/socket.io',
    }
    void ensureCloudSitesPlugin(config, snapshot.token).catch(error => {
      sitesPluginInitializationKeyRef.current = null
      console.error('[CloudConnection] Failed to initialize the Sites plugin', error)
    })
  }, [
    snapshot.apiBaseUrl,
    snapshot.backendUrl,
    snapshot.socketBaseUrl,
    snapshot.socketPath,
    snapshot.status,
    snapshot.token,
    snapshot.user,
  ])

  const connectWithAuthorization = useCallback(
    async (
      backendUrl: string,
      openAuthorizationUrl?: OpenCloudAuthorizationUrl,
      socketBaseUrlOverride?: string
    ): Promise<User> => {
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
          if (!pollResult.access_token) {
            throw new Error('云端授权未返回登录凭证')
          }
          await Promise.resolve(authorizationHandle?.close?.()).catch(error => {
            console.warn('[CloudConnection] Failed to close authorization window', error)
          })
          const user = await fetchCloudUser(config, pollResult.access_token)
          applyConnectedSnapshot(
            connectionSnapshot(
              config,
              session.web_url,
              pollResult.access_token,
              user,
              socketBaseUrlOverride
            )
          )
          return user
        }

        throw new Error('云端授权已超时，请重新连接')
      } catch (error) {
        setSnapshot(current => ({
          ...current,
          ...config,
          status: 'error',
          token: null,
          error: getCloudErrorMessage(error),
        }))
        throw error
      }
    },
    [applyConnectedSnapshot]
  )
  const refreshUser = useCallback(async (): Promise<User | null> => {
    if (!snapshot.apiBaseUrl || !snapshot.token) return null
    const config = {
      backendUrl: snapshot.backendUrl ?? '',
      apiBaseUrl: snapshot.apiBaseUrl,
      socketBaseUrl: snapshot.socketBaseUrl ?? snapshot.backendUrl ?? '',
      socketPath: snapshot.socketPath ?? '/socket.io',
    }

    try {
      const user = await fetchCloudUser(config, snapshot.token)
      setSnapshot(current => {
        const nextSnapshot = { ...current, status: 'connected' as const, user, error: null }
        persistSnapshot(nextSnapshot)
        return nextSnapshot
      })
      return user
    } catch (error) {
      setSnapshot(current => ({
        ...current,
        status: error instanceof ApiError && error.status === 401 ? 'expired' : 'error',
        token: null,
        error: getCloudErrorMessage(error),
      }))
      return null
    }
  }, [snapshot])

  const disconnect = useCallback(() => {
    clearStoredCloudConnection()
    setSnapshot(DISCONNECTED_STATE)
  }, [])

  useEffect(() => {
    if (initialRefreshStartedRef.current || snapshot.status !== 'connected') {
      return
    }
    initialRefreshStartedRef.current = true
    void refreshUser()
  }, [refreshUser, snapshot.status])

  const value = useMemo<CloudConnectionContextValue>(() => {
    const isConnected = snapshot.status === 'connected' && Boolean(snapshot.token)
    return {
      ...snapshot,
      isConnected,
      serviceKey: isConnected
        ? `${snapshot.apiBaseUrl ?? ''}:${snapshot.tokenExpiresAt ?? ''}:${snapshot.user?.id ?? ''}`
        : snapshot.status,
      connectWithAuthorization,
      refreshUser,
      disconnect,
    }
  }, [connectWithAuthorization, disconnect, refreshUser, snapshot])

  return <CloudConnectionContext.Provider value={value}>{children}</CloudConnectionContext.Provider>
}
