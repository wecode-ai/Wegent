import type { User } from '@/types/api'

const CLOUD_CONNECTION_STORAGE_KEY = 'wework.cloudConnection'
const DEFAULT_SOCKET_PATH = '/socket.io'

export type CloudConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'expired'
  | 'error'

export interface CloudConnectionRuntimeConfig {
  backendUrl: string
  apiBaseUrl: string
  socketBaseUrl: string
  socketPath: string
}

export interface StoredCloudConnection extends CloudConnectionRuntimeConfig {
  token: string
  tokenExpiresAt: number | null
  user: User
  connectedAt: string
}

export interface CloudConnectionSnapshot extends Partial<CloudConnectionRuntimeConfig> {
  status: CloudConnectionStatus
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

export function normalizeCloudBackendUrl(input: string): CloudConnectionRuntimeConfig {
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
  return {
    backendUrl,
    apiBaseUrl,
    socketBaseUrl: backendUrl || origin,
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

export function isCloudTokenExpired(tokenExpiresAt: number | null): boolean {
  return typeof tokenExpiresAt === 'number' && Date.now() >= tokenExpiresAt
}

export function readStoredCloudConnection(): StoredCloudConnection | null {
  try {
    const value = localStorage.getItem(CLOUD_CONNECTION_STORAGE_KEY)
    if (!value) return null
    const parsed = JSON.parse(value) as Partial<StoredCloudConnection>
    if (
      !parsed ||
      typeof parsed.backendUrl !== 'string' ||
      typeof parsed.apiBaseUrl !== 'string' ||
      typeof parsed.socketBaseUrl !== 'string' ||
      typeof parsed.socketPath !== 'string' ||
      typeof parsed.token !== 'string' ||
      !parsed.user ||
      typeof parsed.user !== 'object' ||
      typeof parsed.connectedAt !== 'string'
    ) {
      return null
    }
    return parsed as StoredCloudConnection
  } catch {
    return null
  }
}

export function saveStoredCloudConnection(connection: StoredCloudConnection): void {
  localStorage.setItem(CLOUD_CONNECTION_STORAGE_KEY, JSON.stringify(connection))
}

export function clearStoredCloudConnection(): void {
  localStorage.removeItem(CLOUD_CONNECTION_STORAGE_KEY)
}
