import type {
  InstalledPlugin,
  InstalledPluginListResponse,
  InstalledPluginUpdateRequest,
  PluginAccessResponse,
  PluginAccessUpdateRequest,
  PluginCopyResponse,
  PluginMarketplaceInstallResponse,
  PluginMarketplaceCapabilities,
  PluginMarketplaceListResponse,
  PluginSubmissionCompleteResponse,
  PluginSubmissionInitRequest,
  PluginSubmissionInitResponse,
  PluginSubmissionItem,
} from '@/types/api'
import type { HttpClient } from './http'
import { shouldUseTauriFetch } from './http'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

export interface PluginShareUserSearchItem {
  id: number
  user_name: string
  email?: string | null
}

export interface PluginShareGroupSearchItem {
  id: number
  name: string
  display_name?: string | null
}

export function createPluginApi(client: HttpClient) {
  const deviceQuery = (deviceId?: string) => {
    const normalized = deviceId?.trim()
    return normalized ? `?device_id=${encodeURIComponent(normalized)}` : ''
  }

  return {
    getCapabilities(): Promise<PluginMarketplaceCapabilities> {
      return client.get('/plugins/capabilities')
    },
    listInstalledPlugins(deviceId?: string): Promise<InstalledPluginListResponse> {
      return client.get(`/plugins/installed${deviceQuery(deviceId)}`)
    },
    updateInstalledPlugin(
      id: string | number,
      data: InstalledPluginUpdateRequest,
      deviceId?: string
    ): Promise<InstalledPlugin> {
      return client.put(`/plugins/installed/${id}${deviceQuery(deviceId)}`, data)
    },
    uninstallInstalledPlugin(id: string | number, deviceId?: string): Promise<void> {
      return client.delete(`/plugins/installed/${id}${deviceQuery(deviceId)}`)
    },
    uploadPlugin(file: File, enabled = true): Promise<InstalledPlugin> {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('enabled', String(enabled))
      return client.post('/plugins/upload', formData)
    },
    listMarketplacePlugins(
      params: { q?: string; source?: string; deviceId?: string } = {}
    ): Promise<PluginMarketplaceListResponse> {
      const query = new URLSearchParams()
      if (params.q?.trim()) query.set('q', params.q.trim())
      if (params.source) query.set('source', params.source)
      if (params.deviceId?.trim()) query.set('device_id', params.deviceId.trim())
      const suffix = query.toString() ? `?${query.toString()}` : ''
      return client.get(`/plugins/marketplace${suffix}`)
    },
    installMarketplacePlugin(
      id: string | number,
      deviceId?: string
    ): Promise<PluginMarketplaceInstallResponse> {
      return client.post(`/plugins/marketplace/${id}/install${deviceQuery(deviceId)}`)
    },
    updateMarketplacePlugin(
      installedId: string | number,
      releaseId: number,
      deviceId?: string
    ): Promise<InstalledPlugin> {
      return client.put(`/plugins/installed/${installedId}${deviceQuery(deviceId)}`, { releaseId })
    },
    getMarketplacePluginAccess(id: string | number): Promise<PluginAccessResponse> {
      return client.get(`/plugins/marketplace/${id}/access`)
    },
    updateMarketplacePluginAccess(
      id: string | number,
      data: PluginAccessUpdateRequest
    ): Promise<PluginAccessResponse> {
      return client.put(`/plugins/marketplace/${id}/access`, data)
    },
    copyMarketplacePlugin(id: string | number): Promise<PluginCopyResponse> {
      return client.post(`/plugins/marketplace/${id}/copy`)
    },
    searchPluginShareUsers(
      query: string
    ): Promise<{ users: PluginShareUserSearchItem[]; total: number }> {
      return client.get(`/users/search?q=${encodeURIComponent(query)}&limit=20`)
    },
    searchPluginShareGroups(
      query: string
    ): Promise<{ items: PluginShareGroupSearchItem[]; total: number }> {
      return client.get(`/groups/search?q=${encodeURIComponent(query)}&limit=20`)
    },
    initSubmission(data: PluginSubmissionInitRequest): Promise<PluginSubmissionInitResponse> {
      return client.post('/plugins/submissions/init', data)
    },
    completeSubmission(id: number): Promise<PluginSubmissionCompleteResponse> {
      return client.post(`/plugins/submissions/${id}/complete`)
    },
    getSubmission(id: number): Promise<PluginSubmissionItem> {
      return client.get(`/plugins/submissions/${id}`)
    },
    ensureBuiltinPluginInstalled(
      pluginKey: string,
      options: { deviceId?: string } = {}
    ): Promise<PluginMarketplaceInstallResponse> {
      return client.post(`/plugins/builtin/${encodeURIComponent(pluginKey)}/ensure-installed`, {
        ...(options.deviceId ? { device_id: options.deviceId } : {}),
      })
    },
    async publishSubmission(
      file: File,
      metadata: Pick<
        PluginSubmissionInitRequest,
        | 'slug'
        | 'displayName'
        | 'version'
        | 'listingType'
        | 'purpose'
        | 'visibility'
        | 'targets'
        | 'allowCopy'
      >
    ): Promise<PluginSubmissionCompleteResponse> {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      const sha256 = Array.from(new Uint8Array(digest), byte =>
        byte.toString(16).padStart(2, '0')
      ).join('')
      const initialized = await client.post<PluginSubmissionInitResponse>(
        '/plugins/submissions/init',
        {
          ...metadata,
          filename: file.name,
          sha256,
          sizeBytes: file.size,
        }
      )
      const uploadTransport = shouldUseTauriFetch() ? tauriFetch : globalThis.fetch.bind(globalThis)
      const upload = await uploadTransport(initialized.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      })
      if (!upload.ok) throw new Error(`Plugin upload failed with HTTP ${upload.status}`)
      const completed = await client.post<PluginSubmissionCompleteResponse>(
        `/plugins/submissions/${initialized.submissionId}/complete`
      )
      return completed
    },
  }
}
