import type { DeviceCommandResponse } from '@/types/api'
import type {
  CloudDeviceResponse,
  CloudDeviceMetricsResponse,
  DeviceInfo,
  DeviceListResponse,
  DeviceSessionResponse,
  MetricsHistoryResponse,
  VncConfigResponse,
} from '@/types/devices'
import type { HttpClient } from './http'

function getCommandText(response: DeviceCommandResponse): string {
  const output = Array.isArray(response.stdout) ? response.stdout.join('\n') : response.stdout
  return output.trim()
}

export function createDeviceApi(client: HttpClient) {
  async function fetchDevices(): Promise<DeviceInfo[]> {
    const response = await client.get<DeviceListResponse>('/devices')
    return response.items
  }

  return {
    listDevices: fetchDevices,

    getAllDevices: fetchDevices,

    async getHomeDirectory(deviceId: string): Promise<string> {
      const response = await client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        {
          command_key: 'home_dir',
          timeout_seconds: 10,
          max_output_bytes: 4096,
        },
      )
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to resolve home directory')
      }
      return getCommandText(response)
    },
    async getProjectWorkspaceRoot(deviceId: string): Promise<string> {
      const response = await client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        {
          command_key: 'project_workspace_root',
          timeout_seconds: 10,
          max_output_bytes: 4096,
        },
      )
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to resolve project directory')
      }
      return getCommandText(response)
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

    executeCommand(
      deviceId: string,
      data: {
        command_key: string
        path?: string
        cwd?: string
        args?: string[]
        env?: Record<string, unknown>
        timeout_seconds?: number
        max_output_bytes?: number
      },
    ): Promise<DeviceCommandResponse> {
      return client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        data,
      )
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

    getMetrics(deviceId: string): Promise<CloudDeviceMetricsResponse> {
      return client.post<CloudDeviceMetricsResponse>(
        `/cloud-devices/${encodeURIComponent(deviceId)}/metrics`,
      )
    },

    getMetricsHistory(deviceId: string): Promise<MetricsHistoryResponse> {
      return client.post<MetricsHistoryResponse>(
        `/cloud-devices/${encodeURIComponent(deviceId)}/metrics/history`,
      )
    },

    getVncConfig(deviceId: string): Promise<VncConfigResponse> {
      return client.get<VncConfigResponse>(
        `/cloud-devices/${encodeURIComponent(deviceId)}/vnc-config`,
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
