import type {
  InstalledPlugin,
  InstalledPluginListResponse,
  InstalledPluginUpdateRequest,
} from '@/types/api'
import type { HttpClient } from './http'

export function createPluginApi(client: HttpClient) {
  return {
    listInstalledPlugins(): Promise<InstalledPluginListResponse> {
      return client.get('/plugins/installed')
    },
    updateInstalledPlugin(
      id: number,
      data: InstalledPluginUpdateRequest,
    ): Promise<InstalledPlugin> {
      return client.put(`/plugins/installed/${id}`, data)
    },
    uninstallInstalledPlugin(id: number): Promise<void> {
      return client.delete(`/plugins/installed/${id}`)
    },
    uploadPlugin(file: File, enabled = true): Promise<InstalledPlugin> {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('enabled', String(enabled))
      return client.post('/plugins/upload', formData)
    },
  }
}
