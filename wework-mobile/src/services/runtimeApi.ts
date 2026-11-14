import type { RuntimeSessionConfig } from './backendConfig'
import type {
  RuntimeWorktreeDeleteRequest,
  RuntimeWorktreeMutationResponse,
} from '@/types/runtimeWorktree'
import { requestUserInputResponseText } from '../../../packages/chat-core/src/runtime-user-input'
import type { RuntimeGuidanceResponse } from '../../../packages/chat-core/src/runtime-task-api-types'
import { loadRuntimeFileChangesDiff } from '../../../packages/chat-core/src/runtime-file-changes'
import type { TurnFileChangesSummary } from '../../../packages/chat-core/src/runtime'
import type { RuntimeTranscriptResponse as CoreTranscript } from '../../../packages/chat-core/src/runtime'
import { readRuntimeTranscript } from '../../../packages/chat-core/src/runtime-transcript-transport'
import { projectMobileRuntimeTranscript } from '@/domain/runtimeTranscript'
import { decodeMobileTranscriptGzip } from './mobileTranscriptTransfer'
import { mobileAbortError, throwIfAborted } from './mobileAbort'
import type { RuntimeStream } from './runtimeStream'
import type { RuntimeDeviceCommandResponse } from '@/types/runtimeCommand'
import {
  normalizeAbsoluteWorkspacePath,
  normalizeWorkspaceFileChunk,
  normalizeWorkspaceTextFile,
  normalizeWorkspaceTree,
  splitAbsoluteWorkspaceFilePath,
} from '../../../packages/chat-core/src/workspace-file-contract'
import type {
  WorkspaceFileChunkResponse,
  WorkspaceTextFileResponse,
  WorkspaceTreeResponse,
} from '../../../packages/chat-core/src/workspace-files'
import type { RuntimeWorkspaceSearchResponse } from '../../../packages/chat-core/src/runtime-workspace-search'
import {
  workspaceGitCommandOutput,
  workspaceGitDiffCommand,
  type WorkspaceGitSelection,
} from '../../../packages/chat-core/src/workspace-git'
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
  RuntimeTaskPinRequest,
  RuntimeSidebarMutationResponse,
  RuntimeTaskRenameRequest,
  RuntimeTaskArchiveResponse,
  RuntimeTranscriptResponse,
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

export interface RuntimeAttachmentDownload {
  filename?: string
  mimeType?: string
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
    private readonly getAccessToken: () => string = () => config.accessToken,
    private readonly runtime?: Pick<RuntimeStream, 'executeCommand' | 'request'>
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

  async listWorkspaceDirectory(deviceId: string, path: string): Promise<WorkspaceTreeResponse> {
    const normalizedPath = normalizeAbsoluteWorkspacePath(path, 'Workspace path must be absolute')
    const response = await this.executeDeviceCommand(deviceId, {
      commandKey: 'workspace_tree',
      path: normalizedPath,
      timeoutSeconds: 15,
      maxOutputBytes: 512 * 1024,
    })
    assertDeviceCommandSucceeded(response, '无法读取设备目录')
    return normalizeWorkspaceTree(response.stdout, normalizedPath)
  }

  getWorkspaceGitBranch(deviceId: string, path: string, signal?: AbortSignal): Promise<string> {
    return this.readWorkspaceGitCommand(deviceId, path, 'git_branch', { signal })
  }

  async getWorkspaceGitDiff(
    deviceId: string,
    path: string,
    selection: WorkspaceGitSelection,
    signal?: AbortSignal
  ): Promise<string> {
    const command = workspaceGitDiffCommand(selection)
    return this.readWorkspaceGitCommand(deviceId, path, command.commandKey, {
      signal,
      timeoutSeconds: 30,
      maxOutputBytes: 5 * 1024 * 1024,
    })
  }

  private async readWorkspaceGitCommand(
    deviceId: string,
    path: string,
    commandKey: string,
    options: {
      signal?: AbortSignal
      timeoutSeconds?: number
      maxOutputBytes?: number
    } = {}
  ): Promise<string> {
    throwIfAborted(options.signal)
    if (!deviceId.trim()) throw new Error('Workspace target device is required')
    const normalizedPath = normalizeAbsoluteWorkspacePath(path, 'Workspace path must be absolute')
    if (!this.runtime) throw new Error('Runtime command connection is unavailable')
    const response = await this.runtime.executeCommand(
      deviceId,
      {
        command_key: commandKey,
        path: normalizedPath,
        timeout_seconds: options.timeoutSeconds ?? 10,
        max_output_bytes: options.maxOutputBytes ?? 4096,
      },
      options.signal
    )
    throwIfAborted(options.signal)
    return workspaceGitCommandOutput(response, commandKey)
  }

