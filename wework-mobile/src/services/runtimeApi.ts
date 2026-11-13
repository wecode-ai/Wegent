import type { RuntimeSessionConfig } from './backendConfig'
import { requestUserInputResponseText } from '../../../packages/chat-core/src/runtime-user-input'
import type { RuntimeGuidanceResponse } from '../../../packages/chat-core/src/runtime-task-api-types'
import type {
  DeviceListResponse,
  RuntimeCreateRequest,
  RuntimeCreateResponse,
  RuntimeAttachment,
  RuntimeInstalledPlugin,
  RuntimeUploadAsset,
  RuntimeSendResponse,
  RuntimeTaskCancelResponse,
  RuntimeTaskAddress,
  RuntimeWorktreePreflightResponse,
  RuntimeWorkspaceOpenResponse,
  ModelSelectionConfig,
  UnifiedModelListResponse,
  RunnerModel,
  RequestUserInputResponse,
} from '@/types/runtime'

export class RuntimeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown
  ) {
    super(message)
    this.name = 'RuntimeApiError'
  }
}

interface RuntimeFileUploadResult {
  body: string
  status: number
}

interface RuntimeDeviceCommandResponse {
  success: boolean
  stdout: string | Record<string, unknown> | unknown[]
  stderr?: string
  error?: string | null
}

type RuntimeFileUploader = (input: {
  headers: Record<string, string>
  mimeType: string
  name: string
  uri: string
  url: string
}) => Promise<RuntimeFileUploadResult>

export class RuntimeApi {
  private readonly pluginCatalogs = new Map<
    string,
    {
      value?: RuntimeInstalledPlugin[]
      expiresAt: number
      pending?: Promise<RuntimeInstalledPlugin[]>
    }
  >()
  constructor(
    private readonly config: RuntimeSessionConfig,
    private readonly uploadFile: RuntimeFileUploader = uploadRuntimeFile,
    private readonly getAccessToken: () => string = () => config.accessToken
  ) {}

  async testConnection(): Promise<void> {
    await this.request<DeviceListResponse>('/devices')
  }

  listDevices(): Promise<DeviceListResponse> {
    return this.request('/devices')
  }

  listModels(): Promise<UnifiedModelListResponse> {
    return this.request(
      '/models/unified?include_config=true&scope=all&model_category_type=llm&client_origin=wework'
    )
  }

  async listNativeModels(deviceRecordId: number): Promise<{
    models: RunnerModel[]
    catalog_error?: string | null
  }> {
    // APP catalogs use the same server-authorized read as PC Wework.
    const rows = await this.request<
      { id: string; models: RunnerModel[]; catalog_error?: string | null }[]
    >('/v1/resources/execution-environments')
    const row = rows.find(candidate => candidate.id === String(deviceRecordId))
    if (!row) throw new Error('设备已不可用，请刷新设备列表')
    if (!Array.isArray(row.models)) throw new Error('设备返回了无效的模型目录')
    return { models: row.models, catalog_error: row.catalog_error }
  }

