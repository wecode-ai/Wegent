import {
  LOCAL_PROXY_SETTINGS_STORAGE_KEY,
  storedLocalProxyConfig,
  normalizeLocalProxyUrl,
  type LocalProxyMode,
} from '../../../electron/src/shared/local-proxy-config'

export type { LocalProxyMode }
export { normalizeLocalProxyUrl }

export interface LocalProxyConfig {
  mode: LocalProxyMode
  proxyUrl: string
  proxyUrlMasked: string
  updatedAt: string | null
}

interface StoredLocalProxyConfig {
  mode?: LocalProxyMode
  proxyUrl?: string
  updatedAt?: string
}

export const LOCAL_PROXY_SETTINGS_CHANGED_EVENT = 'wework:local-proxy-settings-changed'

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

export function getLocalProxyConfig(): LocalProxyConfig {
  const stored = readStoredLocalProxyConfig()
  const { mode, proxyUrl, updatedAt } = storedLocalProxyConfig(stored)
  return {
    mode,
    proxyUrl: mode === 'custom' ? proxyUrl : '',
    proxyUrlMasked: mode === 'custom' ? maskLocalProxyUrl(proxyUrl) : '',
    updatedAt,
  }
}

export function saveLocalProxyConfig(mode: LocalProxyMode, proxyUrl = ''): LocalProxyConfig {
  const normalizedProxyUrl = mode === 'custom' ? normalizeLocalProxyUrl(proxyUrl) : ''
  if (mode === 'custom' && !normalizedProxyUrl) {
    throw new Error('proxy_url is required for custom proxy mode')
  }
  const updatedAt = new Date().toISOString()

  globalThis.localStorage?.setItem(
    LOCAL_PROXY_SETTINGS_STORAGE_KEY,
    JSON.stringify({
      mode,
      proxyUrl: normalizedProxyUrl || undefined,
      updatedAt,
    })
  )

  globalThis.dispatchEvent?.(new Event(LOCAL_PROXY_SETTINGS_CHANGED_EVENT))
  return getLocalProxyConfig()
}

export function saveLocalProxyUrl(proxyUrl: string): LocalProxyConfig {
  return proxyUrl.trim() ? saveLocalProxyConfig('custom', proxyUrl) : saveLocalProxyConfig('system')
}
