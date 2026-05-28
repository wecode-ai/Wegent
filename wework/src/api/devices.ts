import type {
  CloudDeviceResponse,
  DeviceInfo,
  DeviceListResponse,
  DeviceSessionResponse,
} from '@/types/devices'
import type { HttpClient } from './http'

export function createDeviceApi(client: HttpClient) {
  return {
    async getAllDevices(): Promise<DeviceInfo[]> {
      const resp = await client.get<DeviceListResponse>('/devices')
      return resp.items
    },

    async startTerminal(deviceId: string): Promise<DeviceSessionResponse> {
      return client.post<DeviceSessionResponse>(`/devices/${deviceId}/terminal`)
    },

    async startCodeServer(deviceId: string): Promise<DeviceSessionResponse> {
      return client.post<DeviceSessionResponse>(`/devices/${deviceId}/code-server`)
    },

    async createCloudDevice(): Promise<CloudDeviceResponse> {
      return client.post<CloudDeviceResponse>('/cloud-devices')
    },

    async restartCloudDevice(deviceId: string): Promise<{ message: string }> {
      return client.post<{ message: string }>(
        `/cloud-devices/${encodeURIComponent(deviceId)}/restart`,
      )
    },

    async deleteCloudDevice(deviceId: string): Promise<{ message: string }> {
      return client.delete<{ message: string }>(
        `/cloud-devices/${encodeURIComponent(deviceId)}`,
      )
    },

    async renameDevice(deviceId: string, alias: string): Promise<void> {
      await client.put<{ message: string }>(`/devices/${deviceId}/alias`, { alias })
    },
  }
}