  async isWorkspaceGitRepository(
    deviceId: string,
    path: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    throwIfAborted(signal)
    if (!deviceId.trim()) throw new Error('Workspace target device is required')
    const normalizedPath = normalizeAbsoluteWorkspacePath(path, 'Workspace path must be absolute')
    if (!this.runtime) throw new Error('Runtime command connection is unavailable')
    const response = await this.runtime.executeCommand(
      deviceId,
      {
        command_key: 'git_is_worktree',
        path: normalizedPath,
        args: [normalizedPath],
        timeout_seconds: 10,
        max_output_bytes: 4096,
      },
      signal
    )
    throwIfAborted(signal)
    if (response.stdout_truncated) throw new Error('Git repository probe was truncated')
    // PC uses this command's success + true output as its repository capability probe.
    return response.success && workspaceGitCommandOutput(response, 'git_is_worktree') === 'true'
  }

  async readWorkspaceTextFile(
    deviceId: string,
    filePath: string,
    _workspaceRoot?: string
  ): Promise<WorkspaceTextFileResponse> {
    const { parentPath, fileName } = splitAbsoluteWorkspaceFilePath(filePath)
    const response = await this.executeDeviceCommand(deviceId, {
      commandKey: 'workspace_read_text_file',
      path: parentPath,
      args: [fileName],
      timeoutSeconds: 15,
      maxOutputBytes: 2 * 1024 * 1024,
    })
    assertDeviceCommandSucceeded(response, '无法读取设备文件')
    return normalizeWorkspaceTextFile(response.stdout, filePath)
  }

