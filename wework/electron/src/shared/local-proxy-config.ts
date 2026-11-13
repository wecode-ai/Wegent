export const LOCAL_PROXY_SETTINGS_STORAGE_KEY = 'wework.local-proxy-settings'
export type LocalProxyMode = 'system' | 'direct' | 'custom'

/** Interpret the same saved routing preference in the renderer and native model owner. */
export function storedLocalProxyConfig(value: unknown): {
  mode: LocalProxyMode
  proxyUrl: string
  updatedAt: string | null
} {
  const stored = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as {
    mode?: unknown
    proxyUrl?: unknown
    updatedAt?: unknown
  }
  const proxyUrl = typeof stored.proxyUrl === 'string' ? stored.proxyUrl : ''
  const mode = ['system', 'direct', 'custom'].includes(String(stored.mode))
    ? (stored.mode as LocalProxyMode)
    : proxyUrl
      ? 'custom'
      : 'system'
  return {
    mode,
    proxyUrl: mode === 'custom' ? proxyUrl : '',
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
  }
}

const MAX_PROXY_URL_BYTES = 2048
const SUPPORTED_PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:'])

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
