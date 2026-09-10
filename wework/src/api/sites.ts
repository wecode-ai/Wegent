import { ApiError, createHttpClient } from './http'

export type SitePublishStatus = 'unpublished' | 'publishing' | 'published' | 'failed' | 'scanning'
export type SiteAppType = 'web' | 'miniapp'
export type SiteNetwork = 'inner' | 'outer'
export type SiteAccessRole = 'owner' | 'collaborator'
export type SiteAccessAudience = 'all' | 'login' | 'owner' | 'custom'
export type ApplicationCapability =
  | 'create'
  | 'publish'
  | 'edit'
  | 'delete'
  | 'open_experience'
  | 'configure_environment'
  | 'manage_access'
export type EnvironmentVariableType = 'plain' | 'secret'

export interface PlainEnvironmentVariable {
  key: string
  type: 'plain'
  value: string
  updated_by: string
  updated_at: string
}

export interface SecretEnvironmentVariable {
  key: string
  type: 'secret'
  configured: true
  updated_by: string
  updated_at: string
}

export type EnvironmentVariable = PlainEnvironmentVariable | SecretEnvironmentVariable

export interface EnvironmentSnapshot {
  revision_id: string | null
  project_id: string
  revision_number: number
  items: EnvironmentVariable[]
}

export interface EnvironmentRevision {
  id: string
  project_id: string
  revision_number: number
  variables: EnvironmentVariable[]
  created_by: string
  created_at: string
}

export type EnvironmentPatchOperation =
  | { op: 'upsert'; key: string; type: EnvironmentVariableType; value: string }
  | { op: 'remove'; key: string }

export interface PatchEnvironmentVariablesInput {
  expected_revision_id: string | null
  operations: EnvironmentPatchOperation[]
}

export interface Site {
  app_type: 'web'
  siteid: string
  project_id?: string | null
  taskid: string
  username: string
  owner_username: string
  access_role: SiteAccessRole
  name: string
  slug: string
  custom_domain_prefix?: string | null
  network?: SiteNetwork
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
  app_type: 'miniapp'
  siteid: string
  project_id?: string | null
  taskid: string
  username: string
  owner_username: string
  access_role: SiteAccessRole
  name: string
  slug: string
  app_id?: string | null
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
  create?: ApplicationCreatePluginDescriptor | null
}

export interface ApplicationCreatePluginDescriptor {
  plugin_name: string
  marketplace_name: string
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

export interface UpdateSiteInput {
  title?: string
  customDomainPrefix?: string | null
}

export interface SiteCollaborator {
  subject: string
  added_by: string
  created_at: string
}

export interface SiteAccessPolicy {
  id: string
  project_id: string
  target: 'inner'
  audience: SiteAccessAudience
  subjects: string[]
  revision_number: number
  created_by: string
  created_at: string
}

export interface UpdateSiteAccessInput {
  audience: SiteAccessAudience
  subjects: string[]
}

export interface SitesApi {
  listApplicationTypes(): Promise<ApplicationTypeListResponse>
  listSites(input: ListSitesInput): Promise<SiteListResponse>
  publishSite(siteid: string): Promise<Site>
  updateSiteNetwork(siteid: string, network: SiteNetwork): Promise<Site>
  updateSite(siteid: string, input: UpdateSiteInput): Promise<Site>
  deleteSite(siteid: string): Promise<void>
  getEnvironmentVariables(siteid: string): Promise<EnvironmentSnapshot>
  patchEnvironmentVariables(
    siteid: string,
    input: PatchEnvironmentVariablesInput,
    idempotencyKey: string
  ): Promise<EnvironmentRevision>
  listCollaborators(siteid: string): Promise<{ items: SiteCollaborator[] }>
  addCollaborator(
    siteid: string,
    subject: string,
    idempotencyKey: string
  ): Promise<SiteCollaborator>
  removeCollaborator(siteid: string, subject: string): Promise<void>
  getSiteAccess(siteid: string): Promise<SiteAccessPolicy>
  updateSiteAccess(
    siteid: string,
    input: UpdateSiteAccessInput,
    idempotencyKey: string
  ): Promise<SiteAccessPolicy>
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
    updateSiteNetwork(siteid, network) {
      return client.put(`/sites/${encodeURIComponent(siteid)}/network`, { network })
    },
    updateSite(siteid, input) {
      return client.patch(`/sites/${encodeURIComponent(siteid)}`, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.customDomainPrefix !== undefined
          ? { custom_domain_prefix: input.customDomainPrefix }
          : {}),
      })
    },
    deleteSite(siteid) {
      return client.delete<void>(`/sites/${encodeURIComponent(siteid)}`)
    },
    getEnvironmentVariables(siteid) {
      return client.get(`/sites/${encodeURIComponent(siteid)}/environment-variables`)
    },
    patchEnvironmentVariables(siteid, input, idempotencyKey) {
      return client.patch(`/sites/${encodeURIComponent(siteid)}/environment-variables`, input, {
        headers: { 'Idempotency-Key': idempotencyKey },
      })
    },
    listCollaborators(siteid) {
      return client.get(`/sites/${encodeURIComponent(siteid)}/collaborators`)
    },
    addCollaborator(siteid, subject, idempotencyKey) {
      return client.post(
        `/sites/${encodeURIComponent(siteid)}/collaborators`,
        { subject },
        {
          headers: { 'Idempotency-Key': idempotencyKey },
        }
      )
    },
    removeCollaborator(siteid, subject) {
      return client.delete<void>(
        `/sites/${encodeURIComponent(siteid)}/collaborators/${encodeURIComponent(subject)}`
      )
    },
    getSiteAccess(siteid) {
      return client.get(`/sites/${encodeURIComponent(siteid)}/access`)
    },
    updateSiteAccess(siteid, input, idempotencyKey) {
      return client.put(`/sites/${encodeURIComponent(siteid)}/access`, input, {
        headers: { 'Idempotency-Key': idempotencyKey },
      })
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
    updateSiteNetwork: unavailable,
    updateSite: unavailable,
    deleteSite: unavailable,
    getEnvironmentVariables: unavailable,
    patchEnvironmentVariables: unavailable,
    listCollaborators: unavailable,
    addCollaborator: unavailable,
    removeCollaborator: unavailable,
    getSiteAccess: unavailable,
    updateSiteAccess: unavailable,
  }
}

export function isSitesUnavailableError(error: unknown): boolean {
  return error instanceof ApiError && error.errorCode === 'sites_not_available'
}
