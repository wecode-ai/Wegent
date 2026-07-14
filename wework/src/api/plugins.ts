import type {
  InstalledPlugin,
  InstalledPluginListResponse,
  InstalledPluginUpdateRequest,
  PluginMarketplaceInstallResponse,
  PluginMarketplaceListResponse,
  PluginMarketplacePublishResponse,
} from '@/types/api'
import type { HttpClient } from './http'

export function createPluginApi(client: HttpClient) {
  return {
    listInstalledPlugins(): Promise<InstalledPluginListResponse> {
      return client.get('/plugins/installed')
    },
    updateInstalledPlugin(
      id: string | number,
      data: InstalledPluginUpdateRequest
    ): Promise<InstalledPlugin> {
      return client.put(`/plugins/installed/${id}`, data)
    },
    uninstallInstalledPlugin(id: string | number): Promise<void> {
      return client.delete(`/plugins/installed/${id}`)
    },
    uploadPlugin(file: File, enabled = true): Promise<InstalledPlugin> {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('enabled', String(enabled))
      return client.post('/plugins/upload', formData)
    },
    listMarketplacePlugins(
      params: { q?: string; source?: string } = {}
    ): Promise<PluginMarketplaceListResponse> {
      const query = new URLSearchParams()
      if (params.q?.trim()) query.set('q', params.q.trim())
      if (params.source) query.set('source', params.source)
      const suffix = query.toString() ? `?${query.toString()}` : ''
      return client.get(`/plugins/marketplace${suffix}`)
    },
    installMarketplacePlugin(id: string | number): Promise<PluginMarketplaceInstallResponse> {
      return client.post(`/plugins/marketplace/${id}/install`)
    },
    publishMarketplacePlugin(
      file: File,
      visibility: 'personal' | 'workspace' | 'public' = 'workspace',
      featured = false
    ): Promise<PluginMarketplacePublishResponse> {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('visibility', visibility)
      formData.append('featured', String(featured))
      return client.post('/plugins/marketplace/publish', formData)
    },
  }
}
