import type { HttpClient } from './http'
import type { PluginShareGroupSearchItem, PluginShareUserSearchItem } from './plugins'

export interface SmartAppMarketplaceTag {
  id: string
  name_zh: string
  name_en: string
  sort: number
  enabled: boolean
}

export interface SmartAppAccessTarget {
  entityType: 'user' | 'namespace'
  entityId: string
  displayName: string
}

export interface SmartAppMarketplaceItem {
  id: number
  name: string
  displayName: string
  summary: string
  descriptionMd: string
  sourceType: 'official' | 'user'
  ownerUserId: number
  ownerDisplayName: string
  accessRole: 'official' | 'owner' | 'recipient'
  tags: string[]
  iconUrl: string
  screenshotUrls: string[]
  featured: boolean
  latestReleaseId: number
  version: string
  releaseNotes: string
  sizeBytes: number
  requirements: Record<string, unknown>
  extensions: Record<string, unknown>
  releaseExtensions: Record<string, unknown>
  scanStatus: 'passed' | 'failed'
  updatedAt: string
  publishedAt: string
}

export interface SmartAppDownloadDescriptor {
  smartAppId: number
  releaseId: number
  version: string
  filename: string
  downloadUrl: string
  sha256: string
  sizeBytes: number
  expiresAt: string
}

export interface SmartAppAccess {
  smartAppId: number
  scope: 'private' | 'restricted'
  targets: SmartAppAccessTarget[]
}

export interface SmartAppSubmissionMetadata {
  smartAppId?: number
  name: string
  displayName: string
  version: string
  summary: string
  descriptionMd: string
  tags: string[]
  iconDataUrl: string
  screenshotDataUrls: string[]
  releaseNotes: string
  extensions?: Record<string, unknown>
  releaseExtensions?: Record<string, unknown>
  targets: SmartAppAccessTarget[]
}

interface SmartAppSubmissionInitResponse {
  submissionId: number
  smartAppId: number
  uploadUrl: string
  expiresAt: string
}

export interface SmartAppPreparedPackage {
  filename: string
  sha256: string
  sizeBytes: number
}

export interface SmartAppSubmissionCompleteResponse {
  submission: {
    id: number
    smartAppId: number
    version: string
    status: 'uploading' | 'scanning' | 'published' | 'rejected' | 'cancelled'
    error: string
    createdAt: string
  }
  item: SmartAppMarketplaceItem | null
}

export function createSmartAppsApi(client: HttpClient) {
  const initSubmission = (
    packageInfo: SmartAppPreparedPackage,
    metadata: SmartAppSubmissionMetadata
  ) =>
    client.post<SmartAppSubmissionInitResponse>('/smart-apps/submissions/init', {
      ...metadata,
      ...packageInfo,
    })
  const completeSubmission = (id: number) =>
    client.post<SmartAppSubmissionCompleteResponse>(`/smart-apps/submissions/${id}/complete`)
  const cancelSubmission = (id: number) => client.post(`/smart-apps/submissions/${id}/cancel`)

  return {
    listMarketplace(params: { q?: string; source?: string; tag?: string } = {}) {
      const query = new URLSearchParams()
      if (params.q?.trim()) query.set('q', params.q.trim())
      if (params.source) query.set('source', params.source)
      if (params.tag) query.set('tag', params.tag)
      const queryString = query.toString()
      const suffix = queryString ? `?${queryString}` : ''
      return client.get<{ items: SmartAppMarketplaceItem[] }>(`/smart-apps/marketplace${suffix}`)
    },
    listOwned() {
      return client.get<{ items: SmartAppMarketplaceItem[] }>('/smart-apps/owned')
    },
    listTags() {
      return client.get<{ version: number; items: SmartAppMarketplaceTag[] }>(
        '/resource-library/tags'
      )
    },
    async searchUsers(query: string) {
      const response = await client.get<{ users: PluginShareUserSearchItem[] }>(
        `/users/search?q=${encodeURIComponent(query)}&limit=20`
      )
      return response.users
    },
    async searchGroups(query: string) {
      const response = await client.get<{ items: PluginShareGroupSearchItem[] }>(
        `/groups/search?q=${encodeURIComponent(query)}&limit=20`
      )
      return response.items
    },
    getItem(id: number) {
      return client.get<SmartAppMarketplaceItem>(`/smart-apps/marketplace/${id}`)
    },
    getDownload(id: number) {
      return client.post<SmartAppDownloadDescriptor>(`/smart-apps/marketplace/${id}/download`)
    },
    getAccess(id: number) {
      return client.get<SmartAppAccess>(`/smart-apps/${id}/access`)
    },
    updateAccess(id: number, access: Omit<SmartAppAccess, 'smartAppId'>) {
      return client.put<SmartAppAccess>(`/smart-apps/${id}/access`, access)
    },
    initSubmission,
    completeSubmission,
    cancelSubmission,
    async publish(file: File, metadata: SmartAppSubmissionMetadata) {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      const sha256 = Array.from(new Uint8Array(digest), byte =>
        byte.toString(16).padStart(2, '0')
      ).join('')
      const initialized = await initSubmission(
        { filename: file.name, sha256, sizeBytes: file.size },
        metadata
      )
      try {
        const transport = globalThis.fetch.bind(globalThis)
        const upload = await transport(initialized.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/zip' },
          body: file,
        })
        if (!upload.ok) throw new Error(`Smart app upload failed with HTTP ${upload.status}`)
        return await completeSubmission(initialized.submissionId)
      } catch (error) {
        await cancelSubmission(initialized.submissionId).catch(() => undefined)
        throw error
      }
    },
  }
}

export type SmartAppsApi = ReturnType<typeof createSmartAppsApi>
