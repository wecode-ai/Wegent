import { ApiError, createHttpClient } from './http'

export type SitePublishStatus = 'unpublished' | 'publishing' | 'published' | 'failed'

export interface Site {
  siteid: string
  taskid: string
  username: string
  name: string
  slug: string
  internal_url: string
  external_url: string | null
  publish_status: SitePublishStatus
  last_publish_error?: string | null
  thumbnail_url?: string | null
  created_at: string
  updated_at: string
  published_at?: string | null
}

export interface SiteListResponse {
  items: Site[]
  total: number
  offset: number
  limit: number
}

export interface ListSitesInput {
  q?: string
  offset: number
  limit: number
}

export interface SitesApi {
  listSites(input: ListSitesInput): Promise<SiteListResponse>
  publishSite(siteid: string): Promise<Site>
  deleteSite(siteid: string): Promise<void>
}

interface SitesApiOptions {
  getToken?: () => string | null
  redirectOnUnauthorized?: boolean
}

export function createSitesApi(baseUrl: string, options: SitesApiOptions = {}): SitesApi {
  const client = createHttpClient({
    baseUrl: baseUrl.replace(/\/+$/, ''),
    getToken: options.getToken,
    redirectOnUnauthorized: options.redirectOnUnauthorized,
  })

  return {
    listSites(input) {
      const params = new URLSearchParams()
      const query = input.q?.trim()
      if (query) {
        params.set('q', query)
      }
      params.set('offset', String(input.offset))
      params.set('limit', String(input.limit))

      return client.get(`/sites?${params.toString()}`)
    },
    publishSite(siteid) {
      return client.post(`/sites/${encodeURIComponent(siteid)}/publish`)
    },
    deleteSite(siteid) {
      return client.delete<void>(`/sites/${encodeURIComponent(siteid)}`)
    },
  }
}

export function createUnavailableSitesApi(): SitesApi {
  const unavailable = () =>
    Promise.reject(new ApiError('Sites is not available yet', 503, 'sites_not_available'))

  return {
    listSites: unavailable,
    publishSite: unavailable,
    deleteSite: unavailable,
  }
}

export function isSitesUnavailableError(error: unknown): boolean {
  return error instanceof ApiError && error.errorCode === 'sites_not_available'
}
