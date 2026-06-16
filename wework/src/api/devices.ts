import type {
  DeviceCommandResponse,
  LocalDeviceSkill,
  SkillDirectorySetupResult,
} from '@/types/api'
import type {
  WorkspaceFileEntry,
  WorkspaceTextFileResponse,
  WorkspaceTreeResponse,
} from '@/types/workspace-files'
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
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  )
}

function requireRecord(value: unknown, errorMessage: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(errorMessage)
  }
  return value as Record<string, unknown>
}

function normalizeModifiedAt(value: unknown, errorMessage: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  throw new Error(errorMessage)
}

function normalizeAbsoluteWorkspacePath(path: string, errorMessage: string): string {
  const normalizedSegments: string[] = []
  const normalizedPath = path.trim().replace(/\/+/g, '/')
  if (!normalizedPath.startsWith('/')) {
    throw new Error(errorMessage)
  }

  for (const segment of normalizedPath.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (normalizedSegments.length === 0) {
        throw new Error(errorMessage)
      }
      normalizedSegments.pop()
      continue
    }
    normalizedSegments.push(segment)
  }

  return `/${normalizedSegments.join('/')}`
}

function isWorkspacePathWithin(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath.replace(/\/+$/, '')}/`)
}

function requireWorkspacePathWithin(
  path: string,
  rootPath: string,
  errorMessage: string,
) {
  if (!isWorkspacePathWithin(path, rootPath)) {
    throw new Error(errorMessage)
  }
}

function normalizeWorkspaceEntry(value: unknown, rootPath: string): WorkspaceFileEntry {
  const record = requireRecord(value, 'Invalid workspace tree response')
  if (
    typeof record.name !== 'string' ||
    typeof record.path !== 'string' ||
    typeof record.is_directory !== 'boolean' ||
    typeof record.size !== 'number'
  ) {
    throw new Error('Invalid workspace tree response')
  }
  const path = normalizeAbsoluteWorkspacePath(
    record.path,
    'Invalid workspace tree response',
  )
  requireWorkspacePathWithin(path, rootPath, 'Invalid workspace tree response')
  return {
    name: record.name,
    path,
    isDirectory: record.is_directory,
    size: record.size,
    modifiedAt: normalizeModifiedAt(record.modified_at, 'Invalid workspace tree response'),
  }
}

function normalizeWorkspaceTree(
  output: unknown,
  requestedPath: string,
): WorkspaceTreeResponse {
  const normalizedRequestedPath = normalizeAbsoluteWorkspacePath(
    requestedPath,
    'Workspace path must be absolute',
  )
  const record = requireRecord(output, 'Invalid workspace tree response')
  if (typeof record.path !== 'string' || !Array.isArray(record.entries)) {
    throw new Error('Invalid workspace tree response')
  }
  const path = normalizeAbsoluteWorkspacePath(
    record.path,
    'Invalid workspace tree response',
  )
  if (path !== normalizedRequestedPath) {
    throw new Error('Invalid workspace tree response')
  }
  return {
    path,
    entries: record.entries.map(entry => normalizeWorkspaceEntry(entry, path)),
  }
}

function normalizeWorkspaceTextFile(
  output: unknown,
  requestedFilePath: string,
): WorkspaceTextFileResponse {
  const normalizedRequestedFilePath = normalizeAbsoluteWorkspacePath(
    requestedFilePath,
    'Workspace file path must be absolute',
  )
  const record = requireRecord(output, 'Invalid workspace text file response')
  if (
    typeof record.path !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.content !== 'string' ||
    typeof record.truncated !== 'boolean' ||
    typeof record.size !== 'number'
  ) {
    throw new Error('Invalid workspace text file response')
  }
  const path = normalizeAbsoluteWorkspacePath(
    record.path,
    'Invalid workspace text file response',
  )
  if (path !== normalizedRequestedFilePath) {
    throw new Error('Invalid workspace text file response')
  }
  return {
    path,
    name: record.name,
    content: record.content,
    truncated: record.truncated,
    size: record.size,
    modifiedAt: normalizeModifiedAt(record.modified_at, 'Invalid workspace text file response'),
  }
}

function splitAbsoluteWorkspaceFilePath(filePath: string): {
  parentPath: string
  fileName: string
} {
  const normalizedFilePath = normalizeAbsoluteWorkspacePath(
    filePath,
    'Workspace file path must be absolute',
  )

  const separatorIndex = normalizedFilePath.lastIndexOf('/')
  const parentPath = separatorIndex > 0 ? normalizedFilePath.slice(0, separatorIndex) : '/'
  const fileName = separatorIndex >= 0
    ? normalizedFilePath.slice(separatorIndex + 1)
    : normalizedFilePath
  if (!fileName) {
    throw new Error('Workspace file name is required')
  }
  return { parentPath, fileName }
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
      const normalizedPath = normalizeAbsoluteWorkspacePath(
        path,
        'Workspace path must be absolute',
      )
      const response = await client.post<DeviceCommandResponse>(
        `/devices/${encodeURIComponent(deviceId)}/commands`,
        {
          command_key: 'workspace_tree',
          path: normalizedPath,
          timeout_seconds: 15,
          max_output_bytes: 1024 * 512,
        },
      )
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to list workspace files')
      }
      return normalizeWorkspaceTree(response.stdout, normalizedPath)
    },

    async readWorkspaceTextFile(
      deviceId: string,
      filePath: string,
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
        },
      )
      if (!response.success) {
        throw new Error(response.error || response.stderr || 'Failed to read workspace file')
      }
      return normalizeWorkspaceTextFile(response.stdout, filePath)
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

    async startTerminal(deviceId: string): Promise<DeviceSessionResponse> {
      return client.post<DeviceSessionResponse>(`/devices/${encodeURIComponent(deviceId)}/terminal`)
    },

    async startCodeServer(deviceId: string): Promise<DeviceSessionResponse> {
      return client.post<DeviceSessionResponse>(
        `/devices/${encodeURIComponent(deviceId)}/code-server`
      )
    },

    async createCloudDevice(): Promise<CloudDeviceResponse> {
      return client.post<CloudDeviceResponse>('/cloud-devices')
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

    getVncConfig(deviceId: string): Promise<VncConfigResponse> {
      return client.get<VncConfigResponse>(
        `/cloud-devices/${encodeURIComponent(deviceId)}/vnc-config`
      )
    },

    async renameDevice(deviceId: string, alias: string): Promise<void> {
      await client.put<{ message: string }>(`/devices/${encodeURIComponent(deviceId)}/alias`, {
        alias,
      })
    },
  }
}
