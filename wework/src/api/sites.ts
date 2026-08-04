import { ApiError, createHttpClient } from './http'

export type SitePublishStatus = 'unpublished' | 'publishing' | 'published' | 'failed'
export type SiteAppType = 'site' | 'mini_program'
export type ApplicationCapability = 'create' | 'publish' | 'delete' | 'open_experience'

export interface Site {
  app_type: 'site'
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

export interface MiniProgram {
  app_type: 'mini_program'
  siteid: string
  taskid: string
  username: string
  name: string
  slug: string
  app_id: string
  status: string
  version?: string | null
  experience_url?: string | null
  thumbnail_url?: string | null
  created_at: string
  updated_at: string
}

export type SiteListItem = Site | MiniProgram

export interface SiteListResponse {
  items: SiteListItem[]
  total: number
  offset: number
  limit: number
}

export interface ApplicationTypeDescriptor {
  app_type: string
  enabled: boolean
  order: number
  capabilities: ApplicationCapability[]
}

export interface ApplicationTypeListResponse {
  items: ApplicationTypeDescriptor[]
}

export interface ListSitesInput {
  appType: SiteAppType
  q?: string
  offset: number
  limit: number
}

export interface SitesApi {
  listApplicationTypes(): Promise<ApplicationTypeListResponse>
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
    listApplicationTypes() {
      return client.get('/sites/app-types')
    },
    listSites(input) {
      const params = new URLSearchParams()
      const query = input.q?.trim()
      if (query) {
        params.set('q', query)
      }
      params.set('app_type', input.appType)
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
    listApplicationTypes: unavailable,
    listSites: unavailable,
    publishSite: unavailable,
    deleteSite: unavailable,
  }
}

export function isSitesUnavailableError(error: unknown): boolean {
  return error instanceof ApiError && error.errorCode === 'sites_not_available'
}
