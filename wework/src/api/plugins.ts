import type {
  InstalledPlugin,
  InstalledPluginListResponse,
  InstalledPluginUpdateRequest,
  PluginCatalogListResponse,
} from '@/types/api'
import type { HttpClient } from './http'

export function createPluginApi(client: HttpClient) {
  return {
    listInstalledPlugins(): Promise<InstalledPluginListResponse> {
      return client.get('/plugins/installed')
    },
    listPluginCatalog(): Promise<PluginCatalogListResponse> {
      return client.get('/plugins/catalog')
    },
    installSystemPlugin(id: number): Promise<InstalledPluginListResponse> {
      return client.post(`/plugins/catalog/${id}/install`)
    },
    updateSystemPlugin(id: number): Promise<InstalledPluginListResponse> {
      return client.post(`/plugins/catalog/${id}/update`)
    },
    updateInstalledPlugin(
      id: number,
      data: InstalledPluginUpdateRequest
    ): Promise<InstalledPlugin> {
      return client.put(`/plugins/installed/${id}`, data)
    },
    uninstallInstalledPlugin(id: number): Promise<void> {
      return client.delete(`/plugins/installed/${id}`)
    },
  }
}
