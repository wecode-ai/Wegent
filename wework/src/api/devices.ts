import type { DeviceCommandResponse, LocalDeviceSkill } from '@/types/api'
import type {
  CloudDeviceResponse,
  CloudDeviceMetricsResponse,
  DeviceInfo,
  DeviceListResponse,
  DeviceSessionResponse,
  MetricsHistoryResponse,
  UpgradeDeviceOptions,
  UpgradeDeviceResponse,
  VncConfigResponse,
} from '@/types/devices'
import type { HttpClient } from './http'

function getCommandText(response: DeviceCommandResponse): string {
  const output = Array.isArray(response.stdout) ? response.stdout.join('\n') : response.stdout
  return output.trim()
}

function getStringArrayOutput(response: DeviceCommandResponse): string[] {
  if (!Array.isArray(response.stdout)) return []
  return response.stdout.filter((item): item is string => typeof item === 'string')
}

function getSkillArrayOutput(response: DeviceCommandResponse): LocalDeviceSkill[] {
  const stdout =
    typeof response.stdout === 'string'
      ? parseJsonOutput(response.stdout)
      : response.stdout
  if (!Array.isArray(stdout)) return []
  const skills = stdout.filter(
    (item): item is LocalDeviceSkill =>
      typeof item === 'object' &&
      item !== null &&
      'name' in item &&
      'path' in item,
  )
  return sortSkillsByName(dedupeSkillsByName(skills))
}

function parseJsonOutput(output: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    return output
  }
}

function dedupeSkillsByName(skills: LocalDeviceSkill[]): LocalDeviceSkill[] {
  const seen = new Set<string>()
  return skills.filter(skill => {
    const key = skill.name.trim().toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sortSkillsByName(skills: LocalDeviceSkill[]): LocalDeviceSkill[] {
  return [...skills].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
  )
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
      return getStringArrayOutput(response)
    },

    async listSkills(deviceId: string): Promise<LocalDeviceSkill[]> {
      const response = await client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        {
          command_key: 'ls_skills',
          timeout_seconds: 15,
          max_output_bytes: 1024 * 256,
        },
      )
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to list skills')
      }
      return getSkillArrayOutput(response)
    },

    async createDirectory(deviceId: string, path: string): Promise<void> {
      const normalizedPath = path.trim()
      if (!normalizedPath) {
        throw new Error('Directory path is required')
      }

      const response = await client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        {
          command_key: 'mkdir_p',
          args: [normalizedPath],
          timeout_seconds: 15,
          max_output_bytes: 4096,
        },
      )
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to create directory')
      }
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

    async deleteDevice(deviceId: string): Promise<{ message: string }> {
      return client.delete<{ message: string }>(
        `/devices/${encodeURIComponent(deviceId)}`,
      )
    },

    upgradeDevice(
      deviceId: string,
      options?: UpgradeDeviceOptions,
    ): Promise<UpgradeDeviceResponse> {
      return client.post<UpgradeDeviceResponse>(
        `/devices/${encodeURIComponent(deviceId)}/upgrade`,
        options || {},
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
