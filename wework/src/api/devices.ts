import type { DeviceInfo } from '@/types/api'
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
  }
}
