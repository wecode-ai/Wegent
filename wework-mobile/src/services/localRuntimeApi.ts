import type { WegentUser } from '@/auth/authClient'
import type {
  Attachment,
  ModelSelectionConfig,
  RuntimeAttachment,
  RuntimeCreateRequest,
  RuntimeCreateResponse,
  RuntimeSendResponse,
  RuntimeTaskAddress,
  RuntimeUploadAsset,
  RequestUserInputResponse,
  RunnerModel,
} from '@/types/runtime'
import {
  buildLocalRuntimeExecutionRequest,
  createRuntimeTurnSeed,
} from '../../../packages/chat-core/src/local-runtime-execution'
import {
  applyRuntimeModelOptionValues,
  isCloudModelType,
  resolveLocalRuntimeModelConfig,
  runtimeReasoningConfig,
} from '../../../packages/chat-core/src/local-runtime-model'
import { requestUserInputResponseText } from '../../../packages/chat-core/src/runtime-user-input'
import { runtimePermissionMode } from '../../../packages/chat-core/src/runtime-permission'
import { localRuntimeFileReference } from '@/domain/localRuntimeFiles'
import type { RuntimeSessionConfig } from './backendConfig'
import type { LocalRuntime } from './localRuntime'
import type { PhoneLocalModelStore } from './phoneLocalModels'

/** The PC's trusted local IPC path, using the phone's workspace and Codex home. */
export class LocalRuntimeApi {
  private nextAttachmentId = -1
  private backendIdentity: string | null = null
  private backendGeneration = 0
  private readonly attachments = new Map<number, Attachment>()

  constructor(
    readonly runtime: LocalRuntime,
    private config: RuntimeSessionConfig | null,
    private readonly getAccessToken: () => string,
    private readonly user: WegentUser,
    private readonly models?: Pick<PhoneLocalModelStore, 'sync'>
  ) {}

  updateBackend(config: RuntimeSessionConfig | null, userId = 0): void {
    const identity = config ? `${config.apiBaseUrl}\0${userId}` : null
    if (identity !== this.backendIdentity) {
      this.backendGeneration += 1
      this.backendIdentity = identity
    }
    this.config = config
  }

  private modelContext(modelType?: string | null) {
    if (!isCloudModelType(modelType)) return null
    if (!this.config) throw new Error('请先登录 Wegent 以使用该模型')
    return { config: this.config, token: this.getAccessToken(), generation: this.backendGeneration }
  }

  private assertModelContext(context: ReturnType<LocalRuntimeApi['modelContext']>): void {
    if (context && context.generation !== this.backendGeneration)
      throw new Error('Wegent 账号已变化，请重新选择模型后发送')
  }

  async listModels(): Promise<{ models: RunnerModel[]; catalog_error?: string | null }> {
    await this.models?.sync(this.runtime)
    const [catalog, accounts] = await Promise.all([
      this.runtime.request<{ models: RunnerModel[]; errors: string[] }>('runtime.runner.catalog'),
      this.runtime.request<{ activeAccountId: string | null }>('runtime.codex.accounts.list'),
    ])
    if (!Array.isArray(catalog.models)) throw new Error('本机返回了无效的模型目录')
    return {
      models: catalog.models.filter(
        model => accounts.activeAccountId || model.provider !== 'openai'
      ),
      catalog_error: catalog.errors?.join(', ') || null,
    }
  }

  async createConversation(data: RuntimeCreateRequest): Promise<RuntimeCreateResponse> {
    this.assertDevice(data.deviceId)
    const context = this.modelContext(data.modelType)
    await this.models?.sync(this.runtime)
    this.assertModelContext(context)
    const source = data.execution?.workspace.source ?? 'local_path'
    const executionRequest = this.executionRequest(
      {
        taskId: data.taskId,
        workspacePath: data.workspacePath,
        title: data.title,
        message: data.message,
        clientUserMessageId: data.clientUserMessageId,
        selection: {
          modelName: data.modelId,
          modelType: data.modelType,
          options: data.modelOptions,
        },
        attachmentIds: data.attachmentIds,
        newSession: true,
        standaloneChatWorkspace: data.standaloneChatWorkspace,
        workspaceSource: source,
        branch: data.execution?.workspace.branch,
      },
      context
    )
    const payload = { ...data, executionRequest }
    // Local attachment IDs only index this adapter; the executor receives guest paths.
    delete payload.attachmentIds
    return this.runtime.requestUserWork(data.taskId, data.title, 'runtime.tasks.create', payload)
  }