  async readWorkspaceFileChunk(
    deviceId: string,
    filePath: string,
    offset: number,
    _workspaceRoot?: string
  ): Promise<WorkspaceFileChunkResponse> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('文件偏移量必须是非负整数')
    }
    const { parentPath, fileName } = splitAbsoluteWorkspaceFilePath(filePath)
    const response = await this.executeDeviceCommand(deviceId, {
      commandKey: 'workspace_read_file_chunk',
      path: parentPath,
      args: [fileName, String(offset)],
      timeoutSeconds: 30,
      maxOutputBytes: 2 * 1024 * 1024,
    })
    assertDeviceCommandSucceeded(response, '无法读取设备文件')
    return normalizeWorkspaceFileChunk(response.stdout, filePath, offset)
  }

  async searchWorkspaceEntries(
    deviceId: string,
    root: string,
    query: string,
    cancellationToken?: string
  ): Promise<RuntimeWorkspaceSearchResponse> {
    const response = await this.request<RuntimeWorkspaceSearchResponse>(
      '/runtime-work/workspace/search',
      {
        method: 'POST',
        body: JSON.stringify({ deviceId, root, query, cancellationToken }),
      }
    )
    if (!isWorkspaceSearchResponse(response)) throw new Error('设备返回了无效的文件搜索结果')
    return response
  }

  readFileChangesDiff(summary: TurnFileChangesSummary | undefined): Promise<string> {
    return loadRuntimeFileChangesDiff(
      {
        executeCommand: (deviceId, input) =>
          this.executeDeviceCommand(deviceId, {
            commandKey: input.command_key,
            path: input.path,
            args: input.args,
            timeoutSeconds: input.timeout_seconds,
            maxOutputBytes: input.max_output_bytes,
          }),
      },
      summary
    )
  }

  async downloadAttachment(
    id: number,
    destinationUri: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<RuntimeAttachmentDownload> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('附件标识无效')
    return downloadRuntimeAttachment(
      `${this.config.apiBaseUrl}/attachments/${id}/download`,
      destinationUri,
      this.getAccessToken(),
      options.signal
    )
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

  setRuntimeTaskPinned(input: RuntimeTaskPinRequest): Promise<RuntimeSidebarMutationResponse> {
    return this.requestRuntime('runtime.sidebar.tasks.pin', { ...input }, input.deviceId)
  }

  renameRuntimeTask(input: RuntimeTaskRenameRequest): Promise<RuntimeTaskArchiveResponse> {
    return this.requestRuntime('runtime.tasks.rename', { ...input }, input.address.deviceId)
  }

  archiveConversation(address: RuntimeTaskAddress): Promise<RuntimeTaskArchiveResponse> {
    return this.requestRuntime('runtime.tasks.archive', { ...address }, address.deviceId)
  }

  private async requestRuntime<T>(
    method: string,
    params: Record<string, unknown>,
    deviceId: string
  ): Promise<T> {
    if (!deviceId.trim()) throw new Error('Runtime target device is required')
    if (!this.runtime) throw new Error('Runtime connection is unavailable')
    return this.runtime.request<T>(method, params, deviceId)
  }

  /** An isolated child-thread read never changes the parent's active conversation. */
  async getSubagentTranscript(
    address: RuntimeTaskAddress,
    threadId: string,
    signal?: AbortSignal
  ): Promise<RuntimeTranscriptResponse> {
    if (!threadId.trim()) throw new Error('A thread view requires an explicit thread identity')
    throwIfAborted(signal)
    const response = await readRuntimeTranscript<CoreTranscript & { taskId: string }>(
      { ...address, threadId, includeFullContent: true },
      query =>
        this.request('/runtime-work/transcript', {
          method: 'POST',
          body: JSON.stringify(query),
          signal,
        }),
      decodeMobileTranscriptGzip
    )
    throwIfAborted(signal)
    if (response.threadId !== threadId)
      throw new Error('Runtime returned a different thread for the requested view')
    return projectMobileRuntimeTranscript(response)
  }

  deleteWorktree(input: RuntimeWorktreeDeleteRequest): Promise<RuntimeWorktreeMutationResponse> {
    return this.request('/runtime-work/worktrees/delete', {
      method: 'POST',
      body: JSON.stringify(input),
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

  private async executeDeviceCommand(
    deviceId: string,
    input: {
      commandKey: string
      path?: string
      args?: string[]
      timeoutSeconds: number
      maxOutputBytes?: number
      signal?: AbortSignal
    }
  ): Promise<RuntimeDeviceCommandResponse> {
    const response = await this.request<RuntimeDeviceCommandResponse>(
      `/devices/${encodeURIComponent(deviceId)}/commands`,
      {
        method: 'POST',
        signal: input.signal,
        body: JSON.stringify({
          command_key: input.commandKey,
          ...(input.path !== undefined ? { path: input.path } : {}),
          ...(input.args ? { args: input.args } : {}),
          timeout_seconds: input.timeoutSeconds,
          max_output_bytes: input.maxOutputBytes ?? 4096,
        }),
      }
    )
    if (!response || typeof response.success !== 'boolean') {
      throw new Error('设备返回了无效的命令响应')
    }
    return response
  }
}

function assertDeviceCommandSucceeded(response: RuntimeDeviceCommandResponse, message: string) {
  const stdout =
    response.stdout && typeof response.stdout === 'object' && !Array.isArray(response.stdout)
      ? response.stdout
      : null
  if (!response.success || stdout?.success === false) {
    throw new Error(
      (typeof stdout?.error === 'string' && stdout.error) ||
        response.error ||
        response.stderr ||
        message
    )
  }
}

function isWorkspaceSearchResponse(value: unknown): value is RuntimeWorkspaceSearchResponse {
  if (!value || typeof value !== 'object' || !('files' in value) || !Array.isArray(value.files)) {
    return false
  }
  return value.files.every(
    item =>
      item &&
      typeof item === 'object' &&
      typeof item.root === 'string' &&
      typeof item.path === 'string' &&
      typeof item.fileName === 'string' &&
      (item.matchType === 'file' || item.matchType === 'directory') &&
      Number.isFinite(item.score) &&
      (item.indices == null ||
        (Array.isArray(item.indices) &&
          item.indices.every(
            (index: unknown) => Number.isSafeInteger(index) && Number(index) >= 0
          )))
  )
}

async function downloadRuntimeAttachment(
  url: string,
  destinationUri: string,
  token: string,
  signal?: AbortSignal
): Promise<RuntimeAttachmentDownload> {
  const [{ File }, { createDownloadResumable, FileSystemSessionType }] = await Promise.all([
    import('expo-file-system'),
    import('expo-file-system/legacy'),
  ])
  throwIfAborted(signal)
  const destination = new File(destinationUri)
  if (destination.exists) throw new Error('附件下载目标已存在')
  const download = createDownloadResumable(url, destinationUri, {
    headers: { Authorization: `Bearer ${token}` },
    sessionType: FileSystemSessionType.FOREGROUND,
  })
  let cancellation: Promise<unknown[]> | undefined
  const cancel = () => {
    cancellation ??= download.cancelAsync().then(
      () => [],
      error => [error]
    )
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const response = await download.downloadAsync()
    const cancellationErrors = await cancellation
    if (cancellationErrors?.length) throw cancellationErrors[0]
    throwIfAborted(signal)
    if (!response) throw mobileAbortError()
    if (response.status < 200 || response.status >= 300)
      throw new RuntimeApiError(`附件下载失败（HTTP ${response.status}）`, response.status)
    const headers = new Headers(response.headers)
    return {
      filename: attachmentDownloadName(headers.get('content-disposition')),
      mimeType:
        (headers.get('content-type') ?? response.mimeType)?.split(';')[0]?.trim().toLowerCase() ||
        undefined,
    }
  } catch (cause) {
    const errors = [cause, ...((await cancellation) ?? []).filter(error => error !== cause)]
    // Wait for native cancellation before removing any partially written output.
    if (destination.exists) {
      try {
        destination.delete()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 1) throw new AggregateError(errors, '附件下载失败，临时文件清理失败')
    throw cause
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

function attachmentDownloadName(disposition: string | null): string | undefined {
  if (!disposition) return undefined
  const extended = /(?:^|;)\s*filename\*=UTF-8'[^']*'([^;]*)/i.exec(disposition)
  const ordinary = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(disposition)
  const raw = extended
    ? decodeURIComponent(extended[1]!.trim())
    : (ordinary?.[1]?.replace(/\\(.)/g, '$1') ?? ordinary?.[2]?.trim())
  const filename = raw
    ?.split(/[\\/]/)
    .at(-1)
    ?.replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  return filename && filename !== '.' && filename !== '..' ? filename : undefined
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