  preflightWorkspace(input: {
    deviceId: string
    sourcePath: string
  }): Promise<RuntimeWorktreePreflightResponse> {
    return this.request('/runtime-work/worktrees/preflight', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  createConversation(data: RuntimeCreateRequest): Promise<RuntimeCreateResponse> {
    return this.request('/runtime-work/create', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async getHomeDirectory(deviceId: string): Promise<string> {
    const response = await this.executeDeviceCommand(deviceId, {
      commandKey: 'home_dir',
      timeoutSeconds: 10,
    })
    if (!response.success) {
      throw new Error(response.error || response.stderr || '无法读取设备主目录')
    }
    if (typeof response.stdout !== 'string' || !response.stdout.trim()) {
      throw new Error('设备返回了无效的主目录')
    }
    return response.stdout.trim()
  }

  async createDirectory(deviceId: string, path: string): Promise<void> {
    const normalizedPath = path.trim()
    if (!normalizedPath) throw new Error('目录路径不能为空')
    const response = await this.executeDeviceCommand(deviceId, {
      commandKey: 'mkdir_p',
      args: [normalizedPath],
      timeoutSeconds: 15,
    })
    if (!response.success) {
      throw new Error(response.error || response.stderr || '无法创建会话目录')
    }
  }

  sendMessage(
    address: RuntimeTaskAddress,
    message: string,
    clientUserMessageId: string,
    modelSelection: ModelSelectionConfig,
    attachmentIds: number[] = []
  ): Promise<RuntimeSendResponse> {
    return this.request('/runtime-work/send', {
      method: 'POST',
      body: JSON.stringify({
        address,
        message,
        clientUserMessageId,
        modelSelection,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      }),
    })
  }

  cancelTask(address: RuntimeTaskAddress): Promise<RuntimeTaskCancelResponse> {
    return this.request('/runtime-work/cancel', {
      method: 'POST',
      body: JSON.stringify(address),
    })
  }

  respondToUserInput(
    address: RuntimeTaskAddress,
    response: RequestUserInputResponse
  ): Promise<RuntimeSendResponse> {
    return this.request('/runtime-work/send', {
      method: 'POST',
      body: JSON.stringify({
        address,
        message: requestUserInputResponseText(response),
        requestUserInputResponse: response,
      }),
    })
  }

  guideTask(
    address: RuntimeTaskAddress,
    message: string,
    clientGuidanceId: string
  ): Promise<RuntimeGuidanceResponse> {
    return this.request('/runtime-work/guidance', {
      method: 'POST',
      body: JSON.stringify({ address, message, clientGuidanceId }),
    })
  }

  async uploadAttachment(asset: RuntimeUploadAsset): Promise<RuntimeAttachment> {
    if (asset.size && asset.size > 100 * 1024 * 1024) {
      throw new Error('附件不能超过 100 MB')
    }
    const response = await this.uploadFile({
      url: `${this.config.apiBaseUrl}/attachments/upload`,
      uri: asset.uri,
      name: asset.name,
      mimeType: asset.mimeType,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.getAccessToken()}`,
      },
    })
    const body = parseTextBody(response.body)
    if (response.status < 200 || response.status >= 300) {
      throw new RuntimeApiError(
        errorMessage(body) ?? `附件上传失败 (${response.status})`,
        response.status,
        body
      )
    }
    const attachment = body as {
      id: number
      filename: string
      file_size: number
      mime_type: string
    }
    return {
      id: attachment.id,
      filename: attachment.filename,
      fileSize: attachment.file_size,
      mimeType: attachment.mime_type,
    }
  }

  listInstalledPlugins(deviceId?: string): Promise<RuntimeInstalledPlugin[]> {
    const key = deviceId ?? ''
    const cached = this.pluginCatalogs.get(key)
    if (cached?.value && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
    if (cached?.pending) return cached.pending
    const entry: NonNullable<typeof cached> = { expiresAt: 0 }
    this.pluginCatalogs.set(key, entry)
    const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''
    entry.pending = this.request<{ items: RuntimeInstalledPlugin[] }>(`/plugins/installed${query}`)
      .then(response => {
        entry.value = response.items
        // PC Wework uses the same 30-second composer inventory freshness window.
        entry.expiresAt = Date.now() + 30_000
        return response.items
      })
      .finally(() => {
        entry.pending = undefined
      })
    return entry.pending
  }

  clearPluginCatalogs(): void {
    this.pluginCatalogs.clear()
  }

  setGoal(address: RuntimeTaskAddress, objective: string): Promise<{ accepted: boolean }> {
    return this.request('/runtime-work/goal/set', {
      method: 'POST',
      body: JSON.stringify({ address, objective, status: 'active' }),
    })
  }

  openWorkspace(input: {
    deviceId: string
    workspacePath: string
  }): Promise<RuntimeWorkspaceOpenResponse> {
    return this.request('/runtime-work/workspaces/open', {
      method: 'POST',
      body: JSON.stringify({ ...input, runtime: 'codex', action: 'create' }),
    })
  }

  renameWorkspace(input: {
    deviceId: string
    workspacePath: string
    name: string
  }): Promise<RuntimeWorkspaceOpenResponse> {
    return this.request('/runtime-work/workspaces/rename', {
      method: 'POST',
      body: JSON.stringify({ ...input, runtime: 'codex' }),
    })
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    token = this.getAccessToken(),
    useUpdatedToken = true
  ): Promise<T> {
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    })

    const body = await parseBody(response)
    const nextToken = this.getAccessToken()
    if (
      response.status === 401 &&
      useUpdatedToken &&
      token !== nextToken &&
      (!init.method || init.method === 'GET')
    )
      return this.request<T>(path, init, nextToken, false)
    if (!response.ok) {
      const message = errorMessage(body) ?? `请求失败 (${response.status})`
      throw new RuntimeApiError(message, response.status, body)
    }
    return body as T
  }

  private executeDeviceCommand(
    deviceId: string,
    input: { commandKey: string; args?: string[]; timeoutSeconds: number }
  ): Promise<RuntimeDeviceCommandResponse> {
    return this.request(`/devices/${encodeURIComponent(deviceId)}/commands`, {
      method: 'POST',
      body: JSON.stringify({
        command_key: input.commandKey,
        ...(input.args ? { args: input.args } : {}),
        timeout_seconds: input.timeoutSeconds,
        max_output_bytes: 4096,
      }),
    })
  }
}

async function uploadRuntimeFile(input: {
  headers: Record<string, string>
  mimeType: string
  name: string
  uri: string
  url: string
}): Promise<RuntimeFileUploadResult> {
  const { Directory, File, Paths, UploadType } = await import('expo-file-system')
  const source = new File(input.uri)
  if (!source.exists) throw new Error('无法读取所选附件')
  if (source.size > 100 * 1024 * 1024) throw new Error('附件不能超过 100 MB')

  const uploadDirectory = new Directory(
    Paths.cache,
    'wegent-attachment-uploads',
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  uploadDirectory.create({ idempotent: true, intermediates: true })
  const stagedFile = new File(uploadDirectory, safeUploadName(input.name))
  try {
    await source.copy(stagedFile)
    return await stagedFile.upload(input.url, {
      fieldName: 'file',
      headers: input.headers,
      httpMethod: 'POST',
      mimeType: input.mimeType,
      sessionType: 'foreground',
      uploadType: UploadType.MULTIPART,
    })
  } finally {
    if (uploadDirectory.exists) uploadDirectory.delete()
  }
}

function safeUploadName(name: string): string {
  return name.trim().replace(/[\\/\0]/g, '_') || 'attachment'
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null
  return parseTextBody(await response.text())
}

function parseTextBody(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function errorMessage(body: unknown): string | null {
  if (typeof body === 'string') return body
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  if (typeof record.detail === 'string') return record.detail
  if (record.detail && typeof record.detail === 'object') {
    const detail = record.detail as Record<string, unknown>
    if (typeof detail.message === 'string') return detail.message
  }
  if (typeof record.message === 'string') return record.message
  return null
}
