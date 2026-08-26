import type {
  DeviceCommandResponse,
  LocalDeviceSkill,
  SkillDirectorySetupResult,
} from '@/types/api'
import type {
  WorkspaceFileChunkResponse,
  WorkspaceTextFileResponse,
  WorkspaceTreeResponse,
} from '@/types/workspace-files'
import type {
  CloudDeviceResponse,
  CreateDockerRemoteDeviceCommandRequest,
  DockerRemoteDeviceCommandResponse,
  CloudDeviceMetricsResponse,
  DeviceInfo,
  DeviceListResponse,
  DeviceRuntimeSettingsResponse,
  DeviceSessionResponse,
  MetricsHistoryResponse,
  UpgradeDeviceOptions,
  UpgradeDeviceResponse,
} from '@/types/devices'
import type { DeviceGitAccountSyncResult, GitAccountSyncSummary } from '@/types/gitCredentials'
import { filterClaudeCodeDevices } from '@/lib/device-capabilities'
import {
  normalizeAbsoluteWorkspacePath,
  normalizeWorkspaceFileChunk,
  normalizeWorkspaceTextFile,
  normalizeWorkspaceTree,
  splitAbsoluteWorkspaceFilePath,
} from '@/lib/workspace-file-contract'
import type { HttpClient, HttpRequestOptions } from './http'

const WORKSPACE_TEXT_FILE_MAX_OUTPUT_BYTES = 1024 * 1024 * 2

function getCommandText(response: DeviceCommandResponse): string {
  const output =
    typeof response.stdout === 'string'
      ? response.stdout
      : Array.isArray(response.stdout)
        ? response.stdout.join('\n')
        : JSON.stringify(response.stdout)
  return output.trim()
}

function getStringArrayOutput(response: DeviceCommandResponse): string[] {
  if (!Array.isArray(response.stdout)) return []
  return response.stdout.filter((item): item is string => typeof item === 'string')
}

function getSkillArrayOutput(response: DeviceCommandResponse): LocalDeviceSkill[] {
  const stdout =
    typeof response.stdout === 'string' ? parseJsonOutput(response.stdout) : response.stdout
  if (!Array.isArray(stdout)) return []
  const skills = stdout.filter(
    (item): item is LocalDeviceSkill =>
      typeof item === 'object' && item !== null && 'name' in item && 'path' in item
  )
  return sortSkillsByName(dedupeSkillsByName(skills))
}

function getObjectOutput<T extends object>(response: DeviceCommandResponse): T | null {
  const stdout =
    typeof response.stdout === 'string' ? parseJsonOutput(response.stdout) : response.stdout
  if (!stdout || typeof stdout !== 'object' || Array.isArray(stdout)) return null
  return stdout as T
}

function parseJsonOutput(output: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    return output
  }
}

function dedupeSkillsByName(skills: LocalDeviceSkill[]): LocalDeviceSkill[] {
  const deduped = new Map<string, LocalDeviceSkill>()
  skills.forEach(skill => {
    const key = skill.name.trim().toLowerCase()
    if (!key) return
    const current = deduped.get(key)
    deduped.set(key, current ? preferSkill(current, skill) : skill)
  })
  return Array.from(deduped.values())
}

function preferSkill(left: LocalDeviceSkill, right: LocalDeviceSkill): LocalDeviceSkill {
  const leftRank = left.source_priority ?? 99
  const rightRank = right.source_priority ?? 99
  if (leftRank !== rightRank) return leftRank < rightRank ? left : right
  return (left.mtime ?? 0) >= (right.mtime ?? 0) ? left : right
}

function sortSkillsByName(skills: LocalDeviceSkill[]): LocalDeviceSkill[] {
  return [...skills].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  )
}

