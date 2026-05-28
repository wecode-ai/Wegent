import type { DeviceCommandResponse } from '@/types/api'
import type {
  CloudDeviceResponse,
  DeviceInfo,
  DeviceListResponse,
  DeviceSessionResponse,
} from '@/types/devices'
import type { HttpClient } from './http'

export function createDeviceApi(client: HttpClient) {
  async function fetchDevices(): Promise<DeviceInfo[]> {
    const response = await client.get<DeviceListResponse>('/devices')
    return response.items
  }

  return {
    listDevices: fetchDevices,

    getAllDevices: fetchDevices,

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

    async startTerminal(deviceId: string): Promise<DeviceSessionResponse> {
      return client.post<DeviceSessionResponse>(
        `/devices/${encodeURIComponent(deviceId)}/terminal`,
      )
    },

    async startCodeServer(deviceId: string): Promise<DeviceSessionResponse> {
      return client.post<DeviceSessionResponse>(
        `/devices/${encodeURIComponent(deviceId)}/code-server`,
      )
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
      await client.put<{ message: string }>(
        `/devices/${encodeURIComponent(deviceId)}/alias`,
        { alias },
      )
    },
  }
}
