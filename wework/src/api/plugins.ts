import type {
  InstalledPlugin,
  InstalledPluginListResponse,
  InstalledPluginUpdateRequest,
} from '@/types/api'
import { getRuntimeConfig } from '@/config/runtime'
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
    uploadPlugin(file: File): Promise<InstalledPlugin> {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('enabled', 'true')

      const { apiBaseUrl } = getRuntimeConfig()

      return fetch(`${apiBaseUrl}/plugins/upload`, {
        method: 'POST',
        headers: {
          ...(localStorage.getItem('auth_token')
            ? { Authorization: `Bearer ${localStorage.getItem('auth_token')}` }
            : {}),
        },
        body: formData,
      }).then(async (response) => {
        if (!response.ok) {
          throw new Error((await response.text()) || `HTTP ${response.status}`)
        }
        return response.json() as Promise<InstalledPlugin>
      })
    },
  }
}
