import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createExecutorClientFromApis } from '@/api/executorAccess'
import type {
  ArchivedConversationsListRequest,
  ArchivedConversationsListResponse,
  DeleteDeviceWorkspaceRequest,
  DeleteDeviceWorkspaceResponse,
  DeviceCommandResponse,
  DeviceWorkspacePrepareRequest,
  DeviceWorkspacePrepareResponse,
  RuntimeTaskSummary,
  LocalDeviceSkill,
  RuntimeArchiveProjectConversationsRequest,
  RuntimeArchivedConversationBulkRequest,
  RuntimeArchivedConversationBulkResponse,
  RuntimeDeviceWorkspace,
  RuntimeRollbackRequest,
  RuntimeCompactRequest,
  RuntimeFileChangesRevertRequest,
  RuntimeFileChangesRevertResponse,
  RuntimeGuidanceRequest,
  RuntimeGuidanceResponse,
  RuntimeGoalClearRequest,
  RuntimeGoalClearResponse,
  RuntimeGoalGetRequest,
  RuntimeGoalGetResponse,
  RuntimeGoalSetRequest,
  RuntimeGoalSetResponse,
  RuntimeTaskAddress,
  RuntimeTaskArchiveResponse,
  RuntimeTaskCancelResponse,
  RuntimeTaskCreateRequest,
  RuntimeTaskCreateResponse,
  RuntimeTaskForkRequest,
  RuntimeTaskForkResponse,
  RuntimeTaskRenameRequest,
  RuntimeSendRequest,
  RuntimeSendResponse,
  RuntimeTranscriptRequest,
  RuntimeTranscriptResponse,
  RuntimeWorkspaceOpenRequest,
  RuntimeWorkspaceOpenResponse,
  RuntimeWorkspaceRemoveRequest,
  RuntimeWorkspaceRenameRequest,
  RuntimeWorkListResponse,
  RuntimeProjectAppearanceRequest,
  RuntimeProjectActivateRequest,
  RuntimeProjectPinRequest,
  RuntimeProjectReorderRequest,
  RuntimeRemoteProjectsSyncRequest,
  RuntimeProjectTaskReorderRequest,
  RuntimeSidebarMutationResponse,
  RuntimeTaskPinRequest,
  RuntimeWorkSearchRequest,
  RuntimeWorkSearchResponse,
  RuntimeWorkspaceSearchRequest,
  RuntimeWorkspaceSearchResponse,
  RuntimeWorktreeDeleteRequest,
  RuntimeWorktreeListResponse,
  RuntimeWorktreeMutationResponse,
  RuntimeWorktreePrepareRequest,
  RuntimeWorktreeSettings,
  RuntimeWorktreeSettingsPatch,
  Team,
  UnifiedModel,
  User,
} from '@/types/api'
import type { DeviceInfo } from '@/types/devices'
import type {
  WorkspaceFileEntry,
  WorkspaceFileChunkResponse,
  WorkspaceTextFileResponse,
  WorkspaceTreeResponse,
} from '@/types/workspace-files'
import {
  ensureLocalExecutorStarted,
  requestLocalExecutor,
  subscribeLocalExecutorEvents,
  type LocalExecutorEvent,
  type LocalExecutorStatus,
} from '@/tauri/localExecutor'
import { WEWORK_MIN_EXECUTOR_VERSION } from '@/lib/device-capabilities'
import { normalizeModelOptionAliases, normalizeModelOptionValue } from '@/lib/model-ui'
import { requestLocalCodexOfficialModels } from './codexOfficialModels'
import {
  codexModelPickerLabel,
  codexModelPickerSortOrder,
  codexOfficialModelIdFromModelName,
  codexOfficialModelName,
  CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME,
  CODEX_RUNTIME_MODEL_ID,
  type CodexOfficialModel,
} from '@/features/model-settings/codexOfficialModels'
import {
  buildLocalModelRequestUrl,
  findLocalModelConfigByModelName,
  listLocalModelConfigs,
  LOCAL_MODEL_NAME_PREFIX,
  localModelName,
  type LocalModelConfig,
} from '@/features/model-settings/localModelSettings'
import { getLocalProxyUrl } from '@/features/model-settings/localProxySettings'
import { getAppPreferences, type CodexPermissionMode } from '@/tauri/appPreferences'
import { createRuntimeChatStream } from '../runtime/runtimeChatStream'
import { createLocalAttachmentApi } from './localAttachments'
import { LOCAL_USER, saveLocalUserPreferences } from './localSession'
import type { KeybindingOverride } from '@/lib/keybindings'
import {
  CLOUD_MODEL_CONTEXT_WINDOW_OPTION,
  CLOUD_MODEL_NAMESPACE_OPTION,
  CLOUD_MODEL_RESOURCE_USER_ID_OPTION,
} from '@/features/workbench/runtimeModelSelection'

const LOCAL_DEVICE_ID = 'local-device'

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function isRuntimeDebugEnabled(): boolean {
  return globalThis.localStorage?.getItem('wework:debug-runtime') === '1'
}

const OPENAI_RESPONSES_PROTOCOL = 'openai-responses'
const RESPONSES_API_FORMAT = 'responses'
const WORKSPACE_TEXT_FILE_MAX_OUTPUT_BYTES = 1024 * 1024 * 2
const STALE_CODEX_PROVIDER_MODEL_PREFIX = 'codex-provider:'

export const LOCAL_WORKBENCH_TEAM = {
  id: 0,
  name: 'local-wework',
  displayName: 'Local WeWork',
  is_active: true,
  default_for_modes: ['wework'],
  recommended_mode: 'code',
} satisfies Team

function localCodexModelFamily(model: CodexOfficialModel): string {
  if (model.providerType !== 'provider') return 'codex-official'
  return `codex-provider:${encodeURIComponent(model.providerId.toLowerCase())}`
}

function localCodexModel(model: CodexOfficialModel, codexAuthConfigured: boolean): UnifiedModel {
  const modelFamily = localCodexModelFamily(model)
  const providerFamilyLabel = model.providerType === 'provider' ? model.providerName : undefined
  const modelLabel = codexModelPickerLabel(model.modelId)
  return {
    name: codexOfficialModelName(model),
    type: 'runtime',
    displayName: modelLabel,
    provider: 'local',
    modelId: model.modelId,
    config: {
      protocol: OPENAI_RESPONSES_PROTOCOL,
      apiFormat: RESPONSES_API_FORMAT,
      weworkModelKind: model.providerType === 'provider' ? 'codex-provider' : 'codex-official',
      codexAuthConfigured,
      codexOfficialModelId: model.id,
      codexProviderId: model.providerId,
      codexProviderName: model.providerName,
      codexProviderType: model.providerType,
      ui: {
        family: modelFamily,
        ...(providerFamilyLabel ? { familyLabel: providerFamilyLabel } : {}),
        modelLabel,
        reasoningEfforts: model.supportedReasoningEfforts,
        defaultReasoningEffort: model.defaultReasoningEffort,
        controls: ['speed'],
        sortOrder:
          (model.providerType === 'provider' ? 100 : 0) + codexModelPickerSortOrder(model.modelId),
      },
    },
    runtime: {
      family: 'openai.openai-responses',
      provider: 'local',
    },
    isActive: true,
  }
}

function unavailableCodexModel(message: string): UnifiedModel {
  return {
    name: CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME,
    type: 'runtime',
    displayName: 'CodeX 模型不可用',
    provider: 'local',
    modelId: null,
    config: {
      protocol: OPENAI_RESPONSES_PROTOCOL,
      apiFormat: RESPONSES_API_FORMAT,
      weworkModelKind: 'codex-official',
      codexAuthConfigured: false,
      unavailableReason: message,
      ui: {
        family: 'codex-official',
        modelLabel: 'CodeX 模型不可用',
        controls: [],
        sortOrder: 10,
      },
    },
    runtime: {
      family: 'openai.openai-responses',
      provider: 'local',
    },
    isActive: false,
    compatibilityDisabled: true,
    compatibilityDisabledReason: 'unavailable',
  }
}

function localModelConfigToUnifiedModel(config: LocalModelConfig): UnifiedModel {
  const group = config.group?.trim()
  const family = group
    ? `model-interface:${encodeURIComponent(group.toLowerCase())}`
    : 'model-interface'
  return {
    name: localModelName(config),
    type: 'runtime',
    displayName: config.displayName,
    provider: 'local',
    modelId: config.modelId,
    config: {
      protocol: OPENAI_RESPONSES_PROTOCOL,
      apiFormat: config.apiFormat,
      upstreamApiFormat: config.apiFormat,
      ...(config.contextWindow ? { model_context_window: config.contextWindow } : {}),
      ui: {
        family,
        ...(group ? { familyLabel: group } : {}),
        modelLabel: config.displayName,
        controls: ['speed'],
        sortOrder: 20,
      },
      weworkModelKind: 'model-interface',
    },
    runtime: {
      family: 'openai.openai-responses',
      provider: 'local',
    },
    isActive: config.enabled,
  }
}

function localRuntimeModels(
  codexOfficialModels: CodexOfficialModel[] = [],
  codexOfficialError: string | null = null,
  codexAuthConfigured = false
): UnifiedModel[] {
  const officialModels =
    codexOfficialError || codexOfficialModels.length === 0
      ? [
          unavailableCodexModel(
            codexOfficialError || 'Codex model list returned no available models'
          ),
        ]
      : codexOfficialModels.map(model => localCodexModel(model, codexAuthConfigured))

  return [
    ...officialModels,
    ...listLocalModelConfigs()
      .filter(config => config.enabled)
      .map(localModelConfigToUnifiedModel),
  ]
}

interface LocalAppServicesDeps {
  ensure?: () => Promise<LocalExecutorStatus>
  request?: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
  subscribe?: (handler: (event: LocalExecutorEvent) => void) => Promise<() => void>
  cloudModelGateway?: CloudModelGateway
}

interface CloudModelGateway {
  baseUrl: string
  apiKey: string
}

interface RuntimeWorkIpcOptions {
  resolveDeviceId?: (data?: Record<string, unknown>) => Promise<string>
  normalizeDeviceRecord?: <T extends Record<string, unknown>>(data: T, deviceId: string) => T
  adaptListResponse?: (response: unknown, deviceId: string) => RuntimeWorkListResponse
  cloudModelGateway?: CloudModelGateway
  transportLabel?: 'Local' | 'Cloud'
}

