import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LoginRequest, LoginResponse } from '@/api/auth'
import { ApiError, createHttpClient } from '@/api/http'
import { ADMIN_PASSWORD_SETUP_REQUIRED_ERROR_CODE } from '@/features/auth/adminPasswordSetup'
import type { User } from '@/types/api'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
  type CloudConnectionContextValue,
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

function snapshotFromStored(): CloudConnectionSnapshot {
  const stored = readStoredCloudConnection()
  if (!stored) return DISCONNECTED_STATE

  if (isCloudTokenExpired(stored.tokenExpiresAt)) {
    return {
      status: 'expired',
      backendUrl: stored.backendUrl,
      apiBaseUrl: stored.apiBaseUrl,
      socketBaseUrl: stored.socketBaseUrl,
      socketPath: stored.socketPath,
      token: null,
      tokenExpiresAt: stored.tokenExpiresAt,
      user: stored.user,
      connectedAt: stored.connectedAt,
      error: 'Cloud login has expired',
    }
  }

  return {
    status: 'connected',
    backendUrl: stored.backendUrl,
    apiBaseUrl: stored.apiBaseUrl,
    socketBaseUrl: stored.socketBaseUrl,
    socketPath: stored.socketPath,
    token: stored.token,
    tokenExpiresAt: stored.tokenExpiresAt,
    user: stored.user,
    connectedAt: stored.connectedAt,
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

async function fetchCloudUser(config: CloudConnectionRuntimeConfig, token: string): Promise<User> {
  const client = createCloudClient(config, token)
  return runCloudRequest('读取云端用户', config, '/users/me', () =>
    client.get<User>('/users/me', { redirectOnUnauthorized: false })
  )
}

async function loginCloudUser(
  config: CloudConnectionRuntimeConfig,
  credentials: LoginRequest
): Promise<LoginResponse> {
  const client = createCloudClient(config, null)
  return runCloudRequest(
    '登录云端',
    config,
    '/auth/login',
    () => client.post<LoginResponse>('/auth/login', credentials),
    { preserveErrorCodes: [ADMIN_PASSWORD_SETUP_REQUIRED_ERROR_CODE] }
  )
}

async function setupCloudAdminPassword(
  config: CloudConnectionRuntimeConfig,
  password: string
): Promise<LoginResponse> {
  const client = createCloudClient(config, null)
  return runCloudRequest('初始化管理员密码', config, '/auth/admin-password/setup', () =>
    client.post<LoginResponse>('/auth/admin-password/setup', { password })
  )
}

function connectionSnapshot(
  config: CloudConnectionRuntimeConfig,
  token: string,
  user: User
): CloudConnectionSnapshot {
  return {
    ...config,
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

  const applyConnectedSnapshot = useCallback((nextSnapshot: CloudConnectionSnapshot) => {
    persistSnapshot(nextSnapshot)
    setSnapshot(nextSnapshot)
  }, [])

  const connectWithPassword = useCallback(
    async (backendUrl: string, credentials: LoginRequest): Promise<User> => {
      const config = normalizeCloudBackendUrl(backendUrl)
      setSnapshot(current => ({
        ...current,
        ...config,
        status: 'connecting',
        error: null,
      }))

      try {
        await checkCloudHealth(config)
        const response = await loginCloudUser(config, credentials)
        const user = await fetchCloudUser(config, response.access_token)
        applyConnectedSnapshot(connectionSnapshot(config, response.access_token, user))
        return user
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

  const setupAdminPassword = useCallback(
    async (backendUrl: string, password: string): Promise<User> => {
      const config = normalizeCloudBackendUrl(backendUrl)
      setSnapshot(current => ({
        ...current,
        ...config,
        status: 'connecting',
        error: null,
      }))

      try {
        await checkCloudHealth(config)
        const response = await setupCloudAdminPassword(config, password)
        const user = await fetchCloudUser(config, response.access_token)
        applyConnectedSnapshot(connectionSnapshot(config, response.access_token, user))
        return user
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
      const nextSnapshot = { ...snapshot, status: 'connected' as const, user, error: null }
      applyConnectedSnapshot(nextSnapshot)
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
  }, [applyConnectedSnapshot, snapshot])

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
      connectWithPassword,
      setupAdminPassword,
      refreshUser,
      disconnect,
    }
  }, [connectWithPassword, disconnect, refreshUser, setupAdminPassword, snapshot])

  return <CloudConnectionContext.Provider value={value}>{children}</CloudConnectionContext.Provider>
}