export function createDeviceApi(client: HttpClient) {
  async function fetchDevices(
    requestOptions?: Pick<HttpRequestOptions, 'signal'>
  ): Promise<DeviceInfo[]> {
    const response = requestOptions
      ? await client.get<DeviceListResponse>('/devices', requestOptions)
      : await client.get<DeviceListResponse>('/devices')
    return filterClaudeCodeDevices(response.items)
  }

  return {
    listDevices: fetchDevices,

    getAllDevices: fetchDevices,

    getGitAccountSyncSummary(): Promise<GitAccountSyncSummary> {
      return client.get('/users/me/git-accounts/sync-summary')
    },

    syncGitAccounts(deviceId: string, allowEmpty = false): Promise<DeviceGitAccountSyncResult> {
      return client.put(`/devices/${encodeURIComponent(deviceId)}/git-accounts`, {
        allow_empty: allowEmpty,
      })
    },

    getRuntimeSettings(deviceId: string): Promise<DeviceRuntimeSettingsResponse> {
      return client.get(`/devices/${encodeURIComponent(deviceId)}/runtime-settings`)
    },

    updateRuntimeSettings(
      deviceId: string,
      maxConcurrentTasks: number
    ): Promise<DeviceRuntimeSettingsResponse> {
      return client.put(`/devices/${encodeURIComponent(deviceId)}/runtime-settings`, {
        max_concurrent_tasks: maxConcurrentTasks,
      })
    },

    async getHomeDirectory(deviceId: string): Promise<string> {
      const response = await client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        {
          command_key: 'home_dir',
          timeout_seconds: 10,
          max_output_bytes: 4096,
        }
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
        }
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
        }
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
        }
      )
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to list skills')
      }
      return getSkillArrayOutput(response)
    },

    async listWorkspaceEntries(deviceId: string, path: string): Promise<WorkspaceTreeResponse> {
      const normalizedPath = normalizeAbsoluteWorkspacePath(path, 'Workspace path must be absolute')
      const response = await client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        {
          command_key: 'workspace_tree',
          path: normalizedPath,
          timeout_seconds: 15,
          max_output_bytes: 1024 * 512,
        }
      )
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to list workspace files')
      }
      return normalizeWorkspaceTree(response.stdout, normalizedPath)
    },

    async readWorkspaceTextFile(
      deviceId: string,
      filePath: string
    ): Promise<WorkspaceTextFileResponse> {
      const { parentPath, fileName } = splitAbsoluteWorkspaceFilePath(filePath)
      const response = await client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        {
          command_key: 'workspace_read_text_file',
          path: parentPath,
          args: [fileName],
          timeout_seconds: 15,
          max_output_bytes: WORKSPACE_TEXT_FILE_MAX_OUTPUT_BYTES,
        }
      )
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to read workspace file')
      }
      return normalizeWorkspaceTextFile(response.stdout, filePath)
    },

    async readWorkspaceFileChunk(
      deviceId: string,
      filePath: string,
      offset: number
    ): Promise<WorkspaceFileChunkResponse> {
      const { parentPath, fileName } = splitAbsoluteWorkspaceFilePath(filePath)
      const response = await client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        {
          command_key: 'workspace_read_file_chunk',
          path: parentPath,
          args: [fileName, String(offset)],
          timeout_seconds: 30,
          max_output_bytes: 1024 * 1024 * 2,
        }
      )
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to read workspace file')
      }
      return normalizeWorkspaceFileChunk(response.stdout, filePath, offset)
    },

    async setupSharedSkills(deviceId: string): Promise<SkillDirectorySetupResult> {
      const response = await client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        {
          command_key: 'setup_shared_skills',
          timeout_seconds: 60,
          max_output_bytes: 1024 * 256,
        }
      )
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to configure shared skills')
      }

      const output = getObjectOutput<SkillDirectorySetupResult>(response)
      if (!output || output.success !== true) {
        throw new Error(output?.error || 'Failed to read shared skills setup result')
      }
      return output
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
        }
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
      }
    ): Promise<DeviceCommandResponse> {
      return client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        data
      )
    },

    async startTerminal(deviceId: string, cwd?: string): Promise<DeviceSessionResponse> {
      const path = cwd?.trim()
      return path
        ? client.post<DeviceSessionResponse>(`/devices/${encodeURIComponent(deviceId)}/terminal`, {
            path,
          })
        : client.post<DeviceSessionResponse>(`/devices/${encodeURIComponent(deviceId)}/terminal`)
    },

    async startCodeServer(deviceId: string, cwd?: string): Promise<DeviceSessionResponse> {
      const path = cwd?.trim()
      return path
        ? client.post<DeviceSessionResponse>(
            `/devices/${encodeURIComponent(deviceId)}/code-server`,
            { path }
          )
        : client.post<DeviceSessionResponse>(`/devices/${encodeURIComponent(deviceId)}/code-server`)
    },

    async openLocalTerminal(deviceId: string, cwd?: string): Promise<void> {
      const args = cwd?.trim() ? [cwd.trim()] : []
      const response = await client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        {
          command_key: 'open_terminal',
          args,
          timeout_seconds: 10,
          max_output_bytes: 4096,
        }
      )
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to open terminal')
      }
    },

    async createCloudDevice(): Promise<CloudDeviceResponse> {
      return client.post<CloudDeviceResponse>('/cloud-devices')
    },

    async createDockerRemoteDeviceCommand(
      data?: CreateDockerRemoteDeviceCommandRequest
    ): Promise<DockerRemoteDeviceCommandResponse> {
      return client.post<DockerRemoteDeviceCommandResponse>(
        '/remote-devices/docker/start-command',
        data || {}
      )
    },

    async restartCloudDevice(deviceId: string): Promise<{ message: string }> {
      return client.post<{ message: string }>(
        `/cloud-devices/${encodeURIComponent(deviceId)}/restart`
      )
    },

    async deleteCloudDevice(deviceId: string): Promise<{ message: string }> {
      return client.delete<{ message: string }>(`/cloud-devices/${encodeURIComponent(deviceId)}`)
    },

    async deleteDevice(deviceId: string): Promise<{ message: string }> {
      return client.delete<{ message: string }>(`/devices/${encodeURIComponent(deviceId)}`)
    },

    upgradeDevice(
      deviceId: string,
      options?: UpgradeDeviceOptions
    ): Promise<UpgradeDeviceResponse> {
      return client.post<UpgradeDeviceResponse>(
        `/devices/${encodeURIComponent(deviceId)}/upgrade`,
        options || {}
      )
    },

    getMetrics(deviceId: string): Promise<CloudDeviceMetricsResponse> {
      return client.post<CloudDeviceMetricsResponse>(
        `/cloud-devices/${encodeURIComponent(deviceId)}/metrics`
      )
    },

    getMetricsHistory(deviceId: string): Promise<MetricsHistoryResponse> {
      return client.post<MetricsHistoryResponse>(
        `/cloud-devices/${encodeURIComponent(deviceId)}/metrics/history`
      )
    },

    async renameDevice(deviceId: string, alias: string): Promise<void> {
      await client.put<{ message: string }>(`/devices/${encodeURIComponent(deviceId)}/alias`, {
        alias,
      })
    },
  }
}
