import { decodeRuntimeSkills } from '@wegent/chat-core/runtime-composer-api'
import type {
  DeviceCommandRequest,
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
import { filterClaudeCodeDevices, isRemoteTaskAccessEnabled } from '@/lib/device-capabilities'
import {
  normalizeAbsoluteWorkspacePath,
  normalizeWorkspaceFileChunk,
  normalizeWorkspaceTextFile,
  normalizeWorkspaceTree,
  splitAbsoluteWorkspaceFilePath,
} from '@/lib/workspace-file-contract'
import { ApiError, type HttpClient, type HttpRequestOptions } from './http'

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

export function createDeviceApi(client: HttpClient) {
  async function executeCommand(
    deviceId: string,
    data: DeviceCommandRequest
  ): Promise<DeviceCommandResponse> {
    try {
      return await client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        data
      )
    } catch (error) {
      // This endpoint returns 404 only when the owned device is unavailable.
      // Command and filesystem failures are carried by the command response.
      if (error instanceof ApiError && error.status === 404) {
        throw new Error(`executor-not-found:${deviceId}`, { cause: error })
      }
      throw error
    }
  }

  async function fetchDevices(
    requestOptions?: Pick<HttpRequestOptions, 'signal'>
  ): Promise<DeviceInfo[]> {
    const response = requestOptions
      ? await client.get<DeviceListResponse>('/devices', requestOptions)
      : await client.get<DeviceListResponse>('/devices')
    return filterClaudeCodeDevices(response.items).map(device =>
      device.device_type === 'app' &&
      isRemoteTaskAccessEnabled(device) &&
      device.execution_target_id
        ? { ...device, device_id: device.execution_target_id }
        : device
    )
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
      settings: Partial<
        Pick<
          DeviceRuntimeSettingsResponse,
          'max_concurrent_tasks' | 'max_concurrent_stand_in_tasks' | 'max_concurrent_agent_tasks'
        >
      >
    ): Promise<DeviceRuntimeSettingsResponse> {
      return client.put(`/devices/${encodeURIComponent(deviceId)}/runtime-settings`, settings)
    },

    async getHomeDirectory(deviceId: string): Promise<string> {
      const response = await executeCommand(deviceId, {
        command_key: 'home_dir',
        timeout_seconds: 10,
        max_output_bytes: 4096,
      })
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to resolve home directory')
      }
      return getCommandText(response)
    },
    async getProjectWorkspaceRoot(deviceId: string): Promise<string> {
      const response = await executeCommand(deviceId, {
        command_key: 'project_workspace_root',
        timeout_seconds: 10,
        max_output_bytes: 4096,
      })
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to resolve project directory')
      }
      return getCommandText(response)
    },

    async listDirectories(deviceId: string, path: string): Promise<string[]> {
      const response = await executeCommand(deviceId, {
        command_key: 'ls_dirs',
        path,
        timeout_seconds: 15,
        max_output_bytes: 1024 * 64,
      })
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to list directories')
      }
      return getStringArrayOutput(response)
    },

    async listSkills(deviceId: string): Promise<LocalDeviceSkill[]> {
      const response = await executeCommand(deviceId, {
        command_key: 'ls_skills',
        timeout_seconds: 15,
        max_output_bytes: 1024 * 256,
      })
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to list skills')
      }
      return decodeRuntimeSkills(response.stdout)
    },

    async listWorkspaceEntries(deviceId: string, path: string): Promise<WorkspaceTreeResponse> {
      const normalizedPath = normalizeAbsoluteWorkspacePath(path, 'Workspace path must be absolute')
      const response = await executeCommand(deviceId, {
        command_key: 'workspace_tree',
        path: normalizedPath,
        timeout_seconds: 15,
        max_output_bytes: 1024 * 512,
      })
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
      const response = await executeCommand(deviceId, {
        command_key: 'workspace_read_text_file',
        path: parentPath,
        args: [fileName],
        timeout_seconds: 15,
        max_output_bytes: WORKSPACE_TEXT_FILE_MAX_OUTPUT_BYTES,
      })
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
      const response = await executeCommand(deviceId, {
        command_key: 'workspace_read_file_chunk',
        path: parentPath,
        args: [fileName, String(offset)],
        timeout_seconds: 30,
        max_output_bytes: 1024 * 1024 * 2,
      })
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to read workspace file')
      }
      return normalizeWorkspaceFileChunk(response.stdout, filePath, offset)
    },

    async setupSharedSkills(deviceId: string): Promise<SkillDirectorySetupResult> {
      const response = await executeCommand(deviceId, {
        command_key: 'setup_shared_skills',
        timeout_seconds: 60,
        max_output_bytes: 1024 * 256,
      })
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

      const response = await executeCommand(deviceId, {
        command_key: 'mkdir_p',
        args: [normalizedPath],
        timeout_seconds: 15,
        max_output_bytes: 4096,
      })
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to create directory')
      }
    },

    executeCommand,

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

    async startExtensionSession(
      deviceId: string,
      sessionType: string
    ): Promise<DeviceSessionResponse> {
      if (!/^[a-z][a-z0-9-]*$/.test(sessionType)) {
        throw new Error('Invalid device session type')
      }
      return client.post<DeviceSessionResponse>(
        `/devices/${encodeURIComponent(deviceId)}/${sessionType}`
      )
    },

    async revokeExtensionSession(sessionType: string, sessionId: string): Promise<void> {
      if (!/^[a-z][a-z0-9-]*$/.test(sessionType)) {
        throw new Error('Invalid device session type')
      }
      return client.delete(`/devices/${sessionType}-sessions/${encodeURIComponent(sessionId)}`)
    },

    async openLocalTerminal(deviceId: string, cwd?: string): Promise<void> {
      const args = cwd?.trim() ? [cwd.trim()] : []
      const response = await executeCommand(deviceId, {
        command_key: 'open_terminal',
        args,
        timeout_seconds: 10,
        max_output_bytes: 4096,
      })
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
