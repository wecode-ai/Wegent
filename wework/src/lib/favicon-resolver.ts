import { getToken } from '@/api/auth'
import { createHttpClient, type HttpClient } from '@/api/http'
import { getRuntimeConfig } from '@/config/runtime'

export const GENERIC_LINK_ICON_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'/%3E%3Cpath d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'/%3E%3C/svg%3E"

let client: HttpClient | null = null

function getClient(): HttpClient {
  if (!client) {
    client = createHttpClient({
      baseUrl: getRuntimeConfig().apiBaseUrl,
      getToken,
      redirectOnUnauthorized: false,
    })
  }
  return client
}

interface UrlMetadataResult {
  url: string
  title?: string | null
  description?: string | null
  favicon?: string | null
  success: boolean
}

const faviconByDomain = new Map<string, string | undefined>()
const pendingByDomain = new Map<string, Promise<string | undefined>>()

/**
 * Best-effort favicon lookup for a URL. Returns the site's real favicon when
 * the backend resolves it, otherwise undefined so callers keep the
 * `/favicon.ico` placeholder.
 */
export function resolveFavicon(url: string): Promise<string | undefined> {
  let domain: string
  try {
    domain = new URL(url).hostname
  } catch {
    return Promise.resolve(undefined)
  }
  if (faviconByDomain.has(domain)) {
    return Promise.resolve(faviconByDomain.get(domain))
  }
  const pending = pendingByDomain.get(domain)
  if (pending) return pending

  const request = getClient()
    .get<UrlMetadataResult>(`/utils/url-metadata?url=${encodeURIComponent(url)}`)
    .then(result => {
      const favicon = result.favicon || undefined
      faviconByDomain.set(domain, favicon)
      return favicon
    })
    .catch(() => {
      faviconByDomain.set(domain, undefined)
      return undefined
    })
    .finally(() => {
      pendingByDomain.delete(domain)
    })
  pendingByDomain.set(domain, request)
  return request
}
