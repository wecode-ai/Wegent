import type { User } from '@/types/api'

const CLOUD_CONNECTION_STORAGE_KEY = 'wework.cloudConnection'
const DEFAULT_SOCKET_PATH = '/socket.io'

export type CloudConnectionStatus =
  | 'disconnected'
  | 'restoring'
  | 'connecting'
  | 'connected'
  | 'expired'
  | 'error'

export type CloudCredentialMode = 'desktop_refresh' | 'legacy_access_token'

export interface CloudConnectionRuntimeConfig {
  backendUrl: string
  apiBaseUrl: string
  socketBaseUrl: string
  socketPath: string
}

export interface StoredCloudConnection extends CloudConnectionRuntimeConfig {
  socketBaseUrlOverride?: string
  webUrl?: string
  credentialMode?: CloudCredentialMode
  token?: string
  tokenExpiresAt?: number | null
  user: User
  connectedAt: string
}

export interface CloudConnectionSnapshot extends Partial<CloudConnectionRuntimeConfig> {
  socketBaseUrlOverride?: string
  webUrl?: string
  status: CloudConnectionStatus
  credentialMode?: CloudCredentialMode | null
  token: string | null
  tokenExpiresAt: number | null
  user: User | null
  connectedAt: string | null
  error: string | null
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function ensureProtocol(value: string): string {
  const trimmed = value.trim()
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)) {
    return trimmed
  }
  return `http://${trimmed}`
}

function normalizeSocketBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Socket URL is invalid')
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('Socket URL is invalid')
  }
  return trimTrailingSlash(url.toString())
}

function normalizeBackendUrlPath(pathname: string): {
  backendPath: string
  apiPath: string
} {
  const normalizedPath = pathname.replace(/\/+$/g, '')
  if (!normalizedPath || normalizedPath === '/') {
    return { backendPath: '', apiPath: '/api' }
  }

  const segments = normalizedPath.split('/').filter(Boolean)
  const apiIndex = segments.findIndex(segment => segment === 'api')
  if (apiIndex >= 0) {
    const backendSegments = segments.slice(0, apiIndex)
    const apiSegments = segments.slice(0, apiIndex + 1)
    return {
      backendPath: backendSegments.length > 0 ? `/${backendSegments.join('/')}` : '',
      apiPath: `/${apiSegments.join('/')}`,
    }
  }

  return {
    backendPath: normalizedPath,
    apiPath: `${normalizedPath}/api`,
  }
}

export function normalizeCloudBackendUrl(
  input: string,
  socketBaseUrlOverride?: string
): CloudConnectionRuntimeConfig {
  const value = input.trim()
  if (!value) {
    throw new Error('Backend URL is required')
  }

  let url: URL
  try {
    url = new URL(ensureProtocol(value))
  } catch {
    throw new Error('Backend URL is invalid')
  }

  const { backendPath, apiPath } = normalizeBackendUrlPath(url.pathname)
  const origin = url.origin
  const backendUrl = trimTrailingSlash(`${origin}${backendPath}`)
  const apiBaseUrl = trimTrailingSlash(`${origin}${apiPath}`)
  const socketBaseUrl = socketBaseUrlOverride?.trim()
  return {
    backendUrl,
    apiBaseUrl,
    socketBaseUrl: socketBaseUrl ? normalizeSocketBaseUrl(socketBaseUrl) : backendUrl || origin,
    socketPath: DEFAULT_SOCKET_PATH,
  }
}

export function getJwtExpiry(token: string): number | null {
  try {
    const payloadPart = token.split('.')[1]
    if (!payloadPart) return null
    const normalizedPayload = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
    const paddedPayload = normalizedPayload.padEnd(
      normalizedPayload.length + ((4 - (normalizedPayload.length % 4)) % 4),
      '='
    )
    const payload = JSON.parse(atob(paddedPayload)) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

export function readStoredCloudConnection(): StoredCloudConnection | null {
  try {
    const value = localStorage.getItem(CLOUD_CONNECTION_STORAGE_KEY)
    if (!value) return null
    return normalizeStoredCloudConnection(JSON.parse(value))
  } catch {
    return null
  }
}

export function normalizeStoredCloudConnection(value: unknown): StoredCloudConnection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const parsed = value as Partial<StoredCloudConnection>
  if (
    typeof parsed.backendUrl !== 'string' ||
    typeof parsed.apiBaseUrl !== 'string' ||
    typeof parsed.socketBaseUrl !== 'string' ||
    typeof parsed.socketPath !== 'string' ||
    (parsed.socketBaseUrlOverride !== undefined &&
      typeof parsed.socketBaseUrlOverride !== 'string') ||
    (parsed.credentialMode !== undefined &&
      !['desktop_refresh', 'legacy_access_token'].includes(parsed.credentialMode)) ||
    (parsed.token !== undefined && (typeof parsed.token !== 'string' || !parsed.token.trim())) ||
    (parsed.tokenExpiresAt !== undefined &&
      parsed.tokenExpiresAt !== null &&
      (typeof parsed.tokenExpiresAt !== 'number' || !Number.isFinite(parsed.tokenExpiresAt))) ||
    !parsed.user ||
    typeof parsed.user !== 'object' ||
    typeof parsed.connectedAt !== 'string'
  ) {
    return null
  }
  const credentialMode =
    parsed.credentialMode ?? (parsed.token ? 'legacy_access_token' : 'desktop_refresh')
  if (credentialMode === 'legacy_access_token' && !parsed.token) return null
  return {
    backendUrl: parsed.backendUrl,
    apiBaseUrl: parsed.apiBaseUrl,
    socketBaseUrl: parsed.socketBaseUrl,
    socketPath: parsed.socketPath,
    socketBaseUrlOverride: parsed.socketBaseUrlOverride,
    webUrl: parsed.webUrl,
    credentialMode,
    token: credentialMode === 'legacy_access_token' ? parsed.token : undefined,
    tokenExpiresAt:
      credentialMode === 'legacy_access_token' ? (parsed.tokenExpiresAt ?? null) : undefined,
    user: parsed.user,
    connectedAt: parsed.connectedAt,
  }
}

export function saveStoredCloudConnection(connection: StoredCloudConnection): void {
  localStorage.setItem(CLOUD_CONNECTION_STORAGE_KEY, JSON.stringify(connection))
}

export function clearStoredCloudConnection(): void {
  localStorage.removeItem(CLOUD_CONNECTION_STORAGE_KEY)
}
