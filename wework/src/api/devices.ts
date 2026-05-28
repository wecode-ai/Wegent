import type { DeviceCommandResponse, DeviceInfo } from '@/types/api'
import type { HttpClient } from './http'

interface DeviceListResponse {
  items: DeviceInfo[]
  total: number
}

export function createDeviceApi(client: HttpClient) {
  return {
    async listDevices(): Promise<DeviceInfo[]> {
      const response = await client.get<DeviceListResponse>('/devices')
      return response.items
    },
    async listDirectories(deviceId: string, path: string): Promise<string[]> {
      const response = await client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        {
          command_key: 'ls_dirs',
          path,
          timeout_seconds: 15,
          max_output_bytes: 1024 * 64,
        },
      )
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to list directories')
      }
      return Array.isArray(response.stdout) ? response.stdout : []
    },
  }
}
