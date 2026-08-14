import { getToken } from '@/api/auth'
import { createHttpClient } from '@/api/http'
import { getRuntimeConfig } from '@/config/runtime'
import { normalizeHostname } from './link-preview'

export const GENERIC_LINK_ICON_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'/%3E%3Cpath d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'/%3E%3C/svg%3E"

const SUCCESS_TTL_MS = 60 * 60 * 1000
const NO_FAVICON_TTL_MS = 60 * 60 * 1000
const FAILURE_TTL_MS = 5 * 60 * 1000

interface FaviconCacheEntry {
  favicon: string | undefined
  expiresAt: number
}

interface UrlMetadataResult {
  url: string
  title?: string | null
  description?: string | null
  favicon?: string | null
  success: boolean
}

const faviconCache = new Map<string, FaviconCacheEntry>()
const pendingByDomain = new Map<string, Promise<string | undefined>>()

/**
 * Best-effort favicon lookup for a URL. Returns the site's real favicon when
 * the backend resolves it, otherwise undefined so callers keep the
 * `/favicon.ico` placeholder. Successful and "no favicon" results are cached
 * for an hour; failures only briefly, so a transient backend blip does not
 * disable favicons for the whole session.
 */
export function resolveFavicon(url: string): Promise<string | undefined> {
  let domain: string | undefined
  try {
    domain = normalizeHostname(new URL(url).hostname)
  } catch {
    return Promise.resolve(undefined)
  }
  if (!domain) return Promise.resolve(undefined)

  const cached = faviconCache.get(domain)
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.favicon)
  }
  const pending = pendingByDomain.get(domain)
  if (pending) return pending

  const request = createHttpClient({
    baseUrl: getRuntimeConfig().apiBaseUrl,
    getToken,
    redirectOnUnauthorized: false,
  })
    .get<UrlMetadataResult>(`/utils/url-metadata?url=${encodeURIComponent(url)}`)
    .then(result => {
      const favicon = result.favicon || undefined
      const ttl = result.success ? (favicon ? SUCCESS_TTL_MS : NO_FAVICON_TTL_MS) : FAILURE_TTL_MS
      faviconCache.set(domain, { favicon, expiresAt: Date.now() + ttl })
      return favicon
    })
    .catch(() => {
      faviconCache.set(domain, { favicon: undefined, expiresAt: Date.now() + FAILURE_TTL_MS })
      return undefined
    })
    .finally(() => {
      pendingByDomain.delete(domain)
    })
  pendingByDomain.set(domain, request)
  return request
}
