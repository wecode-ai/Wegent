import { ApiError, createHttpClient } from './http'

export type SiteNetwork = 'inner' | 'outer'

export interface SiteProject {
  id: string
  network: SiteNetwork
  title: string
  url: string
  snapshot: string
  created_at: string
}

export interface SiteListResponse {
  items: SiteProject[]
  next_cursor: string | null
}

export interface ListSitesInput {
  q?: string
  cursor?: string | null
  limit: number
}

export interface SitesApi {
  listSites(input: ListSitesInput): Promise<SiteListResponse>
  publishSite(projectId: string): Promise<SiteProject>
  renameSite(projectId: string, title: string): Promise<SiteProject>
  deleteSite(projectId: string): Promise<void>
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
      if (input.cursor) {
        params.set('cursor', input.cursor)
      }
      params.set('limit', String(input.limit))

      return client.get(`/v1/sites?${params.toString()}`)
    },
    publishSite(projectId) {
      return client.post(`/v1/sites/${encodeURIComponent(projectId)}/publish`)
    },
    renameSite(projectId, title) {
      return client.post(`/v1/sites/${encodeURIComponent(projectId)}/rename`, { title })
    },
    deleteSite(projectId) {
      return client.delete<void>(`/v1/sites/${encodeURIComponent(projectId)}`)
    },
  }
}

export function createUnavailableSitesApi(): SitesApi {
  const unavailable = () =>
    Promise.reject(new ApiError('Sites is not available yet', 503, 'sites_not_available'))

  return {
    listSites: unavailable,
    publishSite: unavailable,
    renameSite: unavailable,
    deleteSite: unavailable,
  }
}

export function isSitesUnavailableError(error: unknown): boolean {
  return error instanceof ApiError && error.errorCode === 'sites_not_available'
}
