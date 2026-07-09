export interface LocalProxyConfig {
  configured: boolean
  proxyUrlMasked: string
  updatedAt: string | null
}

interface StoredLocalProxyConfig {
  proxyUrl?: string
  updatedAt?: string
}

export const LOCAL_PROXY_SETTINGS_CHANGED_EVENT = 'wework:local-proxy-settings-changed'

const LOCAL_PROXY_SETTINGS_STORAGE_KEY = 'wework.local-proxy-settings'
const MAX_PROXY_URL_BYTES = 2048
const SUPPORTED_PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:'])

function readStoredLocalProxyConfig(): StoredLocalProxyConfig {
  const raw = globalThis.localStorage?.getItem(LOCAL_PROXY_SETTINGS_STORAGE_KEY)
  if (!raw) return {}

  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as StoredLocalProxyConfig) : {}
  } catch {
    return {}
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

export function normalizeLocalProxyUrl(proxyUrl: string): string {
  const normalized = proxyUrl.trim()
  if (!normalized) return ''

  if (byteLength(normalized) > MAX_PROXY_URL_BYTES) {
    throw new Error('proxy_url is too large')
  }
  if (/\s/.test(normalized)) {
    throw new Error('proxy_url must not contain whitespace')
  }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch (error) {
    throw new Error('proxy_url must be a valid URL', { cause: error })
  }

  if (!SUPPORTED_PROXY_SCHEMES.has(parsed.protocol)) {
    throw new Error('proxy_url scheme must be http, https, or socks5')
  }
  if (!parsed.hostname || !parsed.port) {
    throw new Error('proxy_url must include host and port')
  }

  return normalized
}

export function maskLocalProxyUrl(proxyUrl: string): string {
  if (!proxyUrl) return ''

  try {
    const parsed = new URL(proxyUrl)
    if (!parsed.username && !parsed.password) return proxyUrl
    parsed.username = '***'
    parsed.password = '***'
    return parsed.toString()
  } catch {
    return proxyUrl
  }
}

export function getLocalProxyUrl(): string {
  const proxyUrl = readStoredLocalProxyConfig().proxyUrl
  return typeof proxyUrl === 'string' ? proxyUrl : ''
}

export function getLocalProxyConfig(): LocalProxyConfig {
  const stored = readStoredLocalProxyConfig()
  const proxyUrl = typeof stored.proxyUrl === 'string' ? stored.proxyUrl : ''
  return {
    configured: proxyUrl.length > 0,
    proxyUrlMasked: maskLocalProxyUrl(proxyUrl),
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
  }
}

export function saveLocalProxyUrl(proxyUrl: string): LocalProxyConfig {
  const normalizedProxyUrl = normalizeLocalProxyUrl(proxyUrl)
  const updatedAt = new Date().toISOString()

  if (normalizedProxyUrl) {
    globalThis.localStorage?.setItem(
      LOCAL_PROXY_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        proxyUrl: normalizedProxyUrl,
        updatedAt,
      })
    )
  } else {
    globalThis.localStorage?.removeItem(LOCAL_PROXY_SETTINGS_STORAGE_KEY)
  }

  globalThis.dispatchEvent?.(new Event(LOCAL_PROXY_SETTINGS_CHANGED_EVENT))
  return getLocalProxyConfig()
}