function cloudConnectionRequired(name: string): never {
  throw new Error(`${name} requires cloud connection`)
}

function localDeviceFromStatus(status: LocalExecutorStatus): DeviceInfo {
  const online = status.running && status.ready !== false && !status.error
  const device = {
    id: 0,
    device_id: status.deviceId || LOCAL_DEVICE_ID,
    name: 'Local Executor',
    status: online ? ('online' as const) : ('offline' as const),
    is_default: true,
    device_type: 'local' as const,
    runtime_instance_id: status.runtimeInstanceId ?? null,
    capabilities: ['runtime-work', 'device-commands'],
    slot_used: 0,
    slot_max: 5,
    executor_version:
      (status as LocalExecutorStatus & { version?: string }).version ?? WEWORK_MIN_EXECUTOR_VERSION,
    latest_version: null,
    update_available: false,
    error: status.error ?? null,
    bind_shell: 'claudecode' as const,
    runtime_transfer_host: null,
  }
  return device
}

function localDeviceIdFromStatus(status: LocalExecutorStatus | null | undefined): string {
  return status?.deviceId?.trim() || LOCAL_DEVICE_ID
}

function isCloudModelType(modelType?: string | null): modelType is 'public' | 'user' | 'group' {
  return modelType === 'public' || modelType === 'user' || modelType === 'group'
}

function localExecutorErrorStatus(error: unknown): LocalExecutorStatus {
  return {
    running: false,
    ready: false,
    deviceId: LOCAL_DEVICE_ID,
    error:
      error instanceof Error ? error.message : String(error || 'Local executor is unavailable'),
  }
}

function commandText(response: DeviceCommandResponse): string {
  const output = Array.isArray(response.stdout)
    ? response.stdout.join('\n')
    : typeof response.stdout === 'string'
      ? response.stdout
      : JSON.stringify(response.stdout ?? '')
  return output.trim()
}

function commandStringList(response: DeviceCommandResponse): string[] {
  return Array.isArray(response.stdout)
    ? response.stdout.filter((item): item is string => typeof item === 'string')
    : []
}

