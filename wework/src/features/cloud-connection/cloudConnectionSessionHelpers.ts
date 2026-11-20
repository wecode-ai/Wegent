import type { TFunction } from 'i18next'
import { ApiError } from '@/api/http'
import { getConfiguredSocketBaseUrl, getRuntimeConfig } from '@/config/runtime'
import {
  DesktopCloudCredentialError,
  refreshDesktopCloudAccessToken,
} from '@/desktop/cloudCredentials'
import { raceWithTimeout } from '@/lib/promise-timeout'
import { updateAppPreferences } from '@/desktop/appPreferences'
import { getDesktopE2ERuntimeConfig } from '@/e2e/runtime-config'
import type { User } from '@/types/api'
import { DISCONNECTED_STATE, type CloudAuthorizationHandle } from './CloudConnectionContext'
import { rawErrorMessage } from './cloudConnectionRequests'
import {
  clearStoredCloudConnection,
  getJwtExpiry,
  normalizeCloudBackendUrl,
  readStoredCloudConnection,
  saveStoredCloudConnection,
  type CloudCredentialMode,
  type CloudConnectionRuntimeConfig,
  type CloudConnectionSnapshot,
} from './cloudConnectionStorage'

export const DEFAULT_AUTH_POLL_INTERVAL_MS = 2000
export const CLOUD_AUTHORIZATION_CLOSED_MESSAGE = '云端授权窗口已关闭，请重新连接'
export const CLOUD_STARTUP_REQUEST_TIMEOUT_MS = 8000
export const ACCESS_TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000
export const ACCESS_TOKEN_REFRESH_RETRY_MS = 60 * 1000
export const ACCESS_TOKEN_REFRESH_TIMEOUT_MS = 45 * 1000
export const MAX_TIMER_DELAY_MS = 2_147_483_647
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
/** Stable code the main process reports when a cloud credential call times out. */
export const CLOUD_CREDENTIAL_REQUEST_TIMEOUT_CODE = 'request_timeout'

export function isLocalBackendSocketMirror(backendUrl: string, socketUrl: string): boolean {
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
export async function requestDesktopCloudAccessToken(
  apiBaseUrl: string,
  userId: number
): Promise<string> {
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

export async function resolveAccessToken(
  apiBaseUrl: string,
  credentialMode: CloudCredentialMode,
  existingToken: string | null,
  userId: number
): Promise<string | null> {
  if (credentialMode === 'legacy_access_token') return existingToken
  return requestDesktopCloudAccessToken(apiBaseUrl, userId)
}

export function resolveCloudRuntimeConfig(
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

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms)
  })
}

export function authWindowClosedPromise(
  handle: CloudAuthorizationHandle | void
): Promise<never> | null {
  if (!handle?.closed) return null
  return handle.closed.then(() => {
    throw new Error(CLOUD_AUTHORIZATION_CLOSED_MESSAGE)
  })
}

export function snapshotFromConnection(
  stored: ReturnType<typeof readStoredCloudConnection>,
  persist = true
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
    if (persist) clearStoredCloudConnection()
    return DISCONNECTED_STATE
  }
  const migrated = {
    ...stored,
    ...normalizedConfig,
  }
  if (
    persist &&
    (migrated.apiBaseUrl !== stored.apiBaseUrl ||
      migrated.socketBaseUrl !== stored.socketBaseUrl ||
      migrated.socketPath !== stored.socketPath)
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

export function snapshotFromStored(persist = true): CloudConnectionSnapshot {
  return snapshotFromConnection(readStoredCloudConnection(), persist)
}

export function connectionSnapshot(
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

export function persistSnapshot(snapshot: CloudConnectionSnapshot): void {
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

export function getCloudErrorMessage(error: unknown, t: TFunction): string {
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
