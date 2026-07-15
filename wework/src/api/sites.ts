import { createHttpClient } from './http'

export type SitePublishStatus = 'unpublished' | 'publishing' | 'published' | 'failed'

export interface Site {
  siteid: string
  name: string
  slug?: string
  internal_url: string
  external_url: string | null
  publish_status: SitePublishStatus
  last_publish_error?: string | null
  thumbnail_url?: string | null
  created_at?: string
  updated_at?: string
}

export interface SiteListResponse {
  items: Site[]
  total: number
  offset: number
  limit: number
}

export interface ListSitesInput {
  username: string
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
    getToken: () => null,
    redirectOnUnauthorized: false,
  })

  return {
    listSites(input) {
      const username = input.username.trim()
      if (!username) {
        return Promise.reject(new Error('username is required'))
      }

      const params = new URLSearchParams({ username })
      const query = input.q?.trim()
      if (query) {
        params.set('q', query)
      }
      params.set('offset', String(input.offset))
      params.set('limit', String(input.limit))

      return client.get(`/api/v1/sites?${params.toString()}`)
    },
    publishSite(siteid) {
      return client.post(`/api/v1/sites/${encodeURIComponent(siteid)}/publish`)
    },
    deleteSite(siteid) {
      return client.delete<void>(`/api/v1/sites/${encodeURIComponent(siteid)}`)
    },
  }
}