function commandSkills(response: DeviceCommandResponse): LocalDeviceSkill[] {
  const output = typeof response.stdout === 'string' ? JSON.parse(response.stdout) : response.stdout
  return Array.isArray(output)
    ? sortSkillsByName(
        dedupeSkillsByName(
          output.filter(
            (item): item is LocalDeviceSkill =>
              typeof item === 'object' && item !== null && 'name' in item && 'path' in item
          )
        )
      )
    : []
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

function assertCommandSuccess(response: DeviceCommandResponse, fallback: string): void {
  if (!response.success) {
    throw new Error(response.error || response.stderr || fallback)
  }
}

function stableLocalId(value: string): number {
  let hash = 0
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return (hash % 1_000_000_000) + 1
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function idValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function timestampValue(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return stringValue(value)
}

function modelSelectionValue(value: unknown) {
  const selection = recordValue(value)
  const modelName = stringValue(selection.modelName) ?? stringValue(selection.model_name)
  if (!modelName) return null
  const modelType = stringValue(selection.modelType) ?? stringValue(selection.model_type)
  const options = recordValue(selection.options)
  return {
    modelName,
    modelType: modelType || null,
    options: Object.fromEntries(
      Object.entries(options)
        .map(([key, optionValue]) => [key, stringValue(optionValue)])
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
    ),
  }
}

function runtimeAddressDebug(value: Record<string, unknown>): Record<string, unknown> {
  const address = recordValue(value.address)
  return {
    deviceId: stringValue(value.deviceId) ?? stringValue(address.deviceId),
    taskId: idValue(value.taskId) ?? idValue(address.taskId),
    workspacePath: stringValue(value.workspacePath) ?? stringValue(address.workspacePath),
  }
}

function runtimeHandleDebug(value: Record<string, unknown>): Record<string, unknown> {
  const handle = recordValue(value.runtimeHandle ?? value.runtime_handle)
  return {
    present: Object.keys(handle).length > 0,
    keys: Object.keys(handle).sort(),
    hasSessionId: Boolean(
      stringValue(handle.sessionId) ??
      stringValue(handle.session_id) ??
      stringValue(handle.threadId) ??
      stringValue(handle.thread_id) ??
      stringValue(handle.conversationId) ??
      stringValue(handle.conversation_id)
    ),
  }
}

function runtimeTranscriptMessageCount(response: unknown): number | null {
  const responseRecord = recordValue(response)
  const messages = responseRecord.messages
  return Array.isArray(messages) ? messages.length : null
}

function workspaceLabel(workspacePath: string, label: unknown): string {
  const explicitLabel = stringValue(label)
  if (explicitLabel) return explicitLabel
  return workspacePath.split('/').filter(Boolean).at(-1) || workspacePath
}

function localRuntimeProjectWorkspacePath(runtimeProjectKey?: string | null): string | null {
  const key = runtimeProjectKey?.trim()
  if (!key) return null
  if (key.startsWith('local:')) return key.slice('local:'.length).trim() || null
  if (key.startsWith('/') || key.startsWith('~') || /^[A-Za-z]:[\\/]/.test(key)) return key
  return null
}

function normalizeLocalArchiveProjectRequest(
  data: RuntimeArchiveProjectConversationsRequest
): RuntimeArchiveProjectConversationsRequest & { workspacePath?: string } {
  const workspacePath = localRuntimeProjectWorkspacePath(data.runtimeProjectKey)
  return workspacePath ? { ...data, workspacePath } : data
}

function normalizeRuntimeTaskSummary(
  task: unknown,
  fallbackWorkspacePath: string
): RuntimeTaskSummary | null {
  const taskRecord = recordValue(task)
  const taskId = idValue(taskRecord.taskId) ?? idValue(taskRecord.task_id)
  if (!taskId) return null

  const workspacePath =
    stringValue(taskRecord.workspacePath) ??
    stringValue(taskRecord.workspace_path) ??
    stringValue(taskRecord.projectWorkspacePath) ??
    stringValue(taskRecord.project_workspace_path) ??
    stringValue(taskRecord.cwd) ??
    stringValue(taskRecord.path) ??
    fallbackWorkspacePath
  const workspaceKind =
    stringValue(taskRecord.workspaceKind) ?? stringValue(taskRecord.workspace_kind)
  const worktreeId = stringValue(taskRecord.worktreeId) ?? stringValue(taskRecord.worktree_id)
  const createdAt = timestampValue(taskRecord.createdAt) ?? timestampValue(taskRecord.created_at)
  const updatedAt = timestampValue(taskRecord.updatedAt) ?? timestampValue(taskRecord.updated_at)
  const gitInfo = taskRecord.gitInfo ?? taskRecord.git_info
  const runtimeHandle = recordValue(taskRecord.runtimeHandle ?? taskRecord.runtime_handle)
  const modelSelection =
    modelSelectionValue(taskRecord.modelSelection ?? taskRecord.model_selection) ??
    modelSelectionValue(runtimeHandle.modelSelection ?? runtimeHandle.model_selection)

  const normalized = {
    ...taskRecord,
    taskId,
    threadId: stringValue(taskRecord.threadId) ?? stringValue(taskRecord.thread_id) ?? undefined,
    ...(taskId ? { taskId } : {}),
    workspacePath,
    title: stringValue(taskRecord.title) ?? taskId ?? String(taskId),
    runtime: stringValue(taskRecord.runtime) ?? 'codex',
    ...(workspaceKind ? { workspaceKind } : {}),
    ...(worktreeId ? { worktreeId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(gitInfo !== undefined ? { gitInfo } : {}),
    ...(Object.keys(runtimeHandle).length > 0 ? { runtimeHandle } : {}),
    ...(modelSelection ? { modelSelection } : {}),
  }

  return normalized as RuntimeTaskSummary
}

function normalizeRuntimeTaskSummaries(
  tasks: unknown,
  fallbackWorkspacePath: string
): RuntimeTaskSummary[] {
  if (!Array.isArray(tasks)) return []
  const normalizedTasks = tasks
    .map(task => normalizeRuntimeTaskSummary(task, fallbackWorkspacePath))
    .filter((task): task is RuntimeTaskSummary => task !== null)
  if (tasks.length > 0 && normalizedTasks.length === 0) {
    console.warn('[Wework] Dropped runtime tasks without taskId', {
      workspacePath: fallbackWorkspacePath,
      count: tasks.length,
      firstTaskKeys: Object.keys(recordValue(tasks[0])).sort(),
    })
  }
  return normalizedTasks
}

function createRuntimeExecutionIds(data: RuntimeTaskCreateRequest): [string, string] {
  const seed = data.taskId || `${data.runtime}:${data.workspacePath ?? ''}:${data.message}`
  return createRuntimeExecutionIdsFromSeed(seed)
}

function createRuntimeExecutionIdsFromSeed(seed: string): [string, string] {
  const taskId = `runtime-${stableLocalId(seed)}`
  return [taskId, `${taskId}-0`]
}

function createRuntimeTurnSeed(): number {
  return Math.floor(Date.now() * 1000 + Math.floor(Math.random() * 1000))
}

function runtimeTaskTitle(data: RuntimeTaskCreateRequest): string {
  const title = data.title?.trim()
  if (title) return title
  const firstLine = data.message.trim().split(/\r?\n/)[0] ?? ''
  return firstLine.slice(0, 80) || 'Untitled runtime task'
}

function runtimeWorkspacePath(data: RuntimeTaskCreateRequest): string | null {
  const explicitPath = stringValue(data.workspacePath)
  if (explicitPath) return explicitPath
  const execution = recordValue(data.execution)
  const workspace = recordValue(execution.workspace)
  return stringValue(workspace.path)
}

type LocalRuntimeWorkspaceSource = 'local_path' | 'git_worktree'

function runtimeWorkspaceSource(data: RuntimeTaskCreateRequest): LocalRuntimeWorkspaceSource {
  const execution = recordValue(data.execution)
  const workspace = recordValue(execution.workspace)
  return stringValue(workspace.source) === 'git_worktree' ? 'git_worktree' : 'local_path'
}

function runtimeWorkspaceBranch(data: RuntimeTaskCreateRequest): string | null {
  const execution = recordValue(data.execution)
  const workspace = recordValue(execution.workspace)
  return stringValue(workspace.branch)
}

function requiredRuntimeWorkspacePath(data: RuntimeTaskCreateRequest): string {
  const workspacePath = runtimeWorkspacePath(data)
  if (!workspacePath) {
    throw new Error('workspacePath is required')
  }
  return workspacePath
}

function builtInCodexModelId(modelId?: string): string {
  if (modelId === CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME) {
    throw new Error('Codex model list is unavailable')
  }
  return codexOfficialModelIdFromModelName(modelId) ?? modelId ?? CODEX_RUNTIME_MODEL_ID
}

function runtimeReasoning(modelOptions?: Record<string, string>): Record<string, string> | null {
  const reasoning = normalizeModelOptionValue('reasoning', modelOptions?.reasoning)
  const summary = modelOptions?.summary
  const result: Record<string, string> = {}
  if (reasoning) result.effort = reasoning
  if (summary) result.summary = summary
  return Object.keys(result).length > 0 ? result : null
}

function runtimeServiceTier(modelOptions?: Record<string, string>): string | null {
  return modelOptions?.speed || modelOptions?.service_tier || null
}

function runtimeCollaborationMode(modelOptions?: Record<string, string>): string | null {
  return modelOptions?.collaborationMode || modelOptions?.collaboration_mode || null
}

function providerIdFromLocalConfig(config: LocalModelConfig): string {
  return `local-${config.id}`.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'local'
}

function localRuntimeModelConfig(
  modelName?: string,
  modelType?: string | null,
  modelOptions?: Record<string, string>,
  cloudModelGateway?: CloudModelGateway
): Record<string, unknown> {
  const localModel = findLocalModelConfigByModelName(modelName)
  if (localModel) {
    if (!localModel.enabled) {
      throw new Error('Local model is disabled')
    }
    const requestUrl = buildLocalModelRequestUrl(
      localModel.baseUrl,
      localModel.requestPath,
      localModel.apiFormat
    )
    return {
      model: 'openai',
      model_id: localModel.modelId,
      api_format: RESPONSES_API_FORMAT,
      upstream_api_format: localModel.apiFormat,
      protocol: OPENAI_RESPONSES_PROTOCOL,
      base_url: localModel.baseUrl,
      responses_url: requestUrl,
      api_key: localModel.apiKey || 'dummy',
      model_provider: providerIdFromLocalConfig(localModel),
      provider_name: localModel.displayName,
      display_name: localModel.displayName,
      ...(localModel.contextWindow ? { model_context_window: localModel.contextWindow } : {}),
      web_search: localModel.webSearchMode ?? 'disabled',
      image_generation: localModel.imageGenerationEnabled === true,
      codex_responses_compat_proxy: true,
      runtime_config: {
        codex: {
          use_user_config: false,
          configured: false,
        },
      },
    }
  }

  if (modelName?.startsWith(LOCAL_MODEL_NAME_PREFIX)) {
    throw new Error('Local model is no longer configured')
  }

  if (modelName?.startsWith(STALE_CODEX_PROVIDER_MODEL_PREFIX)) {
    throw new Error('Codex config.toml provider is no longer configured')
  }

  if (isCloudModelType(modelType)) {
    if (!modelName || !cloudModelGateway) {
      throw new Error('Cloud model gateway is not configured')
    }
    const namespace = modelOptions?.[CLOUD_MODEL_NAMESPACE_OPTION]
    const resourceUserId = modelOptions?.[CLOUD_MODEL_RESOURCE_USER_ID_OPTION]
    if (!namespace || !resourceUserId || !/^\d+$/.test(resourceUserId)) {
      throw new Error('Cloud model identity is incomplete')
    }
    const contextWindow = Number(modelOptions?.[CLOUD_MODEL_CONTEXT_WINDOW_OPTION])
    return {
      model: 'openai',
      model_id: modelName,
      api_format: RESPONSES_API_FORMAT,
      protocol: OPENAI_RESPONSES_PROTOCOL,
      base_url: cloudModelGateway.baseUrl,
      api_key: cloudModelGateway.apiKey,
      default_headers: {
        'X-Wegent-Model-Type': modelType,
        'X-Wegent-Model-Namespace': namespace,
        'X-Wegent-Model-User-Id': resourceUserId,
      },
      ...(Number.isFinite(contextWindow) && contextWindow > 0
        ? { model_context_window: contextWindow }
        : {}),
      codex_responses_compat_proxy: true,
      runtime_config: {
        codex: {
          use_user_config: false,
          configured: true,
        },
      },
    }
  }

  const codexProviderId = modelOptions?.codexProviderId || modelOptions?.codex_model_provider
  const codexProviderName = modelOptions?.codexProviderName || modelOptions?.codex_provider_name
  return {
    model: 'openai',
    model_id: builtInCodexModelId(modelName),
    api_format: RESPONSES_API_FORMAT,
    protocol: OPENAI_RESPONSES_PROTOCOL,
    ...(codexProviderId ? { model_provider: codexProviderId } : {}),
    ...(codexProviderName ? { provider_name: codexProviderName } : {}),
    runtime_config: {
      codex: {
        use_user_config: true,
        configured: true,
      },
    },
  }
}

function applyLocalProxyConfig(modelConfig: Record<string, unknown>): Record<string, unknown> {
  const proxyUrl = getLocalProxyUrl().trim()
  if (!proxyUrl) return modelConfig

  const runtimeConfig = {
    ...((modelConfig.runtime_config as Record<string, unknown> | undefined) ?? {}),
  }
  const codexRuntimeConfig = {
    ...((runtimeConfig.codex as Record<string, unknown> | undefined) ?? {}),
    use_proxy: true,
    proxy_configured: true,
  }

  return {
    ...modelConfig,
    proxy: {
      url: proxyUrl,
    },
    runtime_config: {
      ...runtimeConfig,
      codex: codexRuntimeConfig,
    },
  }
}

function applyRuntimeModelOptions(
  modelConfig: Record<string, unknown>,
  modelOptions?: Record<string, string>
): Record<string, unknown> {
  modelConfig = applyLocalProxyConfig(modelConfig)
  const reasoning = runtimeReasoning(modelOptions)
  if (reasoning) modelConfig.reasoning = reasoning
  const serviceTier = runtimeServiceTier(modelOptions)
  if (serviceTier) modelConfig.service_tier = serviceTier
  return modelConfig
}

type LocalRuntimeAttachmentPayload = Record<string, unknown> & {
  id: number
  filename: string
  original_filename: string
  file_size: number
  mime_type: string
  subtask_id: string
  file_extension: string
  local_path: string
  local_preview_url: string
  text_length?: number
  text_preview?: string
}

function localRuntimeAttachments(
  attachments: RuntimeTaskCreateRequest['attachments'],
  subtaskId: string
): Record<string, unknown>[] {
  if (!attachments?.length) return []
  const runtimeAttachments: LocalRuntimeAttachmentPayload[] = []

  attachments.forEach(attachment => {
    const localPath = stringValue(attachment.local_path)
    if (!localPath) return

    runtimeAttachments.push({
      id: attachment.id,
      filename: attachment.filename,
      original_filename: attachment.filename,
      file_size: attachment.file_size,
      mime_type: attachment.mime_type,
      subtask_id: attachment.subtask_id ?? subtaskId,
      file_extension: attachment.file_extension,
      local_path: localPath,
      local_preview_url: attachment.local_preview_url ?? localPath,
      ...(attachment.text_length != null ? { text_length: attachment.text_length } : {}),
      ...(attachment.text_preview ? { text_preview: attachment.text_preview } : {}),
    })
  })

  return runtimeAttachments
}

function skillName(skill: unknown): string | null {
  if (typeof skill === 'string') return skill
  const skillRecord = recordValue(skill)
  return stringValue(skillRecord.name)
}

function isNonEmptyString(value: string | null): value is string {
  return Boolean(value)
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

function requireWorkspacePathWithin(path: string, rootPath: string, errorMessage: string) {
  if (!isWorkspacePathWithin(path, rootPath)) {
    throw new Error(errorMessage)
  }
}

function normalizeModifiedAt(value: unknown, errorMessage: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  throw new Error(errorMessage)
}

function normalizeWorkspaceEntry(
  value: unknown,
  responseRootPath: string,
  requestedRootPath: string
): WorkspaceFileEntry {
  const record = recordValue(value)
  if (
    typeof record.name !== 'string' ||
    typeof record.path !== 'string' ||
    typeof record.is_directory !== 'boolean' ||
    typeof record.size !== 'number'
  ) {
    throw new Error('Invalid workspace tree response')
  }
  const path = normalizeAbsoluteWorkspacePath(record.path, 'Invalid workspace tree response')
  requireWorkspacePathWithin(path, responseRootPath, 'Invalid workspace tree response')
  const requestedPath = `${requestedRootPath}${path.slice(responseRootPath.length)}`
  return {
    name: record.name,
    path: requestedPath,
    isDirectory: record.is_directory,
    size: record.size,
    modifiedAt: normalizeModifiedAt(record.modified_at, 'Invalid workspace tree response'),
  }
}

function normalizeWorkspaceTree(output: unknown, requestedPath: string): WorkspaceTreeResponse {
  const normalizedRequestedPath = normalizeAbsoluteWorkspacePath(
    requestedPath,
    'Workspace path must be absolute'
  )
  const record = recordValue(output)
  if (typeof record.path !== 'string' || !Array.isArray(record.entries)) {
    throw new Error('Invalid workspace tree response')
  }
  const path = normalizeAbsoluteWorkspacePath(record.path, 'Invalid workspace tree response')
  if (path.split('/').pop() !== normalizedRequestedPath.split('/').pop()) {
    throw new Error('Invalid workspace tree response')
  }
  return {
    path: normalizedRequestedPath,
    entries: record.entries.map(entry =>
      normalizeWorkspaceEntry(entry, path, normalizedRequestedPath)
    ),
  }
}

function normalizeWorkspaceTextFile(
  output: unknown,
  requestedFilePath: string
): WorkspaceTextFileResponse {
  const normalizedRequestedFilePath = normalizeAbsoluteWorkspacePath(
    requestedFilePath,
    'Workspace file path must be absolute'
  )
  const record = recordValue(output)
  if (
    typeof record.path !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.content !== 'string' ||
    typeof record.truncated !== 'boolean' ||
    typeof record.size !== 'number'
  ) {
    throw new Error('Invalid workspace text file response')
  }
  const responsePath = normalizeAbsoluteWorkspacePath(
    record.path,
    'Invalid workspace text file response'
  )
  const requestedName = normalizedRequestedFilePath.split('/').pop()
  if (record.name !== requestedName || responsePath.split('/').pop() !== requestedName) {
    throw new Error('Invalid workspace text file response')
  }
  return {
    path: normalizedRequestedFilePath,
    name: record.name,
    content: record.content,
    editable: record.editable === true && typeof record.revision === 'string',
    revision: typeof record.revision === 'string' ? record.revision : '',
    truncated: record.truncated,
    size: record.size,
    modifiedAt: normalizeModifiedAt(record.modified_at, 'Invalid workspace text file response'),
  }
}

function normalizeWorkspaceFileChunk(
  output: unknown,
  requestedFilePath: string,
  requestedOffset: number
): WorkspaceFileChunkResponse {
  const normalizedRequestedFilePath = normalizeAbsoluteWorkspacePath(
    requestedFilePath,
    'Workspace file path must be absolute'
  )
  const record = recordValue(output)
  if (
    typeof record.path !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.content_base64 !== 'string' ||
    typeof record.offset !== 'number' ||
    typeof record.eof !== 'boolean' ||
    typeof record.size !== 'number'
  ) {
    throw new Error('Invalid workspace file chunk response')
  }
  const responsePath = normalizeAbsoluteWorkspacePath(
    record.path,
    'Invalid workspace file chunk response'
  )
  const requestedName = normalizedRequestedFilePath.split('/').pop()
  if (
    record.name !== requestedName ||
    responsePath.split('/').pop() !== requestedName ||
    record.offset !== requestedOffset
  ) {
    throw new Error('Invalid workspace file chunk response')
  }
  return {
    path: normalizedRequestedFilePath,
    name: record.name,
    contentBase64: record.content_base64,
    offset: record.offset,
    eof: record.eof,
    size: record.size,
    modifiedAt: normalizeModifiedAt(record.modified_at, 'Invalid workspace file chunk response'),
  }
}

function splitAbsoluteWorkspaceFilePath(filePath: string): {
  parentPath: string
  fileName: string
} {
  const normalizedFilePath = normalizeAbsoluteWorkspacePath(
    filePath,
    'Workspace file path must be absolute'
  )
  const separatorIndex = normalizedFilePath.lastIndexOf('/')
  const parentPath = separatorIndex > 0 ? normalizedFilePath.slice(0, separatorIndex) : '/'
  const fileName =
    separatorIndex >= 0 ? normalizedFilePath.slice(separatorIndex + 1) : normalizedFilePath
  if (!fileName) {
    throw new Error('Workspace file name is required')
  }
  return { parentPath, fileName }
}

interface LocalRuntimeWorkspace {
  workspacePath: string
  workspaceSource: LocalRuntimeWorkspaceSource
  branch: string | null
}

function executionWithWorkspace(
  data: RuntimeTaskCreateRequest,
  workspace: LocalRuntimeWorkspace
): RuntimeTaskCreateRequest['execution'] {
  if (workspace.workspaceSource !== 'git_worktree') {
    return data.execution
  }

  const execution = recordValue(data.execution)
  const executionWorkspace = recordValue(execution.workspace)
  const workspaceRequest = { ...executionWorkspace }
  if (!workspace.branch) {
    delete workspaceRequest.branch
  }
  return {
    ...execution,
    workspace: {
      ...workspaceRequest,
      source: workspace.workspaceSource,
      path: workspace.workspacePath,
      ...(workspace.branch ? { branch: workspace.branch } : {}),
    },
  } as RuntimeTaskCreateRequest['execution']
}

interface BuildLocalRuntimeExecutionRequestInput {
  taskId?: string | null
  runtime: string
  teamId: number
  title: string
  message: string
  turnSeed: number
  modelId?: string
  modelType?: string | null
  modelOptions?: RuntimeTaskCreateRequest['modelOptions']
  cloudModelGateway?: CloudModelGateway
  additionalSkills?: RuntimeTaskCreateRequest['additionalSkills']
  attachments?: RuntimeTaskCreateRequest['attachments']
  localDeviceId: string
  workspacePath?: string | null
  workspaceSource: LocalRuntimeWorkspaceSource
  branch?: string | null
  newSession: boolean
  clientMessageId?: string
  ephemeral?: boolean
  permissionMode?: CodexPermissionMode
}

function buildLocalRuntimeExecutionRequest(
  input: BuildLocalRuntimeExecutionRequestInput
): Record<string, unknown> {
  const baseSeed = input.taskId || `${input.runtime}:${input.workspacePath ?? ''}:${input.message}`
  const [derivedTaskId, subtaskId] = createRuntimeExecutionIdsFromSeed(
    input.newSession ? baseSeed : `${baseSeed}:${input.turnSeed}`
  )
  const taskId = input.taskId || derivedTaskId
  const modelConfig = applyRuntimeModelOptions(
    localRuntimeModelConfig(
      input.modelId,
      input.modelType,
      input.modelOptions,
      input.cloudModelGateway
    ),
    input.modelOptions
  )
  const reasoning = runtimeReasoning(input.modelOptions)
  const collaborationMode = runtimeCollaborationMode(input.modelOptions)
  const skillNames = (input.additionalSkills ?? []).map(skillName).filter(isNonEmptyString)
  const workspaceProject = input.workspacePath
    ? {
        source: input.workspaceSource,
        path: input.workspacePath,
        ...(input.branch ? { branch: input.branch } : {}),
      }
    : null

  return {
    task_id: taskId,
    subtask_id: subtaskId,
    team_id: input.teamId,
    team_name: LOCAL_WORKBENCH_TEAM.name,
    team_namespace: 'default',
    task_title: input.title,
    subtask_title: `${input.title} - Assistant`,
    user: {
      id: LOCAL_USER.id,
      name: LOCAL_USER.user_name,
      user_name: LOCAL_USER.user_name,
      email: LOCAL_USER.email,
    },
    user_id: LOCAL_USER.id,
    user_name: LOCAL_USER.user_name,
    bot: [],
    model_config: modelConfig,
    prompt: input.message,
    enable_tools: true,
    enable_deep_thinking: true,
    skill_names: skillNames,
    preload_skills: input.additionalSkills ?? [],
    user_selected_skills: input.additionalSkills ?? [],
    ...(workspaceProject
      ? {
          workspace: {
            project: workspaceProject,
          },
          workspace_source: input.workspaceSource,
          project_workspace_path: input.workspacePath,
        }
      : {}),
    execution_target_type: 'local',
    device_id: input.localDeviceId,
    new_session: input.newSession,
    ...(input.clientMessageId ? { client_user_message_id: input.clientMessageId } : {}),
    ephemeral: Boolean(input.ephemeral),
    is_group_chat: false,
    collaboration_model: 'single',
    ...(collaborationMode ? { collaborationMode } : {}),
    mode: 'code',
    task_mode: 'code',
    attachments: localRuntimeAttachments(input.attachments, subtaskId),
    reasoning_config: reasoning,
    permission_mode: input.permissionMode ?? 'full_access',
  }
}

type RequestWithLocalDevice = <TResponse, TRequest extends object>(
  method: string,
  data: TRequest
) => Promise<TResponse>

async function executeLocalDeviceCommand(
  requestWithLocalDevice: RequestWithLocalDevice,
  data: {
    deviceId?: string
    command_key: string
    args?: string[]
    timeout_seconds?: number
    max_output_bytes?: number
  },
  fallback: string
): Promise<DeviceCommandResponse> {
  const response = await requestWithLocalDevice<DeviceCommandResponse, typeof data>(
    'device.execute_command',
    { deviceId: LOCAL_DEVICE_ID, ...data }
  )
  assertCommandSuccess(response, fallback)
  return response
}

async function loadLocalCodexAuthConfigured(
  request: LocalAppServicesDeps['request']
): Promise<boolean> {
  if (!request) return false
  try {
    const response = await request<DeviceCommandResponse>('device.execute_command', {
      command_key: 'runtime_auth_status',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    return response.success === true && recordValue(response.stdout).exists === true
  } catch {
    return false
  }
}

async function prepareLocalRuntimeWorkspace(
  data: RuntimeTaskCreateRequest,
  requestWithLocalDevice: RequestWithLocalDevice
): Promise<LocalRuntimeWorkspace> {
  const sourceWorkspacePath = requiredRuntimeWorkspacePath(data)
  const requestedSource = runtimeWorkspaceSource(data)
  const branch = runtimeWorkspaceBranch(data)
  if (requestedSource !== 'git_worktree') {
    return {
      workspacePath: sourceWorkspacePath,
      workspaceSource: 'local_path',
      branch: null,
    }
  }

  const gitCheck = await executeLocalDeviceCommand(
    requestWithLocalDevice,
    {
      command_key: 'git_is_worktree',
      args: [sourceWorkspacePath],
      timeout_seconds: 15,
    },
    'Project directory is not a Git repository'
  )
  if (commandText(gitCheck) !== 'true') {
    throw new Error('Project directory is not a Git repository')
  }

  const [taskId] = createRuntimeExecutionIds(data)
  const response = await requestWithLocalDevice<
    RuntimeWorktreeMutationResponse,
    RuntimeWorktreePrepareRequest
  >('runtime.worktrees.prepare', {
    deviceId: data.deviceId ?? LOCAL_DEVICE_ID,
    sourcePath: sourceWorkspacePath,
    worktreeId: taskId,
    ...(branch ? { ref: branch } : {}),
  })

  return {
    workspacePath: response.path ?? response.worktree.path,
    workspaceSource: 'git_worktree',
    branch,
  }
}

async function createLocalRuntimeTaskPayload(
  data: RuntimeTaskCreateRequest,
  localDeviceId: string,
  requestWithLocalDevice: RequestWithLocalDevice,
  cloudModelGateway?: CloudModelGateway
): Promise<Record<string, unknown>> {
  const runtimeWorkspace = await prepareLocalRuntimeWorkspace(data, requestWithLocalDevice)
  const execution = executionWithWorkspace(data, runtimeWorkspace)
  const normalizedData: RuntimeTaskCreateRequest = {
    ...data,
    deviceId: localDeviceId,
    workspacePath: runtimeWorkspace.workspacePath,
    ...(data.modelOptions ? { modelOptions: normalizeModelOptionAliases(data.modelOptions) } : {}),
  }
  if (execution) normalizedData.execution = execution
  const collaborationMode = runtimeCollaborationMode(normalizedData.modelOptions)
  const permissionMode =
    normalizedData.permissionMode ?? (await getAppPreferences()).defaultCodexPermissionMode
  const turnSeed = createRuntimeTurnSeed()
  const payload = { ...normalizedData } as Record<string, unknown>

  return {
    ...payload,
    ...(collaborationMode ? { collaborationMode } : {}),
    title: runtimeTaskTitle(normalizedData),
    executionRequest: buildLocalRuntimeExecutionRequest({
      taskId: normalizedData.taskId,
      runtime: normalizedData.runtime,
      teamId: normalizedData.teamId,
      title: runtimeTaskTitle(normalizedData),
      message: normalizedData.message,
      turnSeed,
      modelId: normalizedData.modelId,
      modelType: normalizedData.modelType,
      modelOptions: normalizedData.modelOptions,
      cloudModelGateway,
      additionalSkills: normalizedData.additionalSkills,
      attachments: normalizedData.attachments,
      localDeviceId,
      workspacePath: runtimeWorkspace.workspacePath,
      workspaceSource: runtimeWorkspace.workspaceSource,
      branch: runtimeWorkspace.branch,
      newSession: true,
      clientMessageId: normalizedData.clientMessageId,
      ephemeral: normalizedData.ephemeral,
      permissionMode,
    }),
  } as unknown as Record<string, unknown>
}

function createLocalRuntimeSendPayload(
  data: RuntimeSendRequest,
  localDeviceId: string,
  cloudModelGateway?: CloudModelGateway
): Record<string, unknown> {
  const turnSeed = createRuntimeTurnSeed()
  const normalizedData: RuntimeSendRequest = {
    ...data,
    ...(data.modelOptions ? { modelOptions: normalizeModelOptionAliases(data.modelOptions) } : {}),
  }
  const collaborationMode = runtimeCollaborationMode(normalizedData.modelOptions)
  const workspacePath = stringValue(data.address.workspacePath)
  const addressRecord = recordValue(normalizedData.address)
  const taskId = stringValue(addressRecord.taskId)
  if (!taskId) {
    console.warn('[Wework] Local runtime send missing taskId', {
      deviceId: localDeviceId,
      workspacePath,
      addressKeys: Object.keys(addressRecord).sort(),
    })
    throw new Error('Runtime task address missing taskId')
  }
  const normalizedAddress: RuntimeTaskAddress = {
    ...normalizedData.address,
    deviceId: localDeviceId,
    taskId,
    ...(workspacePath ? { workspacePath } : {}),
  }

  if (
    normalizedData.requestUserInputResponse ||
    normalizedData.request_user_input_response ||
    normalizedData.approvalResponse ||
    normalizedData.approval_response
  ) {
    const payload = { ...normalizedData } as Record<string, unknown>
    delete payload.modelId
    delete payload.modelType
    return {
      ...payload,
      taskId,
      address: normalizedAddress,
      ...(collaborationMode ? { collaborationMode } : {}),
      executionRequest: buildLocalRuntimeExecutionRequest({
        taskId,
        runtime: 'codex',
        teamId: LOCAL_WORKBENCH_TEAM.id,
        title: taskId,
        message: normalizedData.message,
        turnSeed,
        modelId: normalizedData.modelId,
        modelType: normalizedData.modelType,
        modelOptions: normalizedData.modelOptions,
        cloudModelGateway,
        attachments: normalizedData.attachments,
        localDeviceId,
        workspacePath,
        workspaceSource: 'local_path',
        newSession: false,
        clientMessageId: normalizedData.clientMessageId,
        ephemeral: data.ephemeral,
        permissionMode: normalizedData.permissionMode ?? normalizedAddress.permissionMode,
      }),
    } as unknown as Record<string, unknown>
  }

  const payload = { ...normalizedData } as Record<string, unknown>
  delete payload.modelId
  delete payload.modelType
  return {
    ...payload,
    taskId,
    address: normalizedAddress,
    ...(collaborationMode ? { collaborationMode } : {}),
    executionRequest: buildLocalRuntimeExecutionRequest({
      taskId,
      runtime: 'codex',
      teamId: LOCAL_WORKBENCH_TEAM.id,
      title: taskId,
      message: normalizedData.message,
      turnSeed,
      modelId: normalizedData.modelId,
      modelType: normalizedData.modelType,
      modelOptions: normalizedData.modelOptions,
      cloudModelGateway,
      attachments: normalizedData.attachments,
      localDeviceId,
      workspacePath,
      workspaceSource: 'local_path',
      newSession: false,
      clientMessageId: normalizedData.clientMessageId,
      ephemeral: data.ephemeral,
      permissionMode: normalizedData.permissionMode ?? normalizedAddress.permissionMode,
    }),
  } as unknown as Record<string, unknown>
}

function normalizeRuntimeWorkDeviceId(
  runtimeWork: RuntimeWorkListResponse,
  localDeviceId: string
): RuntimeWorkListResponse {
  const normalizeWorkspace = (workspace: RuntimeDeviceWorkspace): RuntimeDeviceWorkspace => {
    const workspaceRecord = recordValue(workspace)
    const workspacePath =
      stringValue(workspaceRecord.workspacePath) ??
      stringValue(workspaceRecord.workspace_path) ??
      workspace.workspacePath
    const workspaceKind =
      stringValue(workspaceRecord.workspaceKind) ?? stringValue(workspaceRecord.workspace_kind)
    const worktreeId =
      stringValue(workspaceRecord.worktreeId) ?? stringValue(workspaceRecord.worktree_id)
    if (!Array.isArray(workspaceRecord.tasks)) {
      console.warn('[Wework] Runtime workspace missing tasks', {
        deviceId: localDeviceId,
        workspacePath,
        keys: Object.keys(workspaceRecord).sort(),
      })
    }
    const rawTasks = Array.isArray(workspaceRecord.tasks) ? workspaceRecord.tasks : []
    const tasks = normalizeRuntimeTaskSummaries(rawTasks, workspacePath)

    return {
      ...workspace,
      deviceId: localDeviceId,
      deviceName:
        stringValue(workspaceRecord.deviceName) ??
        stringValue(workspaceRecord.device_name) ??
        workspace.deviceName ??
        'Local Executor',
      deviceStatus:
        stringValue(workspaceRecord.deviceStatus) ??
        stringValue(workspaceRecord.device_status) ??
        workspace.deviceStatus ??
        'online',
      available: workspace.available !== false,
      workspacePath,
      ...(workspaceKind ? { workspaceKind } : {}),
      ...(worktreeId ? { worktreeId } : {}),
      tasks,
    }
  }

  return {
    ...runtimeWork,
    projects: runtimeWork.projects.map(project => ({
      ...project,
      project: {
        ...project.project,
        stateDeviceId: project.project.stateDeviceId ?? localDeviceId,
      },
      deviceWorkspaces: project.deviceWorkspaces.map(normalizeWorkspace),
    })),
    chats: runtimeWork.chats.map(normalizeWorkspace),
  }
}

function normalizeLocalDeviceRecord<T extends Record<string, unknown>>(
  data: T,
  localDeviceId: string
): T {
  const next: Record<string, unknown> = { ...data }

  if ('deviceId' in next) next.deviceId = localDeviceId
  if ('device_id' in next) next.device_id = localDeviceId

  const address = recordValue(next.address)
  if (Object.keys(address).length > 0) {
    next.address = {
      ...address,
      deviceId: localDeviceId,
      ...('device_id' in address ? { device_id: localDeviceId } : {}),
    }
  }

  if (Array.isArray(next.addresses)) {
    next.addresses = next.addresses.map(addressItem => {
      const addressRecord = recordValue(addressItem)
      if (Object.keys(addressRecord).length === 0) return addressItem
      return {
        ...addressRecord,
        deviceId: localDeviceId,
        ...('device_id' in addressRecord ? { device_id: localDeviceId } : {}),
      }
    })
  }

  return next as T
}

function adaptRuntimeWorkListResponse(
  response: unknown,
  localDeviceId: string
): RuntimeWorkListResponse {
  const record = recordValue(response)
  if (Array.isArray(record.projects) && Array.isArray(record.chats)) {
    return normalizeRuntimeWorkDeviceId(response as RuntimeWorkListResponse, localDeviceId)
  }

  const workspaces = Array.isArray(record.workspaces)
    ? record.workspaces
    : recordValue(record.workspaces)
      ? Object.entries(recordValue(record.workspaces)).map(([workspacePath, workspace]) => ({
          ...recordValue(workspace),
          workspacePath,
        }))
      : []
  const projects: RuntimeWorkListResponse['projects'] = []
  const projectsByKey = new Map<string, RuntimeWorkListResponse['projects'][number]>()
  const chats: RuntimeWorkListResponse['chats'] = []
  let totalTasks = 0
  const localWorkspaceLabels = new Set<string>()
  for (const rawWorkspace of workspaces) {
    const workspace = recordValue(rawWorkspace)
    const workspacePath =
      stringValue(workspace.workspacePath) ??
      stringValue(workspace.workspace_path) ??
      stringValue(workspace.projectWorkspacePath) ??
      stringValue(workspace.project_workspace_path) ??
      stringValue(workspace.cwd) ??
      stringValue(workspace.path)
    if (!workspacePath) continue
    const workspaceSource =
      stringValue(workspace.workspaceSource) ?? stringValue(workspace.workspace_source)
    if (workspaceSource && workspaceSource !== 'local') continue
    localWorkspaceLabels.add(workspaceLabel(workspacePath, workspace.label))
  }

  for (const rawWorkspace of workspaces) {
    const workspace = recordValue(rawWorkspace)
    const workspacePath =
      stringValue(workspace.workspacePath) ??
      stringValue(workspace.workspace_path) ??
      stringValue(workspace.projectWorkspacePath) ??
      stringValue(workspace.project_workspace_path) ??
      stringValue(workspace.cwd) ??
      stringValue(workspace.path)
    if (!workspacePath) continue

    if (!Array.isArray(workspace.tasks)) {
      console.warn('[Wework] Local runtime workspace missing tasks', {
        deviceId: localDeviceId,
        workspacePath,
        keys: Object.keys(workspace).sort(),
      })
    }
    const rawTasks = Array.isArray(workspace.tasks) ? workspace.tasks : []
    const tasks = normalizeRuntimeTaskSummaries(rawTasks, workspacePath)
    totalTasks += tasks.length

    const workspaceKindFromWorkspace =
      stringValue(workspace.workspaceKind) ?? stringValue(workspace.workspace_kind)
    const hasChatTask = tasks.some(task => task.workspaceKind === 'chat')
    const workspaceKind = workspaceKindFromWorkspace ?? (hasChatTask ? 'chat' : 'workspace')
    const worktreeId = stringValue(workspace.worktreeId) ?? stringValue(workspace.worktree_id)
    const label = workspaceLabel(workspacePath, workspace.label)
    const workspaceSource =
      stringValue(workspace.workspaceSource) ?? stringValue(workspace.workspace_source)
    const remoteHostId =
      stringValue(workspace.remoteHostId) ?? stringValue(workspace.remote_host_id)
    const workspaceDeviceId =
      workspaceSource === 'remote' && remoteHostId ? remoteHostId : localDeviceId
    if (rawTasks.length === 0 && workspaceSource === 'remote' && localWorkspaceLabels.has(label)) {
      continue
    }
    const deviceWorkspace: RuntimeDeviceWorkspace = {
      id: null,
      projectId: null,
      deviceId: workspaceDeviceId,
      deviceName: remoteHostId ?? 'Local Executor',
      deviceStatus: workspaceDeviceId === localDeviceId ? 'online' : 'offline',
      available: workspaceDeviceId === localDeviceId,
      workspacePath,
      workspaceKind,
      worktreeId,
      label,
      workspaceSource,
      remoteHostId,
      mapped: true,
      tasks,
    }

    if (workspaceKind === 'chat') {
      chats.push(deviceWorkspace)
      continue
    }

    const projectKey =
      stringValue(workspace.projectKey) ??
      stringValue(workspace.project_key) ??
      `local:${workspacePath}`
    const existingProject = projectsByKey.get(projectKey)
    if (existingProject) {
      existingProject.deviceWorkspaces.push(deviceWorkspace)
      existingProject.totalTasks = (existingProject.totalTasks ?? 0) + tasks.length
      continue
    }
    const rawRoots = Array.isArray(workspace.projectRoots)
      ? workspace.projectRoots
      : Array.isArray(workspace.project_roots)
        ? workspace.project_roots
        : [workspacePath]
    const projectKind =
      stringValue(workspace.projectKind) ?? stringValue(workspace.project_kind) ?? 'local'
    const projectSource =
      stringValue(workspace.projectSource) ?? stringValue(workspace.project_source) ?? 'legacy_root'
    const projectPinnedOrder = workspace.projectPinnedOrder ?? workspace.project_pinned_order
    const projectWork: RuntimeWorkListResponse['projects'][number] = {
      project: {
        key: projectKey,
        ...(projectSource === 'remote_project' ? { sidebarStateKey: projectKey } : {}),
        id: stableLocalId(`${localDeviceId}\0${projectKey}`),
        name: label,
        kind: projectKind,
        source: projectSource,
        stateDeviceId: localDeviceId,
        roots: rawRoots
          .map(root => stringValue(root))
          .filter((root): root is string => Boolean(root))
          .map(path => ({ kind: 'local', path })),
        pinned: workspace.projectPinned === true || workspace.project_pinned === true,
        pinnedOrder:
          typeof projectPinnedOrder === 'number' && Number.isInteger(projectPinnedOrder)
            ? projectPinnedOrder
            : null,
        active: workspace.projectActive === true || workspace.project_active === true,
        appearance: (workspace.projectAppearance ?? workspace.project_appearance ?? null) as
          | RuntimeWorkListResponse['projects'][number]['project']['appearance']
          | null,
      },
      deviceWorkspaces: [deviceWorkspace],
      totalTasks: tasks.length,
    }
    projectsByKey.set(projectKey, projectWork)
    projects.push(projectWork)
  }

  return { projects, chats, totalTasks }
}

export function createRuntimeWorkApiFromIpc(
  request: <T>(method: string, params?: Record<string, unknown>, deviceId?: string) => Promise<T>,
  getDefaultDeviceId: () => Promise<string>,
  options: RuntimeWorkIpcOptions = {}
) {
  const transportLabel = options.transportLabel ?? 'Local'
  const resolveDeviceId = options.resolveDeviceId ?? (() => getDefaultDeviceId())
  const normalizeDeviceRecord = options.normalizeDeviceRecord ?? normalizeLocalDeviceRecord
  const adaptListResponse = options.adaptListResponse ?? adaptRuntimeWorkListResponse
  const normalizeRequest = async <T extends object>(
    data: T
  ): Promise<T & Record<string, unknown>> =>
    normalizeDeviceRecord(
      data as Record<string, unknown>,
      await resolveDeviceId(data as Record<string, unknown>)
    ) as T & Record<string, unknown>

  const requestWithLocalDevice = async <TResponse, TRequest extends object>(
    method: string,
    data: TRequest
  ): Promise<TResponse> => {
    const normalizedData = await normalizeRequest(data)
    const deviceId = await resolveDeviceId(normalizedData)
    const startedAt = nowMs()
    const debugTranscript = method === 'runtime.tasks.transcript' && isRuntimeDebugEnabled()
    try {
      if (debugTranscript) {
        console.debug(`[Wework] ${transportLabel} runtime IPC transcript request`, {
          address: runtimeAddressDebug(normalizedData),
          runtimeHandle: runtimeHandleDebug(normalizedData),
        })
      }
      const response = await request<TResponse>(method, normalizedData, deviceId)
      if (debugTranscript) {
        console.debug(`[Wework] ${transportLabel} runtime IPC transcript response`, {
          address: runtimeAddressDebug(normalizedData),
          elapsedMs: Math.round(nowMs() - startedAt),
          messageCount: runtimeTranscriptMessageCount(response),
        })
      }
      return response
    } catch (error) {
      if (method === 'runtime.tasks.transcript') {
        console.error(`[Wework] ${transportLabel} runtime IPC transcript failed`, {
          address: runtimeAddressDebug(normalizedData),
          elapsedMs: Math.round(nowMs() - startedAt),
          error,
        })
      }
      throw error
    }
  }

  return {
    async listRuntimeWork(): Promise<RuntimeWorkListResponse> {
      const localDeviceId = await getDefaultDeviceId()
      const startedAt = nowMs()
      try {
        const response = await request('runtime.tasks.list', {}, localDeviceId)
        const runtimeWork = adaptListResponse(response, localDeviceId)
        return runtimeWork
      } catch (error) {
        console.error(`[Wework] ${transportLabel} runtime IPC list failed`, {
          elapsedMs: Math.round(nowMs() - startedAt),
          error,
        })
        throw error
      }
    },
    getKeybindings(): Promise<{ keybindings: KeybindingOverride[] }> {
      return request('runtime.keybindings.get', {})
    },
    updateKeybindings(data: {
      keybindings: KeybindingOverride[]
    }): Promise<{ keybindings: KeybindingOverride[] }> {
      return request('runtime.keybindings.update', data)
    },
    upsertDeviceWorkspace() {
      return cloudConnectionRequired('upsertDeviceWorkspace')
    },
    prepareDeviceWorkspace(
      data: DeviceWorkspacePrepareRequest
    ): Promise<DeviceWorkspacePrepareResponse> {
      return requestWithLocalDevice('runtime.workspaces.prepare', data)
    },
    deleteDeviceWorkspace(
      data: DeleteDeviceWorkspaceRequest
    ): Promise<DeleteDeviceWorkspaceResponse> {
      return requestWithLocalDevice('runtime.workspaces.delete', data)
    },
    getRuntimeTranscript(data: RuntimeTranscriptRequest): Promise<RuntimeTranscriptResponse> {
      return requestWithLocalDevice('runtime.tasks.transcript', data)
    },
    searchRuntimeWork(data: RuntimeWorkSearchRequest): Promise<RuntimeWorkSearchResponse> {
      return requestWithLocalDevice('runtime.tasks.search', data)
    },
    searchRuntimeWorkspace(
      data: RuntimeWorkspaceSearchRequest
    ): Promise<RuntimeWorkspaceSearchResponse> {
      return requestWithLocalDevice('runtime.workspace.search', data)
    },
    revertRuntimeFileChanges(
      data: RuntimeFileChangesRevertRequest
    ): Promise<RuntimeFileChangesRevertResponse> {
      return requestWithLocalDevice('runtime.tasks.revert_file_changes', data)
    },
    async sendRuntimeMessage(data: RuntimeSendRequest): Promise<RuntimeSendResponse> {
      const localDeviceId = await resolveDeviceId(data as unknown as Record<string, unknown>)
      const payload = createLocalRuntimeSendPayload(data, localDeviceId, options.cloudModelGateway)
      if (!payload.executionRequest) {
        console.warn('[Wework] Local runtime send payload missing executionRequest', {
          taskId: payload.taskId,
          address: runtimeAddressDebug(payload),
          payloadKeys: Object.keys(payload).sort(),
        })
        throw new Error('Runtime send payload missing executionRequest')
      }
      console.debug('[Wework] Local runtime send payload', {
        taskId: payload.taskId,
        address: runtimeAddressDebug(payload),
        payloadKeys: Object.keys(payload).sort(),
      })
      return request('runtime.tasks.send', payload, localDeviceId)
    },
    async rollbackRuntimeTask(data: RuntimeRollbackRequest): Promise<RuntimeSendResponse> {
      const localDeviceId = await resolveDeviceId(data as unknown as Record<string, unknown>)
      const payload = createLocalRuntimeSendPayload(data, localDeviceId, options.cloudModelGateway)
      if (!payload.executionRequest) {
        console.warn('[Wework] Local runtime rollback payload missing executionRequest', {
          taskId: payload.taskId,
          address: runtimeAddressDebug(payload),
          payloadKeys: Object.keys(payload).sort(),
        })
        throw new Error('Runtime rollback payload missing executionRequest')
      }
      console.debug('[Wework] Local runtime rollback payload', {
        taskId: payload.taskId,
        address: runtimeAddressDebug(payload),
        payloadKeys: Object.keys(payload).sort(),
      })
      return request('runtime.tasks.rollback', payload, localDeviceId)
    },
    async compactRuntimeTask(data: RuntimeCompactRequest): Promise<RuntimeSendResponse> {
      const localDeviceId = await resolveDeviceId({ address: data.address })
      const normalizedAddress = normalizeLocalDeviceRecord({ address: data.address }, localDeviceId)
        .address as RuntimeTaskAddress
      return request(
        'runtime.tasks.compact',
        {
          taskId: normalizedAddress.taskId,
          address: normalizedAddress,
        },
        localDeviceId
      )
    },
    async guideRuntimeTask(data: RuntimeGuidanceRequest): Promise<RuntimeGuidanceResponse> {
      const localDeviceId = await resolveDeviceId({ address: data.address })
      const normalizedAddress = normalizeLocalDeviceRecord({ address: data.address }, localDeviceId)
        .address as RuntimeTaskAddress
      return request(
        'runtime.tasks.guidance',
        {
          taskId: normalizedAddress.taskId,
          address: normalizedAddress,
          message: data.message,
          ...(data.attachmentIds ? { attachmentIds: data.attachmentIds } : {}),
          ...(data.attachments ? { attachments: data.attachments } : {}),
          ...(data.clientGuidanceId ? { clientGuidanceId: data.clientGuidanceId } : {}),
          ...(data.client_guidance_id ? { client_guidance_id: data.client_guidance_id } : {}),
          ...(data.additionalContext ? { additionalContext: data.additionalContext } : {}),
          ...(data.additional_context ? { additional_context: data.additional_context } : {}),
        },
        localDeviceId
      )
    },
    getRuntimeGoal(data: RuntimeGoalGetRequest): Promise<RuntimeGoalGetResponse> {
      return requestWithLocalDevice('runtime.tasks.goal.get', data)
    },
    setRuntimeGoal(data: RuntimeGoalSetRequest): Promise<RuntimeGoalSetResponse> {
      return requestWithLocalDevice('runtime.tasks.goal.set', data)
    },
    clearRuntimeGoal(data: RuntimeGoalClearRequest): Promise<RuntimeGoalClearResponse> {
      return requestWithLocalDevice('runtime.tasks.goal.clear', data)
    },
    openRuntimeWorkspace(data: RuntimeWorkspaceOpenRequest): Promise<RuntimeWorkspaceOpenResponse> {
      return requestWithLocalDevice('runtime.workspaces.open', data)
    },
    renameRuntimeWorkspace(
      data: RuntimeWorkspaceRenameRequest
    ): Promise<RuntimeWorkspaceOpenResponse> {
      return requestWithLocalDevice('runtime.workspaces.rename', data)
    },
    removeRuntimeWorkspace(
      data: RuntimeWorkspaceRemoveRequest
    ): Promise<RuntimeWorkspaceOpenResponse> {
      return requestWithLocalDevice('runtime.workspaces.remove', data)
    },
    reorderRuntimeProjects(
      data: RuntimeProjectReorderRequest
    ): Promise<RuntimeSidebarMutationResponse> {
      return requestWithLocalDevice('runtime.sidebar.projects.reorder', data)
    },
    setRuntimeProjectPinned(
      data: RuntimeProjectPinRequest
    ): Promise<RuntimeSidebarMutationResponse> {
      return requestWithLocalDevice('runtime.sidebar.projects.pin', data)
    },
    setRuntimeProjectAppearance(
      data: RuntimeProjectAppearanceRequest
    ): Promise<RuntimeSidebarMutationResponse> {
      return requestWithLocalDevice('runtime.sidebar.projects.appearance', data)
    },
    syncRuntimeRemoteProjects(
      data: RuntimeRemoteProjectsSyncRequest
    ): Promise<RuntimeSidebarMutationResponse> {
      return requestWithLocalDevice('runtime.sidebar.projects.sync_remote', data)
    },
    activateRuntimeProject(
      data: RuntimeProjectActivateRequest
    ): Promise<RuntimeSidebarMutationResponse> {
      return requestWithLocalDevice('runtime.sidebar.projects.activate', data)
    },
    reorderRuntimeProjectTasks(
      data: RuntimeProjectTaskReorderRequest
    ): Promise<RuntimeSidebarMutationResponse> {
      return requestWithLocalDevice('runtime.sidebar.tasks.reorder', data)
    },
    setRuntimeTaskPinned(data: RuntimeTaskPinRequest): Promise<RuntimeSidebarMutationResponse> {
      return requestWithLocalDevice('runtime.sidebar.tasks.pin', data)
    },
    getWorktreeSettings(data: { deviceId: string }): Promise<RuntimeWorktreeSettings> {
      return requestWithLocalDevice('runtime.worktrees.settings.get', data)
    },
    updateWorktreeSettings(data: RuntimeWorktreeSettingsPatch): Promise<RuntimeWorktreeSettings> {
      return requestWithLocalDevice('runtime.worktrees.settings.update', data)
    },
    listWorktrees(data: { deviceId: string }): Promise<RuntimeWorktreeListResponse> {
      return requestWithLocalDevice('runtime.worktrees.list', data)
    },
    prepareWorktree(data: RuntimeWorktreePrepareRequest): Promise<RuntimeWorktreeMutationResponse> {
      return requestWithLocalDevice('runtime.worktrees.prepare', data)
    },
    deleteWorktree(data: RuntimeWorktreeDeleteRequest): Promise<RuntimeWorktreeMutationResponse> {
      return requestWithLocalDevice('runtime.worktrees.delete', data)
    },
    restoreWorktree(data: RuntimeWorktreeDeleteRequest): Promise<RuntimeWorktreeMutationResponse> {
      return requestWithLocalDevice('runtime.worktrees.restore', data)
    },
    bindRuntimeTaskImSessions() {
      return cloudConnectionRequired('bindRuntimeTaskImSessions')
    },
    async getImNotificationSettings() {
      return {
        global: { enabled: false, sessionKey: null, session: null },
        runtimeTaskSubscriptions: [],
      }
    },
    updateGlobalImNotification() {
      return cloudConnectionRequired('updateGlobalImNotification')
    },
    subscribeRuntimeTaskNotifications() {
      return cloudConnectionRequired('subscribeRuntimeTaskNotifications')
    },
    unsubscribeRuntimeTaskNotifications(address: RuntimeTaskAddress) {
      return Promise.resolve({ address, subscribed: false, sessionKeys: [] })
    },
    archiveRuntimeTask(data: RuntimeTaskAddress): Promise<RuntimeTaskArchiveResponse> {
      return requestWithLocalDevice('runtime.tasks.archive', data)
    },
    renameRuntimeTask(data: RuntimeTaskRenameRequest): Promise<RuntimeTaskArchiveResponse> {
      return requestWithLocalDevice('runtime.tasks.rename', data)
    },
    listArchivedConversations(
      data: ArchivedConversationsListRequest = {}
    ): Promise<ArchivedConversationsListResponse> {
      return requestWithLocalDevice('runtime.archived_conversations.list', data)
    },
    archiveConversation(data: RuntimeTaskAddress): Promise<RuntimeTaskArchiveResponse> {
      return requestWithLocalDevice('runtime.tasks.archive', data)
    },
    archiveProjectConversations(
      data: RuntimeArchiveProjectConversationsRequest
    ): Promise<RuntimeArchivedConversationBulkResponse> {
      return requestWithLocalDevice(
        'runtime.archived_conversations.archive_project',
        normalizeLocalArchiveProjectRequest(data)
      )
    },
    archiveAllConversations(): Promise<RuntimeArchivedConversationBulkResponse> {
      return getDefaultDeviceId().then(deviceId =>
        request('runtime.archived_conversations.archive_all', {}, deviceId)
      )
    },
    unarchiveConversation(data: RuntimeTaskAddress): Promise<RuntimeTaskArchiveResponse> {
      return requestWithLocalDevice('runtime.archived_conversations.unarchive', data)
    },
    deleteArchivedConversation(data: RuntimeTaskAddress): Promise<RuntimeTaskArchiveResponse> {
      return requestWithLocalDevice('runtime.archived_conversations.delete', data)
    },
    deleteArchivedConversationsBulk(
      data: RuntimeArchivedConversationBulkRequest
    ): Promise<RuntimeArchivedConversationBulkResponse> {
      return requestWithLocalDevice('runtime.archived_conversations.delete_bulk', data)
    },
    previewArchivedConversationCleanup(data: RuntimeArchivedConversationBulkRequest) {
      return requestWithLocalDevice('runtime.archived_conversations.cleanup_preview', data)
    },
    cleanupArchivedConversations(data: RuntimeArchivedConversationBulkRequest) {
      return requestWithLocalDevice('runtime.archived_conversations.cleanup', data)
    },
    cancelRuntimeTask(data: RuntimeTaskAddress): Promise<RuntimeTaskCancelResponse> {
      return requestWithLocalDevice('runtime.tasks.cancel', data)
    },
    async createRuntimeTask(data: RuntimeTaskCreateRequest): Promise<RuntimeTaskCreateResponse> {
      const localDeviceId = await resolveDeviceId(data as unknown as Record<string, unknown>)
      const payload = await createLocalRuntimeTaskPayload(
        data,
        localDeviceId,
        requestWithLocalDevice,
        options.cloudModelGateway
      )
      debugLocalRuntimeCreatePayload(data, payload)
      const response = await request<Partial<RuntimeTaskCreateResponse>>(
        'runtime.tasks.create',
        payload,
        localDeviceId
      )
      const workspacePath = stringValue(payload.workspacePath) ?? requiredRuntimeWorkspacePath(data)
      const executionRequest = recordValue(payload.executionRequest)
      const responseRecord = recordValue(response)
      const taskId =
        stringValue(responseRecord.taskId) ??
        stringValue(responseRecord.task_id) ??
        stringValue(executionRequest.task_id) ??
        createRuntimeExecutionIds(data)[0]
      const runtimeHandle = recordValue(
        responseRecord.runtimeHandle ?? responseRecord.runtime_handle
      )
      return {
        ...response,
        accepted: response.accepted ?? true,
        deviceId: localDeviceId,
        taskId,
        workspacePath: response.workspacePath ?? workspacePath,
        runtime: response.runtime ?? data.runtime,
        ...(Object.keys(runtimeHandle).length > 0 ? { runtimeHandle } : {}),
      }
    },
    forkRuntimeTask(data: RuntimeTaskForkRequest): Promise<RuntimeTaskForkResponse> {
      return requestWithLocalDevice('runtime.tasks.import_fork', data)
    },
  }
}

function debugLocalRuntimeCreatePayload(
  request: RuntimeTaskCreateRequest,
  payload: Record<string, unknown>
) {
  if (globalThis.localStorage?.getItem('wework:debug-runtime') !== '1') return
  const executionRequest = recordValue(payload.executionRequest)
  console.debug('[Wework] Local runtime create payload', {
    taskId: request.taskId,
    runtime: request.runtime,
    requestModelOptions: summarizeLocalModelOptions(request.modelOptions),
    payloadModelOptions: summarizeLocalModelOptions(recordValue(payload.modelOptions)),
    payloadCollaborationMode: stringValue(payload.collaborationMode),
    executionRequestCollaborationMode: stringValue(executionRequest.collaborationMode),
    executionRequestModelId: stringValue(recordValue(executionRequest.model_config).model_id),
  })
}

function summarizeLocalModelOptions(
  modelOptions: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!modelOptions) return {}
  return {
    keys: Object.keys(modelOptions),
    collaborationMode:
      stringValue(modelOptions.collaborationMode) ?? stringValue(modelOptions.collaboration_mode),
    reasoning: stringValue(modelOptions.reasoning),
    summary: stringValue(modelOptions.summary),
    speed: stringValue(modelOptions.speed) ?? stringValue(modelOptions.service_tier),
  }
}

export function createLocalAppServices(deps: LocalAppServicesDeps = {}): WorkbenchServices {
  const ensure = deps.ensure ?? ensureLocalExecutorStarted
  const request = deps.request ?? requestLocalExecutor
  const subscribe = deps.subscribe ?? subscribeLocalExecutorEvents
  let lastStatus: LocalExecutorStatus | null = null
  let ensurePromise: Promise<LocalExecutorStatus> | null = null

  const ensureStatus = async () => {
    if (!ensurePromise) {
      ensurePromise = ensure()
        .then(status => {
          lastStatus = status
          return status
        })
        .finally(() => {
          ensurePromise = null
        })
    }
    return ensurePromise
  }

  const getLocalDeviceId = async () => localDeviceIdFromStatus(await ensureStatus())

  const executeCommand = async (
    deviceId: string,
    data: {
      command_key: string
      path?: string
      cwd?: string
      args?: string[]
      stdin?: string
      env?: Record<string, unknown>
      timeout_seconds?: number
      max_output_bytes?: number
    }
  ) =>
    request<DeviceCommandResponse>(
      'device.execute_command',
      normalizeLocalDeviceRecord({ deviceId, ...data }, await getLocalDeviceId())
    )

  const deviceApi: WorkbenchServices['deviceApi'] = {
    async listDevices() {
      try {
        return [localDeviceFromStatus(await ensureStatus())]
      } catch (error) {
        const fallback = {
          ...localExecutorErrorStatus(error),
          deviceId: localDeviceIdFromStatus(lastStatus),
        }
        return [localDeviceFromStatus(fallback)]
      }
    },
    async getHomeDirectory(deviceId: string) {
      const response = await executeCommand(deviceId, {
        command_key: 'home_dir',
        timeout_seconds: 10,
        max_output_bytes: 4096,
      })
      assertCommandSuccess(response, 'Failed to resolve home directory')
      return commandText(response)
    },
    async getProjectWorkspaceRoot(deviceId: string) {
      const response = await executeCommand(deviceId, {
        command_key: 'project_workspace_root',
        timeout_seconds: 10,
        max_output_bytes: 4096,
      })
      assertCommandSuccess(response, 'Failed to resolve project directory')
      return commandText(response)
    },
    async listDirectories(deviceId: string, path: string) {
      const response = await executeCommand(deviceId, {
        command_key: 'ls_dirs',
        path,
        timeout_seconds: 15,
        max_output_bytes: 1024 * 64,
      })
      assertCommandSuccess(response, 'Failed to list directories')
      return commandStringList(response)
    },
    async createDirectory(deviceId: string, path: string) {
      const response = await executeCommand(deviceId, {
        command_key: 'mkdir_p',
        args: [path],
        timeout_seconds: 15,
        max_output_bytes: 4096,
      })
      assertCommandSuccess(response, 'Failed to create directory')
    },
    executeCommand,
    upgradeDevice: () => cloudConnectionRequired('upgradeDevice'),
    async listSkills(deviceId: string) {
      const response = await executeCommand(deviceId, {
        command_key: 'ls_skills',
        timeout_seconds: 15,
        max_output_bytes: 1024 * 256,
      })
      assertCommandSuccess(response, 'Failed to list skills')
      return commandSkills(response)
    },
    async listWorkspaceEntries(deviceId: string, path: string): Promise<WorkspaceTreeResponse> {
      const normalizedPath = normalizeAbsoluteWorkspacePath(path, 'Workspace path must be absolute')
      const response = await executeCommand(deviceId, {
        command_key: 'workspace_tree',
        path: normalizedPath,
        timeout_seconds: 15,
        max_output_bytes: 1024 * 512,
      })
      assertCommandSuccess(response, 'Failed to list workspace files')
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
      assertCommandSuccess(response, 'Failed to read workspace file')
      return normalizeWorkspaceTextFile(response.stdout, filePath)
    },
    async readWorkspaceFileChunk(deviceId: string, filePath: string, offset: number) {
      const { parentPath, fileName } = splitAbsoluteWorkspaceFilePath(filePath)
      const response = await executeCommand(deviceId, {
        command_key: 'workspace_read_file_chunk',
        path: parentPath,
        args: [fileName, String(offset)],
        timeout_seconds: 30,
        max_output_bytes: 1024 * 1024 * 2,
      })
      assertCommandSuccess(response, 'Failed to read workspace file')
      return normalizeWorkspaceFileChunk(response.stdout, filePath, offset)
    },
    async writeWorkspaceTextFile(
      deviceId: string,
      filePath: string,
      content: string,
      expectedRevision: string
    ) {
      const { parentPath, fileName } = splitAbsoluteWorkspaceFilePath(filePath)
      const response = await executeCommand(deviceId, {
        command_key: 'workspace_write_text_file',
        path: parentPath,
        args: [fileName, expectedRevision],
        stdin: content,
        timeout_seconds: 15,
        max_output_bytes: WORKSPACE_TEXT_FILE_MAX_OUTPUT_BYTES,
      })
      assertCommandSuccess(response, 'Failed to save workspace file')
      return normalizeWorkspaceTextFile(response.stdout, filePath)
    },
  }
  const runtimeWorkApi = createRuntimeWorkApiFromIpc(
    (method, params) => request(method, params),
    getLocalDeviceId,
    {
      cloudModelGateway: deps.cloudModelGateway,
    }
  ) as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>

  return {
    teamApi: {
      listTeams: async () => [LOCAL_WORKBENCH_TEAM],
      getDefaultWorkbenchTeam: async () => LOCAL_WORKBENCH_TEAM,
    },
    modelApi: {
      listModels: async () => {
        let codexOfficialModels: CodexOfficialModel[]
        let codexOfficialError: string | null
        let codexAuthConfigured: boolean
        try {
          await ensureStatus()
          const [codexOfficialResult, nextCodexAuthConfigured] = await Promise.all([
            requestLocalCodexOfficialModels(request).then(
              value => ({ value, error: null }),
              error => ({
                value: null,
                error: error instanceof Error ? error.message : String(error),
              })
            ),
            loadLocalCodexAuthConfigured(request),
          ])
          codexOfficialModels = codexOfficialResult.value?.models ?? []
          codexOfficialError = codexOfficialResult.error
          codexAuthConfigured = nextCodexAuthConfigured
        } catch (error) {
          codexOfficialModels = []
          codexOfficialError = error instanceof Error ? error.message : String(error)
          codexAuthConfigured = false
        }
        return {
          data: localRuntimeModels(codexOfficialModels, codexOfficialError, codexAuthConfigured),
        }
      },
    },
    skillApi: {
      listSkills: async () => [],
      getTeamSkills: async () => ({ skills: [], preload_skills: [] }),
    },
    projectApi: {
      listProjects: async () => ({ items: [] }),
      getProject: () => cloudConnectionRequired('getProject'),
      createProject: () => cloudConnectionRequired('createProject'),
      updateProject: () => cloudConnectionRequired('updateProject'),
      deleteProject: () => cloudConnectionRequired('deleteProject'),
    },
    taskApi: {
      getTurnFileChangesDiff: () => cloudConnectionRequired('getTurnFileChangesDiff'),
      revertTurnFileChanges: () => cloudConnectionRequired('revertTurnFileChanges'),
    },
    deviceApi,
    runtimeWorkApi,
    attachmentApi: createLocalAttachmentApi(),
    executorClient: createExecutorClientFromApis({
      transportKind: 'local-ipc',
      deviceApi,
      runtimeWorkApi,
    }),
    userApi: {
      updateCurrentUser: async (data: { preferences?: User['preferences'] }) =>
        saveLocalUserPreferences(data.preferences ?? LOCAL_USER.preferences),
      getRuntimeConfig: () => cloudConnectionRequired('getRuntimeConfig'),
      updateRuntimeConfig: () => cloudConnectionRequired('updateRuntimeConfig'),
      getProxyConfig: () => cloudConnectionRequired('getProxyConfig'),
      updateProxyConfig: () => cloudConnectionRequired('updateProxyConfig'),
      uploadRuntimeAuthJson: () => cloudConnectionRequired('uploadRuntimeAuthJson'),
      importRuntimeAuthJson: () => cloudConnectionRequired('importRuntimeAuthJson'),
    },
    chatStream: createRuntimeChatStream({ subscribe, request }),
  } as unknown as WorkbenchServices
}
