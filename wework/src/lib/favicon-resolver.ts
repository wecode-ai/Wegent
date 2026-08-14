import { getToken } from '@/api/auth'
import { createHttpClient } from '@/api/http'
import { getRuntimeConfig } from '@/config/runtime'
import { normalizeHostname } from './link-preview'

export const GENERIC_LINK_ICON_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'/%3E%3Cpath d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'/%3E%3C/svg%3E"

const SUCCESS_TTL_MS = 60 * 60 * 1000
const NO_FAVICON_TTL_MS = 60 * 60 * 1000
const FAILED_RESOLUTION_TTL_MS = 30 * 60 * 1000

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
 * the backend resolves it, otherwise undefined so callers keep the generic
 * link icon. Successful and "no favicon" results are cached for an hour, and
 * a reachable backend's failed resolutions for 30 minutes; network failures
 * are NOT cached, so favicons recover as soon as the backend is reachable
 * again instead of being disabled for the whole session.
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
      const ttl = result.success
        ? favicon
          ? SUCCESS_TTL_MS
          : NO_FAVICON_TTL_MS
        : FAILED_RESOLUTION_TTL_MS
      faviconCache.set(domain, { favicon, expiresAt: Date.now() + ttl })
      return favicon
    })
    .catch(() => undefined)
    .finally(() => {
      pendingByDomain.delete(domain)
    })
  pendingByDomain.set(domain, request)
  return request
}

/**
 * The site's conventional `/favicon.ico` URL, derived from the URL's own
 * scheme, host and port. It loads directly from the site without the backend,
 * so it can show a site-specific icon even when the backend is unreachable.
 */
export function faviconPlaceholderUrl(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const domain = normalizeHostname(parsed.hostname)
  if (!domain) return undefined
  const port = parsed.port ? `:${parsed.port}` : ''
  return `${parsed.protocol}//${domain}${port}/favicon.ico`
}

/**
 * Probes the offline `/favicon.ico` placeholder and the backend-resolved
 * favicon, showing each only once it has actually loaded so the generic icon
 * stays as the instant base (no blank flash). The backend favicon, once
 * loaded, wins over the placeholder. `faviconPromise` is passed in so callers
 * can provide a mocked resolution in tests.
 */
export function resolveAndProbeIcon(
  placeholder: string | undefined,
  faviconPromise: Promise<string | undefined>,
  show: (iconUrl: string) => void,
  isDisposed: () => boolean
): void {
  let backendIconShown = false
  const probe = (candidate: string, onLoad: () => void): void => {
    const image = new Image()
    image.onload = onLoad
    image.src = candidate
  }
  if (placeholder) {
    probe(placeholder, () => {
      if (!isDisposed() && !backendIconShown) show(placeholder)
    })
  }
  void faviconPromise.then(favicon => {
    if (!favicon || isDisposed()) return
    probe(favicon, () => {
      if (isDisposed()) return
      backendIconShown = true
      show(favicon)
    })
  })
}
