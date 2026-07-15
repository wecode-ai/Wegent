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

export function createSitesApi(baseUrl: string): SitesApi {
  const client = createHttpClient({
    baseUrl: baseUrl.replace(/\/+$/, ''),
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

      return client.get(`/v1/sites?${params.toString()}`)
    },
    publishSite(siteid) {
      return client.post(`/v1/sites/${encodeURIComponent(siteid)}/publish`)
    },
    deleteSite(siteid) {
      return client.delete<void>(`/v1/sites/${encodeURIComponent(siteid)}`)
    },
  }
}

export function isSitesUnavailableError(error: unknown): boolean {
  return error instanceof ApiError && error.errorCode === 'sites_not_available'
}