  async sendMessage(
    address: RuntimeTaskAddress,
    message: string,
    clientUserMessageId: string,
    selection: ModelSelectionConfig,
    attachmentIds: number[]
  ): Promise<RuntimeSendResponse> {
    this.assertDevice(address.deviceId)
    const context = this.modelContext(selection.modelType)
    await this.models?.sync(this.runtime)
    this.assertModelContext(context)
    const executionRequest = this.executionRequest(
      {
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        title: address.taskId,
        message,
        clientUserMessageId,
        selection,
        attachmentIds,
        newSession: false,
        workspaceSource: 'local_path',
      },
      context
    )
    return this.runtime.requestUserWork(address.taskId, 'Wework 正在执行', 'runtime.tasks.send', {
      address,
      taskId: address.taskId,
      message,
      clientUserMessageId,
      modelSelection: selection,
      executionRequest,
    })
  }

  respondToUserInput(
    address: RuntimeTaskAddress,
    response: RequestUserInputResponse
  ): Promise<RuntimeSendResponse> {
    this.assertDevice(address.deviceId)
    return this.runtime.requestUserWork(address.taskId, 'Wework 正在执行', 'runtime.tasks.send', {
      address,
      taskId: address.taskId,
      message: requestUserInputResponseText(response),
      requestUserInputResponse: response,
    })
  }

  async uploadAttachment(asset: RuntimeUploadAsset): Promise<RuntimeAttachment> {
    if (asset.size && asset.size > 100 * 1024 * 1024) throw new Error('附件不能超过 100 MB')
    const file = await this.runtime.importFile(asset.uri, asset.name)
    const id = this.nextAttachmentId--
    this.attachments.set(id, {
      id,
      filename: asset.name,
      file_size: file.size,
      mime_type: asset.mimeType,
      status: 'ready',
      local_path: file.path,
      file_extension: /\.[^.]+$/.exec(asset.name)?.[0] ?? '',
      created_at: new Date().toISOString(),
    })
    return {
      id,
      filename: asset.name,
      fileSize: file.size,
      mimeType: asset.mimeType,
      localPath: file.path,
      workspaceFile: localRuntimeFileReference(this.runtime.status.deviceId!, file.path),
    }
  }

  private executionRequest(
    input: {
      taskId: string
      workspacePath?: string | null
      title: string
      message: string
      clientUserMessageId: string
      selection: ModelSelectionConfig
      attachmentIds?: number[]
      newSession: boolean
      standaloneChatWorkspace?: boolean
      workspaceSource: 'local_path' | 'git_worktree'
      branch?: string
    },
    context: ReturnType<LocalRuntimeApi['modelContext']>
  ): Record<string, unknown> {
    if (runtimePermissionMode(input.selection.options) !== 'full-access')
      throw new Error(
        '手机执行环境不支持 Linux 只读或工作区沙盒。请明确选择“完整访问”后重试；访问范围仍受 App 沙盒限制。'
      )
    const gateway = context
      ? {
          baseUrl: `${context.config.apiBaseUrl.replace(/\/+$/, '')}/runtime-work/llm-responses-proxy`,
          backendUrl: context.config.backendUrl,
          apiKey: context.token,
        }
      : undefined
    const modelConfig = applyRuntimeModelOptionValues(
      resolveLocalRuntimeModelConfig({
        runtime: 'codex',
        modelName: input.selection.modelName,
        modelType: input.selection.modelType,
        modelOptions: input.selection.options,
        cloudModelGateway: gateway,
      }),
      input.selection.options
    )
    const attachments = (input.attachmentIds ?? []).map(id => {
      const attachment = this.attachments.get(id)
      if (!attachment) throw new Error('附件属于另一台设备或已过期，请在当前设备重新添加')
      return attachment
    })
    return buildLocalRuntimeExecutionRequest({
      ...input,
      runtime: 'codex',
      turnSeed: createRuntimeTurnSeed(),
      modelConfig,
      reasoningConfig: runtimeReasoningConfig(input.selection.options),
      modelOptions: input.selection.options,
      cloudModelGateway: gateway,
      localDeviceId: this.runtime.status.deviceId!,
      attachments,
      user: { id: this.user.id, user_name: this.user.user_name, email: this.user.email ?? '' },
    })
  }

  private assertDevice(deviceId: string): void {
    if (!this.runtime.ownsDevice(deviceId)) throw new Error('任务不属于当前手机执行环境')
  }
}
