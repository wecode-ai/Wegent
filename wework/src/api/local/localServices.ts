import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  harnessLaunchThroughMessagesProxy,
  type HarnessProxyRegistration,
  type LocalHarnessModelOption,
} from '@/features/local-harness/localHarnessModels'
import {
  buildHarnessModelContext,
  buildHarnessUserContext,
  type HarnessContextRegistration,
} from '@/features/harness-apps/harnessContext'
import { createExecutorClientFromApis } from '@/api/executorAccess'
import i18n from '@/i18n'
import type {
  ArchivedConversationsListRequest,
  ArchivedConversationsListResponse,
  Attachment,
  DeleteDeviceWorkspaceRequest,
  DeleteDeviceWorkspaceResponse,
  DeviceCommandResponse,
  DeviceWorkspacePrepareRequest,
  DeviceWorkspacePrepareResponse,
  RuntimeTaskSummary,
  LocalDeviceSkill,
  ModelSelectionConfig,
  ModelType,
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
  RuntimeInterruptAndSendRequest,
  RuntimeModelPrepareRequest,
  RuntimeLocalProjectUpsertRequest,
  RuntimeLocalProjectUpsertResponse,
  RuntimeProjectSpaceRef,
  RuntimeProjectQuickPhrase,
  RuntimeGoalClearRequest,
  RuntimeGoalClearResponse,
  RuntimeGoalGetRequest,
  RuntimeGoalGetResponse,
  RuntimeGoalSetRequest,
  RuntimeGoalSetResponse,
  RuntimeSupervisorClearRequest,
  RuntimeSupervisorGetRequest,
  RuntimeSupervisorResolveRequest,
  RuntimeSupervisorResponse,
  RuntimeSupervisorRunNowRequest,
  RuntimeSupervisorSetRequest,
  RuntimeGoalStatus,
  RuntimeTaskAddress,
  RuntimeTaskArchiveResponse,
  RuntimeTaskCancelResponse,
  RuntimeTaskCreateRequest,
  RuntimeTaskCreateResponse,
  RuntimeTaskForkRequest,
  RuntimeTaskForkResponse,
  RuntimeTaskQueueReorderRequest,
  RuntimeTaskQueueReorderResponse,
  RuntimeTaskRenameRequest,
  RuntimeSettings,
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
  RuntimeWorktreeCapabilitiesRequest,
  RuntimeWorktreeCapabilitiesResponse,
  RuntimeWorktreeListResponse,
  RuntimeWorktreeMutationResponse,
  RuntimeWorktreePreflightRequest,
  RuntimeWorktreePreflightResponse,
  RuntimeWorktreePrepareRequest,
  RuntimeWorktreeSettings,
  RuntimeWorktreeSettingsPatch,
  Team,
  UnifiedModel,
  User,
} from '@/types/api'
import type { DeviceInfo } from '@/types/devices'
import type {
  Automation,
  AutomationListResponse,
  AutomationMutation,
  AutomationRun,
  AutomationRunListResponse,
  AutomationSource,
} from '@/types/automation'
import type { WorkspaceTextFileResponse, WorkspaceTreeResponse } from '@/types/workspace-files'
import {
  ensureLocalExecutorStarted,
  requestLocalExecutor,
  subscribeLocalExecutorEvents,
  type LocalExecutorEvent,
  type LocalExecutorStatus,
} from '@/tauri/localExecutor'
import {
  listLocalWorkspaceEntries,
  readLocalWorkspaceFileChunk,
  readLocalWorkspaceTextFile,
} from '@/tauri/localWorkspaceFiles'
import { WEWORK_MIN_EXECUTOR_VERSION } from '@/lib/device-capabilities'
import { normalizeModelOptionAliases, normalizeModelOptionValue } from '@/lib/model-ui'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import {
  runtimePermissionMode,
  runtimePermissionProfile,
} from '@/features/workbench/runtimePermissionMode'
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
  markLocalModelCatalogReady,
  reconcileLocalModelCatalogRuntime,
  type LocalModelConfig,
} from '@/features/model-settings/localModelSettings'
import { builtinCodexCatalogModel } from '@/features/model-settings/codexCatalog'
import { localModelSupportsImageInput } from '@/features/model-settings/localModelProviders'
import { getLocalProxyUrl } from '@/features/model-settings/localProxySettings'
import { createRuntimeChatStream } from '../runtime/runtimeChatStream'
import { createLocalAttachmentApi } from './localAttachments'
import {
  createExternalIssueApi,
  createLocalDeliveryApi,
  createLocalLoopItemExecutionApi,
  createLocalProjectChatAgentApi,
} from './localDelivery'
import { createLocalProjectChatClient } from './localProjectChatClient'
import { createLocalAITableApi } from '@/api/aitable'
import { createDwsApi } from '@/api/dws'
import { getLocalUser, LOCAL_USER, saveLocalUserPreferences } from './localSession'
import type { KeybindingOverride } from '@/lib/keybindings'
import type { LocalHarnessId } from '@/lib/local-harness'
import {
  CLOUD_MODEL_CONTEXT_WINDOW_OPTION,
  CLOUD_MODEL_CODEX_CATALOG_MODEL_ID_OPTION,
  CLOUD_MODEL_MAX_OUTPUT_TOKENS_OPTION,
  CLOUD_MODEL_NATIVE_NAMESPACE_TOOLS_OPTION,
  CLOUD_MODEL_NATIVE_TOOL_SEARCH_OPTION,
  CLOUD_MODEL_NAMESPACE_OPTION,
  CLOUD_MODEL_RESOURCE_USER_ID_OPTION,
  CLOUD_MODEL_UPSTREAM_API_FORMAT_OPTION,
  CLOUD_MODEL_VISION_SIDECAR_OPTION,
  selectedModelExecutionFields,
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
const DEFAULT_GPT_56_CATALOG_MODEL_ID = 'wework-gpt-5.6-sol'

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
  const reasoningEfforts = localModelReasoningEfforts(config)
  const defaultReasoningEffort = localModelDefaultReasoningEffort(config)
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
        reasoningEfforts,
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
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

function localModelReasoningEfforts(config: LocalModelConfig): string[] {
  const catalog = config.catalogEntry ?? builtinCodexCatalogModel(config.codexCatalogModelId)
  const values = catalog?.supported_reasoning_levels
  if (!Array.isArray(values)) return []
  return values.flatMap(value => {
    if (typeof value === 'string') return [value]
    if (!value || typeof value !== 'object') return []
    const effort = (value as Record<string, unknown>).effort
    return typeof effort === 'string' ? [effort] : []
  })
}

function localModelDefaultReasoningEffort(config: LocalModelConfig): string | null {
  const catalog = config.catalogEntry ?? builtinCodexCatalogModel(config.codexCatalogModelId)
  const value = catalog?.default_reasoning_level
  return typeof value === 'string' ? value : null
}

function localRuntimeModels(
  codexOfficialModels: CodexOfficialModel[] = [],
  codexOfficialError: string | null = null,
  codexAuthConfigured = false
): UnifiedModel[] {
  const officialCatalogModels = codexOfficialModels.filter(
    model => model.providerType === 'official'
  )
  const officialModels = !codexAuthConfigured
    ? []
    : codexOfficialError || officialCatalogModels.length === 0
      ? [
          unavailableCodexModel(
            codexOfficialError || 'Codex model list returned no available models'
          ),
        ]
      : officialCatalogModels.map(model => localCodexModel(model, true))
  const providerModels = codexOfficialModels
    .filter(model => model.providerType === 'provider')
    .map(model => localCodexModel(model, codexAuthConfigured))

  return [
    ...officialModels,
    ...providerModels,
    ...listLocalModelConfigs()
      .filter(config => config.enabled && config.catalogReady)
      .map(localModelConfigToUnifiedModel),
  ]
}

type LocalExecutorRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

interface LocalAppServicesDeps {
  ensure?: () => Promise<LocalExecutorStatus>
  request?: LocalExecutorRequest
  subscribe?: (handler: (event: LocalExecutorEvent) => void) => Promise<() => void>
  cloudModelGateway?: CloudModelGateway
  user?: User
  readWorkspaceTextFile?: typeof readLocalWorkspaceTextFile
  readWorkspaceFileChunk?: typeof readLocalWorkspaceFileChunk
  listWorkspaceEntries?: typeof listLocalWorkspaceEntries
}

interface CatalogReconciliationTracker {
  attemptedAt: number
  inFlight: Promise<void> | null
  key: string
}

const catalogReconciliationTrackers = new WeakMap<
  LocalExecutorRequest,
  CatalogReconciliationTracker
>()
const CATALOG_IDLE_RESTART_RETRY_DELAY_MS = 100
const CATALOG_IDLE_RESTART_MAX_ATTEMPTS = 20

function catalogReconciliationTracker(request: LocalExecutorRequest): CatalogReconciliationTracker {
  const existing = catalogReconciliationTrackers.get(request)
  if (existing) return existing
  const tracker = { attemptedAt: 0, inFlight: null, key: '' }
  catalogReconciliationTrackers.set(request, tracker)
  return tracker
}

async function reconcilePendingLocalModelCatalog(
  request: LocalExecutorRequest,
  runtimeInstanceId?: string
): Promise<void> {
  const tracker = catalogReconciliationTracker(request)
  if (tracker.inFlight) {
    try {
      await tracker.inFlight
    } catch {
      return
    }
    return reconcilePendingLocalModelCatalog(request, runtimeInstanceId)
  }

  const catalogModels = listLocalModelConfigs().filter(model => model.catalogEntry)
  const pendingCatalogModels = catalogModels.filter(
    model => !model.catalogReady && model.catalogEntry
  )
  const reconciliationKey = pendingCatalogModels
    .map(model => `${runtimeInstanceId ?? ''}:${model.id}:${model.updatedAt}`)
    .sort()
    .join('|')
  const now = Date.now()
  const shouldReconcile =
    reconciliationKey && (reconciliationKey !== tracker.key || now - tracker.attemptedAt >= 30_000)
  if (!shouldReconcile) return

  tracker.key = reconciliationKey
  tracker.attemptedAt = now
  const reconciliation = (async () => {
    await request('runtime.codex.catalog.custom.write', {
      models: catalogModels.flatMap(model => (model.catalogEntry ? [model.catalogEntry] : [])),
    })
    let restart = await request<{
      restarted?: boolean
      activeTaskCount?: number
      pendingRequestCount?: number
    }>('runtime.codex.app_server.restart', { ifIdle: true })
    if (restart.restarted) {
      markLocalModelCatalogReady(pendingCatalogModels)
      return
    }

    for (let attempt = 0; attempt < CATALOG_IDLE_RESTART_MAX_ATTEMPTS; attempt += 1) {
      const models = await request<{
        data?: Array<{ id?: string }>
      }>('runtime.codex.models.list', { includeHidden: true })
      const loadedModelIds = new Set(
        (models.data ?? []).flatMap(model => (typeof model.id === 'string' ? [model.id] : []))
      )
      const loadedPendingModels = pendingCatalogModels.filter(model => {
        const catalogModelId =
          model.codexCatalogModelId ??
          (typeof model.catalogEntry?.slug === 'string' ? model.catalogEntry.slug : null)
        return Boolean(catalogModelId && loadedModelIds.has(catalogModelId))
      })
      if (loadedPendingModels.length > 0) {
        markLocalModelCatalogReady(loadedPendingModels)
      }
      if (
        loadedPendingModels.length === pendingCatalogModels.length ||
        (restart.activeTaskCount ?? 0) > 0 ||
        (restart.pendingRequestCount ?? 0) <= 0
      ) {
        return
      }

      await new Promise(resolve => setTimeout(resolve, CATALOG_IDLE_RESTART_RETRY_DELAY_MS))
      restart = await request('runtime.codex.app_server.restart', { ifIdle: true })
      if (restart.restarted) {
        markLocalModelCatalogReady(pendingCatalogModels)
        return
      }
    }
  })()
  tracker.inFlight = reconciliation
  try {
    await reconciliation
  } catch (error) {
    console.error('Local model catalog reconciliation failed', error)
  } finally {
    if (tracker.inFlight === reconciliation) tracker.inFlight = null
  }
}

interface CloudModelGateway {
  baseUrl: string
  apiKey: string
  backendUrl?: string
}

interface RuntimeWorkIpcOptions {
  resolveDeviceId?: (data?: Record<string, unknown>) => Promise<string>
  normalizeDeviceRecord?: <T extends Record<string, unknown>>(data: T, deviceId: string) => T
  adaptListResponse?: (response: unknown, deviceId: string) => RuntimeWorkListResponse
  cloudModelGateway?: CloudModelGateway
  user?: User
  transportLabel?: 'Local' | 'Cloud'
  syncConfiguredModelCatalog?: boolean
  requestModelCatalogSync?: (request: {
    deviceId: string
    deviceName: string
    modelName: string
    sync: () => Promise<void>
  }) => Promise<boolean>
  resolveDeviceName?: (deviceId: string) => string | undefined
}

interface AutomationIpcOptions extends RuntimeWorkIpcOptions {
  prepareRuntimeModel: (data: RuntimeModelPrepareRequest) => Promise<boolean>
}

function cloudConnectionRequired(name: string): never {
  throw new Error(`${name} requires cloud connection`)
}

function modelCatalogSyncCancelled(): Error {
  return new Error(i18n.t('workbench.cloud_model_catalog_sync_cancelled'))
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

function modelTypeValue(value: unknown): ModelType | null {
  const modelType = stringValue(value)
  return modelType === 'public' ||
    modelType === 'user' ||
    modelType === 'group' ||
    modelType === 'runtime'
    ? modelType
    : null
}

function modelSelectionValue(value: unknown): ModelSelectionConfig | null {
  const selection = recordValue(value)
  const modelName = stringValue(selection.modelName) ?? stringValue(selection.model_name)
  if (!modelName) return null
  const modelType = modelTypeValue(selection.modelType) ?? modelTypeValue(selection.model_type)
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
  const goalStatus = runtimeGoalStatusValue(taskRecord.goalStatus ?? taskRecord.goal_status)
  const threadStatus = stringValue(taskRecord.threadStatus ?? taskRecord.thread_status)
  const turnStatus = stringValue(taskRecord.turnStatus ?? taskRecord.turn_status)
  const continuableValue = taskRecord.continuable
  const continuable = typeof continuableValue === 'boolean' ? continuableValue : undefined
  const rawProjectPluginIds = taskRecord.projectPluginIds ?? taskRecord.project_plugin_ids
  const projectPluginIds = Array.isArray(rawProjectPluginIds)
    ? rawProjectPluginIds
        .filter((value: unknown): value is string => typeof value === 'string')
        .map((value: string) => value.trim())
        .filter(Boolean)
    : []

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
    ...(goalStatus ? { goalStatus } : {}),
    ...(threadStatus ? { threadStatus } : {}),
    ...(turnStatus ? { turnStatus } : {}),
    ...(continuable !== undefined ? { continuable } : {}),
    ...(projectPluginIds.length > 0 ? { projectPluginIds } : {}),
  }

  return normalized as RuntimeTaskSummary
}

function runtimeGoalStatusValue(value: unknown): RuntimeGoalStatus | undefined {
  return value === 'active' ||
    value === 'paused' ||
    value === 'blocked' ||
    value === 'complete' ||
    value === 'usageLimited' ||
    value === 'budgetLimited'
    ? value
    : undefined
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

function localVisionSidecarConfig(config: LocalModelConfig): Record<string, unknown> | null {
  if (!config.visionModelConfigId) return null
  const visionModel = listLocalModelConfigs().find(
    candidate => candidate.id === config.visionModelConfigId
  )
  if (!visionModel?.enabled) {
    throw new Error('Vision proxy model is missing or disabled')
  }
  if (!localModelSupportsImageInput(visionModel)) {
    throw new Error('Vision proxy model does not declare image input support')
  }
  return {
    enabled: true,
    request_url: buildLocalModelRequestUrl(
      visionModel.baseUrl,
      visionModel.requestPath,
      visionModel.apiFormat
    ),
    api_format: visionModel.apiFormat,
    api_key: visionModel.apiKey || 'dummy',
    model_id: visionModel.modelId,
    max_descriptions_per_turn: 8,
    timeout_ms: 45_000,
  }
}

function cloudVisionSidecarConfig(
  runtime: string,
  modelOptions: Record<string, string> | undefined,
  cloudModelGateway: CloudModelGateway
): Record<string, unknown> | null {
  const raw = modelOptions?.[CLOUD_MODEL_VISION_SIDECAR_OPTION]
  if (!raw) return null

  let sidecar: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Cloud vision sidecar reference is invalid')
    }
    sidecar = parsed as Record<string, unknown>
  } catch (error) {
    throw new Error('Cloud vision sidecar reference is invalid', { cause: error })
  }

  const modelName = stringValue(sidecar.modelName)
  const modelType = stringValue(sidecar.modelType)
  const namespace = stringValue(sidecar.namespace)
  const resourceUserId = sidecar.resourceUserId
  const apiFormat = stringValue(sidecar.apiFormat)
  if (
    !modelName ||
    !isCloudModelType(modelType) ||
    !namespace ||
    typeof resourceUserId !== 'number' ||
    !Number.isInteger(resourceUserId) ||
    resourceUserId < 0 ||
    !apiFormat ||
    !['openai-responses', 'openai-chat-completions', 'anthropic-messages'].includes(apiFormat)
  ) {
    throw new Error('Cloud vision sidecar reference is incomplete')
  }

  return {
    enabled: true,
    request_url: `${cloudModelGateway.baseUrl.replace(/\/+$/, '')}/responses`,
    api_format: apiFormat,
    api_key: cloudModelGateway.apiKey,
    model_id: modelName,
    default_headers: {
      'X-Wegent-Model-Type': modelType,
      'X-Wegent-Model-Namespace': namespace,
      'X-Wegent-Model-User-Id': String(resourceUserId),
      'X-Wegent-Upstream-Header-wecode-executor': wecodeExecutorForRuntime(runtime),
      'X-Wegent-Upstream-Header-wecode-source': 'wegent-local',
    },
    max_descriptions_per_turn: 8,
    timeout_ms: 45_000,
  }
}

function wecodeExecutorForRuntime(runtime: string): string {
  const normalized = runtime
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
  return normalized === 'claude' || normalized === 'claudecode' ? 'claudecode' : normalized
}

function localRuntimeModelConfig(
  runtime: string,
  requireCodexCatalog: boolean,
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
    if (requireCodexCatalog && !localModel.catalogReady) {
      throw new Error('Local model requires a Codex restart')
    }
    const requestUrl = buildLocalModelRequestUrl(
      localModel.baseUrl,
      localModel.requestPath,
      localModel.apiFormat
    )
    const visionSidecar = localVisionSidecarConfig(localModel)
    const primaryCodexCatalogModelId =
      localModel.codexCatalogModelId || DEFAULT_GPT_56_CATALOG_MODEL_ID
    return {
      model: 'openai',
      model_id: localModel.modelId,
      wework_model_kind: 'model-interface',
      codex_catalog_model_id: primaryCodexCatalogModelId,
      api_format: RESPONSES_API_FORMAT,
      upstream_api_format: localModel.apiFormat,
      tool_profile: localModel.toolProfile,
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
      ...(visionSidecar ? { vision_sidecar: visionSidecar } : {}),
      ...(localModelDefaultReasoningEffort(localModel)
        ? { reasoning: { effort: localModelDefaultReasoningEffort(localModel) } }
        : {}),
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
    const maxOutputTokens = Number(modelOptions?.[CLOUD_MODEL_MAX_OUTPUT_TOKENS_OPTION])
    const upstreamApiFormat =
      modelOptions?.[CLOUD_MODEL_UPSTREAM_API_FORMAT_OPTION] ?? 'openai-responses'
    const nativeToolSearch =
      modelOptions?.[CLOUD_MODEL_NATIVE_TOOL_SEARCH_OPTION]?.trim().toLowerCase() === 'true'
    const nativeNamespaceTools =
      modelOptions?.[CLOUD_MODEL_NATIVE_NAMESPACE_TOOLS_OPTION]?.trim().toLowerCase() === 'true'
    const visionSidecar = cloudVisionSidecarConfig(runtime, modelOptions, cloudModelGateway)
    const primaryCodexCatalogModelId =
      modelOptions?.[CLOUD_MODEL_CODEX_CATALOG_MODEL_ID_OPTION] || DEFAULT_GPT_56_CATALOG_MODEL_ID
    return {
      model: 'openai',
      model_id: modelName,
      wework_model_kind: 'cloud',
      codex_catalog_model_id: primaryCodexCatalogModelId,
      api_format: RESPONSES_API_FORMAT,
      upstream_api_format: upstreamApiFormat,
      native_tool_search: nativeToolSearch,
      native_namespace_tools: nativeNamespaceTools,
      tool_profile: 'custom',
      protocol: OPENAI_RESPONSES_PROTOCOL,
      base_url: cloudModelGateway.baseUrl,
      api_key: cloudModelGateway.apiKey,
      default_headers: {
        'X-Wegent-Model-Type': modelType,
        'X-Wegent-Model-Namespace': namespace,
        'X-Wegent-Model-User-Id': resourceUserId,
        'X-Wegent-Upstream-Header-wecode-executor': wecodeExecutorForRuntime(runtime),
        'X-Wegent-Upstream-Header-wecode-source': 'wegent-local',
      },
      ...(Number.isFinite(contextWindow) && contextWindow > 0
        ? { model_context_window: contextWindow }
        : {}),
      ...(Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
        ? { max_output_tokens: maxOutputTokens }
        : {}),
      ...(visionSidecar ? { vision_sidecar: visionSidecar } : {}),
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
  const codexProviderType = modelOptions?.codexProviderType || modelOptions?.codex_provider_type
  return {
    model: 'openai',
    model_id: builtInCodexModelId(modelName),
    wework_model_kind: codexProviderType === 'provider' ? 'codex-provider' : 'codex-official',
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

function recordString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function recordNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function harnessProxyUpstream(
  runtime: string,
  option: LocalHarnessModelOption,
  cloudModelGateway?: CloudModelGateway
): Record<string, unknown> {
  const execution = selectedModelExecutionFields(option.model, option.options)
  const config = localRuntimeModelConfig(
    runtime,
    false,
    execution.modelId,
    execution.modelType,
    execution.modelOptions,
    cloudModelGateway
  )
  const baseUrl = recordString(config.base_url)
  const apiFormat = recordString(config.upstream_api_format)
  const apiKey = recordString(config.api_key)
  if (!baseUrl || !apiFormat || !apiKey) {
    throw new Error('Harness model proxy configuration is incomplete')
  }
  const headers =
    config.default_headers &&
    typeof config.default_headers === 'object' &&
    !Array.isArray(config.default_headers)
      ? Object.entries(config.default_headers as Record<string, unknown>).flatMap(
          ([name, value]) => (typeof value === 'string' ? [[name, value]] : [])
        )
      : []
  return {
    base_url: baseUrl,
    request_url: recordString(config.responses_url) ?? `${baseUrl.replace(/\/+$/, '')}/responses`,
    api_format: apiFormat,
    convert_custom_tools: config.tool_profile === 'function',
    native_tool_search: false,
    native_namespace_tools: false,
    api_key: apiKey,
    default_headers: headers,
    proxy_url: getLocalProxyUrl() || null,
    model_id: recordString(config.model_id),
    routing_model_id: null,
    max_output_tokens: recordNumber(config.max_output_tokens),
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
  status: Attachment['status']
  subtask_id: string
  file_extension: string
  local_path?: string
  local_preview_url?: string
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
    if (!localPath && attachment.id <= 0) return

    runtimeAttachments.push({
      id: attachment.id,
      filename: attachment.filename,
      original_filename: attachment.filename,
      file_size: attachment.file_size,
      mime_type: attachment.mime_type,
      status: attachment.status,
      subtask_id: attachment.subtask_id ?? subtaskId,
      file_extension: attachment.file_extension,
      ...(localPath
        ? {
            local_path: localPath,
            local_preview_url: attachment.local_preview_url ?? localPath,
          }
        : {}),
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

function normalizeModifiedAt(value: unknown, errorMessage: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  throw new Error(errorMessage)
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
  runtimeExecutablePath?: string
  runtimePermissionMode?: RuntimeTaskCreateRequest['runtimePermissionMode']
  teamId: number
  title: string
  message: string
  bot?: Array<Record<string, unknown>>
  turnSeed: number
  modelId?: string
  modelType?: string | null
  modelOptions?: RuntimeTaskCreateRequest['modelOptions']
  modelConfig?: Record<string, unknown>
  cloudModelGateway?: CloudModelGateway
  additionalSkills?: RuntimeTaskCreateRequest['additionalSkills']
  additionalContext?: RuntimeTaskCreateRequest['additionalContext']
  attachments?: RuntimeTaskCreateRequest['attachments']
  localDeviceId: string
  workspacePath?: string | null
  standaloneChatWorkspace?: boolean
  runtimeProjectKey?: string
  runtimeProjectName?: string
  runtimeWorkspaceRoots?: string[]
  projectInstructions?: string
  projectPlugins?: RuntimeTaskCreateRequest['projectPlugins']
  cloudProjectId?: string
  origin?: RuntimeTaskCreateRequest['origin']
  workspaceSource: LocalRuntimeWorkspaceSource
  branch?: string | null
  newSession: boolean
  clientUserMessageId?: string
  ephemeral?: boolean
  requireLocalCodexCatalog: boolean
  user: User
}

function messageWithApplicationContext(
  message: string,
  context?: RuntimeTaskCreateRequest['additionalContext'],
  includeImplicitProjectSpaceCapability = true
): string {
  const entries = Object.entries(context ?? {}).filter(([, entry]) => entry.kind === 'application')
  if (
    includeImplicitProjectSpaceCapability &&
    message.includes('cloud://projects') &&
    !context?.projectSpaceCapability
  ) {
    entries.push([
      'projectSpaceCapability',
      {
        kind: 'application',
        value: [
          'Use wework_space as the only interface for WeWork project spaces, board items, files, attachments, and deliveries.',
          'Storage and task providers are internal implementation details.',
          'Do not use git commands or call GitHub, GitLab, or object-storage APIs to inspect or modify project-space data.',
          'Use list_spaces to discover spaces, get_board_item for item details, and read_item_attachment for attachment contents.',
        ].join('\n'),
      },
    ])
  }
  if (entries.length === 0) return message
  const contextText = entries.map(([name, entry]) => `[${name}]\n${entry.value}`).join('\n\n')
  return `<application_context>\n${contextText}\n</application_context>\n\n${message}`
}

function buildLocalRuntimeExecutionRequest(
  input: BuildLocalRuntimeExecutionRequestInput
): Record<string, unknown> {
  const baseSeed = input.taskId || `${input.runtime}:${input.workspacePath ?? ''}:${input.message}`
  const [derivedTaskId, subtaskId] = createRuntimeExecutionIdsFromSeed(
    input.newSession ? baseSeed : `${baseSeed}:${input.turnSeed}`
  )
  const taskId = input.taskId || derivedTaskId
  // The backend resolves gateway routing for cloud/public models in the claim
  // payload; when present that config is authoritative and must not be
  // rebuilt from the catalog entry (which would fall back to the local Codex
  // account and route to chatgpt.com).
  const claudeRuntime = ['claude', 'claudecode', 'claude_code'].includes(
    input.runtime.trim().toLowerCase()
  )
  const baseModelConfig =
    input.modelConfig ??
    (claudeRuntime && !input.modelId
      ? {}
      : localRuntimeModelConfig(
          input.runtime,
          !claudeRuntime && input.requireLocalCodexCatalog,
          input.modelId,
          input.modelType,
          input.modelOptions,
          input.cloudModelGateway
        ))
  const modelConfig = applyRuntimeModelOptions({ ...baseModelConfig }, input.modelOptions)
  const reasoning = runtimeReasoning(input.modelOptions)
  const collaborationMode = runtimeCollaborationMode(input.modelOptions)
  const skillNames = (input.additionalSkills ?? []).map(skillName).filter(isNonEmptyString)
  const requiredSkillNames = input.additionalContext?.dingtalkAITableProject ? ['dws'] : []
  const deployedSkillNames = Array.from(new Set([...skillNames, ...requiredSkillNames]))
  const preloadSkills = [...(input.additionalSkills ?? []), ...requiredSkillNames]
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
      id: input.user.id,
      name: input.user.user_name,
      user_name: input.user.user_name,
      email: input.user.email,
    },
    user_id: input.user.id,
    user_name: input.user.user_name,
    ...(input.cloudModelGateway?.backendUrl
      ? {
          backend_url: input.cloudModelGateway.backendUrl,
          auth_token: input.cloudModelGateway.apiKey,
        }
      : {}),
    bot: input.bot ?? [{ id: 0, shell_type: claudeRuntime ? 'ClaudeCode' : 'Codex' }],
    ...(input.runtimeExecutablePath
      ? { runtime_executable_path: input.runtimeExecutablePath }
      : {}),
    ...(input.runtimePermissionMode ? { claude_permission_mode: input.runtimePermissionMode } : {}),
    mcp_servers: [],
    model_config: modelConfig,
    system_prompt: input.projectInstructions?.trim() ?? '',
    project_plugin_ids: (input.projectPlugins ?? []).map(plugin => plugin.id),
    prompt: messageWithApplicationContext(
      input.message,
      input.additionalContext,
      input.origin?.type !== 'project_automation'
    ),
    enable_tools: true,
    enable_deep_thinking: true,
    skill_names: deployedSkillNames,
    preload_skills: preloadSkills,
    user_selected_skills: preloadSkills,
    ...(workspaceProject
      ? {
          workspace: {
            project: workspaceProject,
          },
          workspace_source: input.workspaceSource,
          project_workspace_path: input.workspacePath,
        }
      : {}),
    ...(input.standaloneChatWorkspace ? { standalone_chat_workspace: true } : {}),
    ...(input.runtimeProjectKey ? { runtime_project_key: input.runtimeProjectKey } : {}),
    ...(input.runtimeProjectName ? { runtime_project_name: input.runtimeProjectName } : {}),
    ...(input.runtimeWorkspaceRoots?.length
      ? { runtime_workspace_roots: input.runtimeWorkspaceRoots }
      : {}),
    ...(input.cloudProjectId ? { cloudProjectId: input.cloudProjectId } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    execution_target_type: 'local',
    device_id: input.localDeviceId,
    new_session: input.newSession,
    ...(input.clientUserMessageId ? { client_user_message_id: input.clientUserMessageId } : {}),
    ephemeral: Boolean(input.ephemeral),
    is_group_chat: false,
    collaboration_model: 'single',
    ...(collaborationMode ? { collaborationMode } : {}),
    mode: 'code',
    task_mode: 'code',
    attachments: localRuntimeAttachments(input.attachments, subtaskId),
    reasoning_config: reasoning,
    runtime_permission_profile: runtimePermissionProfile(runtimePermissionMode(input.modelOptions)),
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
    path?: string
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
): Promise<LocalRuntimeWorkspace | null> {
  const sourceWorkspacePath = runtimeWorkspacePath(data)
  if (!sourceWorkspacePath) {
    if (data.standaloneChatWorkspace) return null
    throw new Error('workspacePath is required')
  }
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

  return {
    workspacePath: sourceWorkspacePath,
    workspaceSource: 'git_worktree',
    branch,
  }
}

async function createLocalRuntimeTaskPayload(
  data: RuntimeTaskCreateRequest,
  localDeviceId: string,
  requestWithLocalDevice: RequestWithLocalDevice,
  cloudModelGateway: CloudModelGateway | undefined,
  user: User,
  requireLocalCodexCatalog: boolean
): Promise<Record<string, unknown>> {
  const runtimeWorkspace = await prepareLocalRuntimeWorkspace(data, requestWithLocalDevice)
  const execution = runtimeWorkspace ? executionWithWorkspace(data, runtimeWorkspace) : null
  const normalizedData: RuntimeTaskCreateRequest = {
    ...data,
    deviceId: localDeviceId,
    ...(runtimeWorkspace ? { workspacePath: runtimeWorkspace.workspacePath } : {}),
    ...(data.modelOptions ? { modelOptions: normalizeModelOptionAliases(data.modelOptions) } : {}),
  }
  if (execution) normalizedData.execution = execution
  const collaborationMode = runtimeCollaborationMode(normalizedData.modelOptions)
  const turnSeed = createRuntimeTurnSeed()
  const payload = { ...normalizedData } as Record<string, unknown>
  const initialSupervisor = normalizedData.initialSupervisor
  if (initialSupervisor?.modelSelection?.modelType === 'runtime') {
    payload.initialSupervisor = {
      ...initialSupervisor,
      modelConfig: applyRuntimeModelOptions(
        localRuntimeModelConfig(
          'codex',
          requireLocalCodexCatalog,
          initialSupervisor.modelSelection.modelName,
          initialSupervisor.modelSelection.modelType,
          initialSupervisor.modelSelection.options,
          cloudModelGateway
        ),
        initialSupervisor.modelSelection.options
      ),
    }
  }
  const friendlyTitleExecutionRequest = normalizedData.friendlyTitle
    ? buildLocalRuntimeExecutionRequest({
        taskId: `friendly-title-${normalizedData.taskId ?? turnSeed}-${createRuntimeTurnSeed()}`,
        runtime: 'codex',
        teamId: normalizedData.teamId,
        title: 'Generate friendly task title',
        message: [
          '为下面的用户请求生成一个简洁、具体、适合作为任务标题的中文标题。',
          '只输出标题本身，不要引号、标点、解释或换行；最多 24 个汉字。',
          '',
          `用户请求：${normalizedData.message}`,
        ].join('\n'),
        turnSeed: createRuntimeTurnSeed(),
        modelId: normalizedData.friendlyTitle.modelId,
        modelType: normalizedData.friendlyTitle.modelType,
        modelOptions: normalizedData.friendlyTitle.modelOptions,
        cloudModelGateway,
        localDeviceId,
        workspacePath: runtimeWorkspace?.workspacePath,
        standaloneChatWorkspace: normalizedData.standaloneChatWorkspace,
        workspaceSource: runtimeWorkspace?.workspaceSource ?? 'local_path',
        branch: runtimeWorkspace?.branch,
        newSession: true,
        ephemeral: true,
        requireLocalCodexCatalog,
        user,
      })
    : null

  return {
    ...payload,
    ...(collaborationMode ? { collaborationMode } : {}),
    ...(friendlyTitleExecutionRequest ? { friendlyTitleExecutionRequest } : {}),
    title: runtimeTaskTitle(normalizedData),
    executionRequest: buildLocalRuntimeExecutionRequest({
      taskId: normalizedData.taskId,
      runtime: normalizedData.runtime,
      runtimeExecutablePath: normalizedData.runtimeExecutablePath,
      runtimePermissionMode: normalizedData.runtimePermissionMode,
      teamId: normalizedData.teamId,
      title: runtimeTaskTitle(normalizedData),
      message: normalizedData.message,
      bot: normalizedData.bot,
      turnSeed,
      modelId: normalizedData.modelId,
      modelType: normalizedData.modelType,
      modelOptions: normalizedData.modelOptions,
      modelConfig: normalizedData.modelConfig,
      cloudModelGateway,
      additionalSkills: normalizedData.additionalSkills,
      additionalContext: normalizedData.additionalContext,
      attachments: normalizedData.attachments,
      localDeviceId,
      workspacePath: runtimeWorkspace?.workspacePath,
      standaloneChatWorkspace: normalizedData.standaloneChatWorkspace,
      runtimeProjectKey: normalizedData.runtimeProjectKey,
      runtimeProjectName: normalizedData.runtimeProjectName,
      runtimeWorkspaceRoots: normalizedData.runtimeWorkspaceRoots,
      projectInstructions: normalizedData.projectInstructions,
      projectPlugins: normalizedData.projectPlugins,
      cloudProjectId: normalizedData.cloudProjectId,
      origin: normalizedData.origin,
      workspaceSource: runtimeWorkspace?.workspaceSource ?? 'local_path',
      branch: runtimeWorkspace?.branch,
      newSession: true,
      clientUserMessageId: normalizedData.clientUserMessageId,
      ephemeral: normalizedData.ephemeral,
      requireLocalCodexCatalog,
      user,
    }),
  } as unknown as Record<string, unknown>
}

function createLocalRuntimeSendPayload(
  data: RuntimeSendRequest,
  localDeviceId: string,
  cloudModelGateway: CloudModelGateway | undefined,
  user: User,
  requireLocalCodexCatalog: boolean
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
  const runtime =
    stringValue(normalizedAddress.runtime) ??
    stringValue(recordValue(normalizedAddress.runtimeHandle).runtime) ??
    'codex'

  if (normalizedData.requestUserInputResponse || normalizedData.request_user_input_response) {
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
        runtime,
        teamId: LOCAL_WORKBENCH_TEAM.id,
        title: taskId,
        message: normalizedData.message,
        turnSeed,
        modelId: normalizedData.modelId,
        modelType: normalizedData.modelType,
        modelOptions: normalizedData.modelOptions,
        cloudModelGateway,
        attachments: normalizedData.attachments,
        additionalContext: normalizedData.additionalContext,
        cloudProjectId: normalizedData.cloudProjectId,
        origin: normalizedData.origin,
        localDeviceId,
        workspacePath,
        workspaceSource: 'local_path',
        newSession: false,
        clientUserMessageId: normalizedData.clientUserMessageId,
        ephemeral: data.ephemeral,
        requireLocalCodexCatalog,
        user,
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
    ...(normalizedData.modelId
      ? {
          modelSelection: {
            modelName: normalizedData.modelId,
            modelType: normalizedData.modelType ?? null,
            options: normalizedData.modelOptions ?? {},
          },
        }
      : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
    executionRequest: buildLocalRuntimeExecutionRequest({
      taskId,
      runtime,
      teamId: LOCAL_WORKBENCH_TEAM.id,
      title: taskId,
      message: normalizedData.message,
      turnSeed,
      modelId: normalizedData.modelId,
      modelType: normalizedData.modelType,
      modelOptions: normalizedData.modelOptions,
      cloudModelGateway,
      attachments: normalizedData.attachments,
      additionalContext: normalizedData.additionalContext,
      cloudProjectId: normalizedData.cloudProjectId,
      origin: normalizedData.origin,
      localDeviceId,
      workspacePath,
      workspaceSource: 'local_path',
      newSession: false,
      clientUserMessageId: normalizedData.clientUserMessageId,
      ephemeral: data.ephemeral,
      requireLocalCodexCatalog,
      user,
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
      id: stableLocalId(`${workspaceDeviceId}\0${workspacePath}`),
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
    const rawDefaultProjectSpace = recordValue(
      workspace.defaultProjectSpace ?? workspace.default_project_space
    )
    const defaultProjectStore = stringValue(rawDefaultProjectSpace.projectStore)
    const defaultProjectId = stringValue(rawDefaultProjectSpace.projectId)
    const defaultProjectSpace: RuntimeProjectSpaceRef | null =
      (defaultProjectStore === 'local' || defaultProjectStore === 'backend') && defaultProjectId
        ? { projectStore: defaultProjectStore, projectId: defaultProjectId }
        : null
    const rawProjectAiSettings = recordValue(
      workspace.projectAiSettings ?? workspace.project_ai_settings
    )
    const projectInstructions =
      typeof rawProjectAiSettings.instructions === 'string'
        ? rawProjectAiSettings.instructions
        : undefined
    const projectModelSelection = modelSelectionValue(
      rawProjectAiSettings.modelSelection ?? rawProjectAiSettings.model_selection
    )
    const projectPlugins = Array.isArray(rawProjectAiSettings.plugins)
      ? rawProjectAiSettings.plugins
          .map(plugin => {
            const value = recordValue(plugin)
            const id = stringValue(value.id)
            const pluginName = stringValue(value.pluginName ?? value.plugin_name)
            const marketplaceId = stringValue(value.marketplaceId ?? value.marketplace_id)
            const displayName = stringValue(value.displayName ?? value.display_name)
            return id && pluginName && marketplaceId
              ? { id, pluginName, marketplaceId, displayName: displayName || pluginName }
              : null
          })
          .filter((plugin): plugin is NonNullable<typeof plugin> => plugin !== null)
      : []
    const rawProjectQuickPhrases =
      rawProjectAiSettings.quickPhrases ?? rawProjectAiSettings.quick_phrases
    const projectQuickPhrases = Array.isArray(rawProjectQuickPhrases)
      ? rawProjectQuickPhrases
          .map((phrase): RuntimeProjectQuickPhrase | null => {
            const value = recordValue(phrase)
            const id = stringValue(value.id)
            const title = stringValue(value.title)
            const content = stringValue(value.content)
            const mode = stringValue(value.mode)
            return id &&
              title &&
              content &&
              (mode === 'normal' || mode === 'plan' || mode === 'goal')
              ? { id, title, content, mode }
              : null
          })
          .filter((phrase): phrase is NonNullable<typeof phrase> => phrase !== null)
      : []
    const aiSettings =
      projectInstructions !== undefined ||
      projectModelSelection ||
      projectPlugins.length > 0 ||
      projectQuickPhrases.length > 0
        ? {
            ...(projectInstructions !== undefined ? { instructions: projectInstructions } : {}),
            modelSelection: projectModelSelection,
            ...(projectPlugins.length > 0 ? { plugins: projectPlugins } : {}),
            ...(projectQuickPhrases.length > 0 ? { quickPhrases: projectQuickPhrases } : {}),
          }
        : null
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
        ...(defaultProjectSpace ? { defaultProjectSpace } : {}),
        ...(aiSettings ? { aiSettings } : {}),
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
  const user = options.user ?? LOCAL_USER
  const requireLocalCodexCatalog = options.syncConfiguredModelCatalog !== true
  const resolveDeviceId = options.resolveDeviceId ?? (() => getDefaultDeviceId())
  const normalizeDeviceRecord = options.normalizeDeviceRecord ?? normalizeLocalDeviceRecord
  const adaptListResponse = options.adaptListResponse ?? adaptRuntimeWorkListResponse
  const syncedModelCatalogKeys = new Set<string>()
  const modelCatalogSyncInFlight = new Map<string, Promise<boolean>>()
  const modelCatalogSyncQueues = new Map<string, Promise<void>>()
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

  const prepareRuntimeModel = async (data: RuntimeModelPrepareRequest): Promise<boolean> => {
    const selectedModel = findLocalModelConfigByModelName(data.modelId)
    if (!options.syncConfiguredModelCatalog) return true
    if (!selectedModel?.catalogEntry) return true

    const catalogModels = listLocalModelConfigs().filter(model => model.catalogEntry)
    const catalogKey = catalogModels
      .map(model => `${model.id}:${model.updatedAt}`)
      .sort()
      .join('|')
    const deviceId = await resolveDeviceId(data as unknown as Record<string, unknown>)
    const deviceCatalogKey = `${deviceId}\0${catalogKey}`
    console.info('[Wework] Cloud model catalog preparation started', {
      deviceId,
      modelId: data.modelId,
      catalogModelCount: catalogModels.length,
      alreadySynced: syncedModelCatalogKeys.has(deviceCatalogKey),
      syncInFlight: modelCatalogSyncInFlight.has(deviceCatalogKey),
    })
    if (syncedModelCatalogKeys.has(deviceCatalogKey)) {
      console.info('[Wework] Cloud model catalog preparation reused synced catalog', {
        deviceId,
        modelId: data.modelId,
      })
      return true
    }
    const pendingSync = modelCatalogSyncInFlight.get(deviceCatalogKey)
    if (pendingSync) {
      console.info('[Wework] Cloud model catalog preparation joined pending sync', {
        deviceId,
        modelId: data.modelId,
      })
      return pendingSync
    }
    let appliedCatalogKey = ''
    const sync = async () => {
      const previousSync = modelCatalogSyncQueues.get(deviceId) ?? Promise.resolve()
      const queuedSync = previousSync
        .catch(() => undefined)
        .then(async () => {
          console.info('[Wework] Cloud model catalog sync started', {
            deviceId,
            modelId: data.modelId,
          })
          const currentCatalogModels = listLocalModelConfigs().filter(model => model.catalogEntry)
          const currentCatalogKey = currentCatalogModels
            .map(model => `${model.id}:${model.updatedAt}`)
            .sort()
            .join('|')
          const currentDeviceCatalogKey = `${deviceId}\0${currentCatalogKey}`
          if (syncedModelCatalogKeys.has(currentDeviceCatalogKey)) {
            appliedCatalogKey = currentCatalogKey
            console.info('[Wework] Cloud model catalog sync reused queued result', {
              deviceId,
              modelId: data.modelId,
            })
            return
          }
          const currentSelectedModel = findLocalModelConfigByModelName(data.modelId)
          const expectedModelId =
            currentSelectedModel?.codexCatalogModelId ??
            (typeof currentSelectedModel?.catalogEntry?.slug === 'string'
              ? currentSelectedModel.catalogEntry.slug
              : undefined)
          await request(
            'runtime.codex.catalog.custom.write',
            {
              models: currentCatalogModels.flatMap(model =>
                model.catalogEntry ? [model.catalogEntry] : []
              ),
            },
            deviceId
          )
          console.info('[Wework] Cloud model catalog write completed', {
            deviceId,
            modelId: data.modelId,
            catalogModelCount: currentCatalogModels.length,
          })
          let restart: {
            restarted?: boolean
            requiresConfirmation?: boolean
          }
          try {
            restart = await request('runtime.codex.app_server.restart', { ifIdle: true }, deviceId)
          } catch (error) {
            if (error instanceof Error && error.message.includes('codex_catalog_not_loaded')) {
              throw new Error(i18n.t('workbench.cloud_model_catalog_sync_verify_failed'), {
                cause: error,
              })
            }
            throw error
          }
          console.info('[Wework] Cloud Codex app server restart completed', {
            deviceId,
            modelId: data.modelId,
            restarted: restart.restarted === true,
            requiresConfirmation: restart.requiresConfirmation === true,
          })
          if (!restart.restarted) {
            throw new Error(
              restart.requiresConfirmation
                ? i18n.t('workbench.cloud_model_catalog_sync_busy')
                : i18n.t('workbench.cloud_model_catalog_sync_failed')
            )
          }
          const models = await request<{
            data?: Array<{ id?: string }>
          }>('runtime.codex.models.list', { includeHidden: true }, deviceId)
          const expectedModelAvailable = Boolean(
            expectedModelId && models.data?.some(model => model.id === expectedModelId)
          )
          console.info('[Wework] Cloud model catalog verification completed', {
            deviceId,
            modelId: data.modelId,
            expectedModelId: expectedModelId ?? null,
            expectedModelAvailable,
            availableModelCount: models.data?.length ?? 0,
          })
          if (!expectedModelAvailable) {
            throw new Error(i18n.t('workbench.cloud_model_catalog_sync_verify_failed'))
          }
          appliedCatalogKey = currentCatalogKey
          syncedModelCatalogKeys.add(currentDeviceCatalogKey)
        })
      const queueTail = queuedSync.then(
        () => undefined,
        () => undefined
      )
      modelCatalogSyncQueues.set(deviceId, queueTail)
      try {
        await queuedSync
      } finally {
        if (modelCatalogSyncQueues.get(deviceId) === queueTail) {
          modelCatalogSyncQueues.delete(deviceId)
        }
      }
    }

    const confirmation = options.requestModelCatalogSync
    if (!confirmation) {
      throw new Error(i18n.t('workbench.cloud_model_catalog_sync_failed'))
    }
    console.info('[Wework] Cloud model catalog confirmation requested', {
      deviceId,
      modelId: data.modelId,
      modelName: selectedModel.displayName,
    })
    const syncPromise = confirmation({
      deviceId,
      deviceName: options.resolveDeviceName?.(deviceId) ?? deviceId,
      modelName: selectedModel.displayName,
      sync,
    }).then(confirmed => {
      console.info('[Wework] Cloud model catalog confirmation settled', {
        deviceId,
        modelId: data.modelId,
        confirmed,
        catalogApplied: Boolean(appliedCatalogKey),
      })
      const currentCatalogKey = listLocalModelConfigs()
        .filter(model => model.catalogEntry)
        .map(model => `${model.id}:${model.updatedAt}`)
        .sort()
        .join('|')
      if (confirmed && appliedCatalogKey && currentCatalogKey === appliedCatalogKey) {
        syncedModelCatalogKeys.add(`${deviceId}\0${appliedCatalogKey}`)
      }
      return confirmed
    })
    modelCatalogSyncInFlight.set(deviceCatalogKey, syncPromise)
    try {
      const confirmed = await syncPromise
      console.info('[Wework] Cloud model catalog preparation completed', {
        deviceId,
        modelId: data.modelId,
        confirmed,
      })
      return confirmed
    } finally {
      if (modelCatalogSyncInFlight.get(deviceCatalogKey) === syncPromise) {
        modelCatalogSyncInFlight.delete(deviceCatalogKey)
      }
    }
  }

  return {
    prepareRuntimeModel,
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
    getRuntimeSettings(): Promise<RuntimeSettings> {
      return request('runtime.settings.get', {})
    },
    updateRuntimeSettings(data: RuntimeSettings): Promise<RuntimeSettings> {
      return request('runtime.settings.update', {
        maxConcurrentTasks: data.maxConcurrentTasks,
      })
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
    async revertRuntimeFileChanges(
      data: RuntimeFileChangesRevertRequest
    ): Promise<RuntimeFileChangesRevertResponse> {
      const summary = data.fileChanges
      if (summary.status === 'reverted') {
        return { fileChanges: summary }
      }
      const response = await executeLocalDeviceCommand(
        requestWithLocalDevice,
        {
          deviceId: data.address.deviceId,
          command_key: 'turn_file_changes_revert',
          path: summary.workspace_path,
          args: [summary.artifact_id],
          timeout_seconds: 30,
          max_output_bytes: 5 * 1024 * 1024,
        },
        'Failed to revert runtime file changes'
      )
      const payload = recordValue(response.stdout)
      const status = stringValue(payload.status)
      if (status === 'conflicted' || status === 'artifact_missing') {
        return {
          fileChanges: {
            ...summary,
            status,
          },
        }
      }
      if (payload.success !== true || status !== 'reverted') {
        throw new Error(
          stringValue(payload.error) ?? 'Local executor returned an invalid file changes result'
        )
      }
      return {
        fileChanges: {
          ...summary,
          status: 'reverted',
          reverted_at: new Date().toISOString(),
        },
      }
    },
    async sendRuntimeMessage(data: RuntimeSendRequest): Promise<RuntimeSendResponse> {
      const localDeviceId = await resolveDeviceId(data as unknown as Record<string, unknown>)
      if (!(await prepareRuntimeModel({ deviceId: localDeviceId, modelId: data.modelId }))) {
        throw modelCatalogSyncCancelled()
      }
      const payload = createLocalRuntimeSendPayload(
        data,
        localDeviceId,
        options.cloudModelGateway,
        user,
        requireLocalCodexCatalog
      )
      logLocalIssueRuntimeContext('send-payload-built', data, payload)
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
      if (!(await prepareRuntimeModel({ deviceId: localDeviceId, modelId: data.modelId }))) {
        throw modelCatalogSyncCancelled()
      }
      const payload = createLocalRuntimeSendPayload(
        data,
        localDeviceId,
        options.cloudModelGateway,
        user,
        requireLocalCodexCatalog
      )
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
    async interruptAndSendRuntimeMessage(
      data: RuntimeInterruptAndSendRequest
    ): Promise<RuntimeSendResponse> {
      const localDeviceId = await resolveDeviceId(data as unknown as Record<string, unknown>)
      if (!(await prepareRuntimeModel({ deviceId: localDeviceId, modelId: data.modelId }))) {
        throw modelCatalogSyncCancelled()
      }
      const payload = createLocalRuntimeSendPayload(
        data,
        localDeviceId,
        options.cloudModelGateway,
        user,
        requireLocalCodexCatalog
      )
      if (!payload.executionRequest) {
        console.warn('[Wework] Local runtime interrupt payload missing executionRequest', {
          taskId: payload.taskId,
          address: runtimeAddressDebug(payload),
          payloadKeys: Object.keys(payload).sort(),
        })
        throw new Error('Runtime interrupt payload missing executionRequest')
      }
      console.debug('[Wework] Local runtime interrupt payload', {
        taskId: payload.taskId,
        address: runtimeAddressDebug(payload),
        payloadKeys: Object.keys(payload).sort(),
      })
      return request('runtime.tasks.interrupt_and_send', payload, localDeviceId)
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
    getRuntimeSupervisor(data: RuntimeSupervisorGetRequest): Promise<RuntimeSupervisorResponse> {
      return requestWithLocalDevice('runtime.tasks.supervisor.get', data)
    },
    async setRuntimeSupervisor(
      data: RuntimeSupervisorSetRequest
    ): Promise<RuntimeSupervisorResponse> {
      const selection = data.modelSelection
      if (selection?.modelType !== 'runtime') {
        return requestWithLocalDevice('runtime.tasks.supervisor.set', data)
      }
      const localDeviceId = await resolveDeviceId({ address: data.address })
      if (
        !(await prepareRuntimeModel({
          deviceId: localDeviceId,
          modelId: selection.modelName,
        }))
      ) {
        throw modelCatalogSyncCancelled()
      }
      const modelConfig = applyRuntimeModelOptions(
        localRuntimeModelConfig(
          'codex',
          requireLocalCodexCatalog,
          selection.modelName,
          selection.modelType,
          selection.options,
          options.cloudModelGateway
        ),
        selection.options
      )
      const normalizedAddress = normalizeLocalDeviceRecord({ address: data.address }, localDeviceId)
        .address as RuntimeTaskAddress
      return request(
        'runtime.tasks.supervisor.set',
        {
          ...data,
          address: normalizedAddress,
          modelConfig,
        },
        localDeviceId
      )
    },
    clearRuntimeSupervisor(
      data: RuntimeSupervisorClearRequest
    ): Promise<RuntimeSupervisorResponse> {
      return requestWithLocalDevice('runtime.tasks.supervisor.clear', data)
    },
    runRuntimeSupervisorNow(
      data: RuntimeSupervisorRunNowRequest
    ): Promise<RuntimeSupervisorResponse> {
      return requestWithLocalDevice('runtime.tasks.supervisor.run_now', data)
    },
    resolveRuntimeSupervisor(
      data: RuntimeSupervisorResolveRequest
    ): Promise<RuntimeSupervisorResponse> {
      return requestWithLocalDevice('runtime.tasks.supervisor.resolve', data)
    },
    openRuntimeWorkspace(data: RuntimeWorkspaceOpenRequest): Promise<RuntimeWorkspaceOpenResponse> {
      return requestWithLocalDevice('runtime.workspaces.open', data)
    },
    upsertLocalRuntimeProject(
      data: RuntimeLocalProjectUpsertRequest
    ): Promise<RuntimeLocalProjectUpsertResponse> {
      return requestWithLocalDevice('runtime.projects.upsert_local', data)
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
    getWorktreeCapabilities(
      data: RuntimeWorktreeCapabilitiesRequest
    ): Promise<RuntimeWorktreeCapabilitiesResponse> {
      return requestWithLocalDevice('runtime.worktrees.capabilities', data)
    },
    preflightWorktree(
      data: RuntimeWorktreePreflightRequest
    ): Promise<RuntimeWorktreePreflightResponse> {
      return requestWithLocalDevice('runtime.worktrees.preflight', data)
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
    updateImNotificationPresence() {
      return cloudConnectionRequired('updateImNotificationPresence')
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
      const startedAt = Date.now()
      logRuntimeTaskCreateStage('local-create-started', {
        taskId: data.taskId ?? null,
        deviceId: data.deviceId ?? null,
        runtime: data.runtime,
      })
      const localDeviceId = await resolveDeviceId(data as unknown as Record<string, unknown>)
      logRuntimeTaskCreateStage('local-device-resolved', {
        taskId: data.taskId ?? null,
        requestedDeviceId: data.deviceId ?? null,
        deviceId: localDeviceId,
        elapsedMs: Date.now() - startedAt,
      })
      if (!(await prepareRuntimeModel({ deviceId: localDeviceId, modelId: data.modelId }))) {
        throw modelCatalogSyncCancelled()
      }
      logRuntimeTaskCreateStage('local-primary-model-prepared', {
        taskId: data.taskId ?? null,
        deviceId: localDeviceId,
        modelId: data.modelId ?? null,
        elapsedMs: Date.now() - startedAt,
      })
      const supervisorModelId = data.initialSupervisor?.modelSelection?.modelName
      if (
        supervisorModelId &&
        !(await prepareRuntimeModel({ deviceId: localDeviceId, modelId: supervisorModelId }))
      ) {
        throw modelCatalogSyncCancelled()
      }
      logRuntimeTaskCreateStage('local-supervisor-model-prepared', {
        taskId: data.taskId ?? null,
        deviceId: localDeviceId,
        supervisorModelId: supervisorModelId ?? null,
        elapsedMs: Date.now() - startedAt,
      })
      const payload = await createLocalRuntimeTaskPayload(
        data,
        localDeviceId,
        requestWithLocalDevice,
        options.cloudModelGateway,
        user,
        requireLocalCodexCatalog
      )
      logRuntimeTaskCreateStage('local-payload-built', {
        taskId: data.taskId ?? null,
        deviceId: localDeviceId,
        elapsedMs: Date.now() - startedAt,
      })
      debugLocalRuntimeCreatePayload(data, payload)
      logLocalIssueRuntimeContext('create-payload-built', data, payload)
      const executionRequest = recordValue(payload.executionRequest)
      console.info('[Wework] Friendly task title request', {
        taskId: data.taskId,
        enabled: Boolean(data.friendlyTitle),
        executionRequestIncluded: Boolean(payload.friendlyTitleExecutionRequest),
        modelId: data.friendlyTitle?.modelId ?? null,
      })
      console.info('[Wework] Local runtime execution identity', {
        taskId: stringValue(executionRequest.task_id),
        userId: executionRequest.user_id ?? null,
        userName: stringValue(executionRequest.user_name),
      })
      logRuntimeTaskCreateStage('local-rpc-dispatched', {
        taskId: data.taskId ?? null,
        deviceId: localDeviceId,
        method: 'runtime.tasks.create',
        elapsedMs: Date.now() - startedAt,
      })
      const response = await request<Partial<RuntimeTaskCreateResponse>>(
        'runtime.tasks.create',
        payload,
        localDeviceId
      )
      logRuntimeTaskCreateStage('local-rpc-resolved', {
        taskId: data.taskId ?? null,
        deviceId: localDeviceId,
        elapsedMs: Date.now() - startedAt,
        accepted: response.accepted ?? true,
      })
      const responseRecord = recordValue(response)
      const workspacePath =
        stringValue(responseRecord.workspacePath) ??
        stringValue(responseRecord.workspace_path) ??
        stringValue(payload.workspacePath) ??
        requiredRuntimeWorkspacePath(data)
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
        workspacePath,
        runtime: response.runtime ?? data.runtime,
        ...(Object.keys(runtimeHandle).length > 0 ? { runtimeHandle } : {}),
      }
    },
    forceStartRuntimeTask(address: RuntimeTaskAddress): Promise<RuntimeTaskCancelResponse> {
      return requestWithLocalDevice('runtime.tasks.force_start', address)
    },
    reorderQueuedRuntimeTask(
      data: RuntimeTaskQueueReorderRequest
    ): Promise<RuntimeTaskQueueReorderResponse> {
      return requestWithLocalDevice('runtime.tasks.queue.reorder', data)
    },
    forkRuntimeTask(data: RuntimeTaskForkRequest): Promise<RuntimeTaskForkResponse> {
      if (data.lastTurnId) {
        return requestWithLocalDevice('runtime.tasks.fork_at_turn', {
          ...data,
          taskId: data.source.taskId,
        })
      }
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

function logLocalIssueRuntimeContext(
  stage: string,
  request: RuntimeTaskCreateRequest | RuntimeSendRequest,
  payload: Record<string, unknown>
) {
  if (request.origin?.type !== 'board_task') return
  const executionRequest = recordValue(payload.executionRequest)
  const executionOrigin = recordValue(executionRequest.origin)
  console.info('[Wework] Issue runtime context trace', {
    stage,
    taskId:
      'address' in request
        ? request.address.taskId
        : (request.taskId ?? stringValue(executionRequest.task_id)),
    deviceId:
      'address' in request ? request.address.deviceId : (request.deviceId ?? payload.deviceId),
    requestCloudProjectId: request.cloudProjectId ?? null,
    requestOriginType: request.origin.type,
    requestLoopItemId: request.origin.loopItemId,
    requestAdditionalContextKeys: Object.keys(request.additionalContext ?? {}).sort(),
    payloadCloudProjectId: stringValue(payload.cloudProjectId),
    payloadOriginType: stringValue(recordValue(payload.origin).type),
    executionCloudProjectId: stringValue(executionRequest.cloudProjectId),
    executionOriginType: stringValue(executionOrigin.type),
    executionLoopItemId: stringValue(executionOrigin.loopItemId),
  })
}

function normalizeLocalAutomationSchedule(
  schedule: Automation['schedule'] | { type: 'one_time'; execute_at: string }
): Automation['schedule'] {
  if (schedule.type !== 'one_time') return schedule
  return {
    type: 'one_time',
    executeAt: 'executeAt' in schedule ? schedule.executeAt : schedule.execute_at,
  }
}

function serializeLocalAutomationSchedule(
  schedule: AutomationMutation['schedule']
): AutomationMutation['schedule'] | { type: 'one_time'; execute_at: string } {
  if (schedule.type !== 'one_time') return schedule
  return { type: 'one_time', execute_at: schedule.executeAt }
}

function withAutomationSource(automation: Automation, source: AutomationSource): Automation {
  return {
    ...automation,
    source,
    schedule: normalizeLocalAutomationSchedule(
      automation.schedule as Automation['schedule'] | { type: 'one_time'; execute_at: string }
    ),
  }
}

function withAutomationRunSource(
  run: AutomationRun,
  source: AutomationSource,
  deviceId: string
): AutomationRun {
  return { ...run, source, deviceId: run.deviceId ?? deviceId }
}

export function createAutomationApiFromIpc(
  request: <T>(method: string, params?: Record<string, unknown>, deviceId?: string) => Promise<T>,
  requestWithLocalDevice: RequestWithLocalDevice,
  options: AutomationIpcOptions,
  automationDeviceId = LOCAL_DEVICE_ID,
  source: AutomationSource = 'local'
): NonNullable<WorkbenchServices['automationApi']> {
  const user = options.user ?? LOCAL_USER
  const requireLocalCodexCatalog = options.syncConfiguredModelCatalog !== true
  const resolveDeviceId =
    options.resolveDeviceId ??
    (async (data?: Record<string, unknown>) => stringValue(data?.deviceId) ?? LOCAL_DEVICE_ID)

  const prepareAutomation = async (data: AutomationMutation) => {
    const localDeviceId = await resolveDeviceId(
      data.taskRequest as unknown as Record<string, unknown>
    )
    const continuationRequest =
      data.conversationMode === 'continue_thread' && data.continuationPayload
        ? (data.continuationPayload as unknown as RuntimeSendRequest)
        : null
    const modelIds = new Set(
      [
        data.taskRequest.modelId,
        data.taskRequest.initialSupervisor?.modelSelection?.modelName,
        continuationRequest?.modelId,
      ].filter((modelId): modelId is string => Boolean(modelId))
    )
    for (const modelId of modelIds) {
      if (!(await options.prepareRuntimeModel({ deviceId: localDeviceId, modelId }))) {
        throw modelCatalogSyncCancelled()
      }
    }
    const taskPayload = await createLocalRuntimeTaskPayload(
      data.taskRequest,
      localDeviceId,
      requestWithLocalDevice,
      options.cloudModelGateway,
      user,
      requireLocalCodexCatalog
    )
    const continuationPayload = continuationRequest
      ? createLocalRuntimeSendPayload(
          continuationRequest,
          localDeviceId,
          options.cloudModelGateway,
          user,
          requireLocalCodexCatalog
        )
      : null
    return {
      id: data.id ?? '',
      version: data.version ?? 0,
      name: data.name,
      description: data.description ?? '',
      prompt: data.prompt,
      schedule: serializeLocalAutomationSchedule(data.schedule),
      timezone: data.timezone,
      enabled: data.enabled,
      conversationMode: data.conversationMode,
      taskPayload,
      continuationPayload,
    }
  }

  return {
    async listAutomations(): Promise<AutomationListResponse> {
      const response = await request<{ items?: Automation[] }>(
        'runtime.automations.list',
        {},
        automationDeviceId
      )
      return { items: (response.items ?? []).map(item => withAutomationSource(item, source)) }
    },
    async getAutomation(automationId: string) {
      const response = await request<{ automation: Automation }>(
        'runtime.automations.get',
        { automationId },
        automationDeviceId
      )
      return { automation: withAutomationSource(response.automation, source) }
    },
    async createAutomation(data: AutomationMutation) {
      const automation = await prepareAutomation(data)
      const response = await request<{ automation: Automation }>(
        'runtime.automations.create',
        { automation },
        automationDeviceId
      )
      return { automation: withAutomationSource(response.automation, source) }
    },
    async updateAutomation(_automationId: string, data: AutomationMutation) {
      const automation = await prepareAutomation(data)
      const response = await request<{ automation: Automation }>(
        'runtime.automations.update',
        { automation },
        automationDeviceId
      )
      return { automation: withAutomationSource(response.automation, source) }
    },
    deleteAutomation(automationId: string) {
      return request<{ deleted: boolean }>(
        'runtime.automations.delete',
        { automationId },
        automationDeviceId
      )
    },
    async toggleAutomation(automationId: string, enabled: boolean) {
      const response = await request<{ automation: Automation }>(
        'runtime.automations.toggle',
        { automationId, enabled },
        automationDeviceId
      )
      return { automation: withAutomationSource(response.automation, source) }
    },
    async runAutomationNow(automationId: string) {
      const response = await request<{ run: AutomationRun | null }>(
        'runtime.automations.run_now',
        { automationId },
        automationDeviceId
      )
      return {
        run: response.run
          ? withAutomationRunSource(response.run, source, automationDeviceId)
          : null,
      }
    },
    async listAutomationRuns(automationId?: string): Promise<AutomationRunListResponse> {
      const response = await request<{ items?: AutomationRun[] }>(
        'runtime.automation_runs.list',
        automationId ? { automationId } : {},
        automationDeviceId
      )
      return {
        items: (response.items ?? []).map(item =>
          withAutomationRunSource(item, source, automationDeviceId)
        ),
      }
    },
  }
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
  const readWorkspaceTextFile = deps.readWorkspaceTextFile ?? readLocalWorkspaceTextFile
  const readWorkspaceFileChunk = deps.readWorkspaceFileChunk ?? readLocalWorkspaceFileChunk
  const listWorkspaceEntries = deps.listWorkspaceEntries ?? listLocalWorkspaceEntries
  let lastStatus: LocalExecutorStatus | null = null
  let ensurePromise: Promise<LocalExecutorStatus> | null = null

  const ensureStatus = async () => {
    if (!ensurePromise) {
      ensurePromise = ensure()
        .then(async status => {
          lastStatus = status
          reconcileLocalModelCatalogRuntime(status.runtimeInstanceId)
          await reconcilePendingLocalModelCatalog(request, status.runtimeInstanceId)
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
    async getRuntimeSettings(deviceId: string) {
      const settings = await runtimeWorkApi.getRuntimeSettings()
      return {
        device_id: deviceId,
        max_concurrent_tasks: settings.maxConcurrentTasks,
        active_tasks: 0,
        queued_tasks: 0,
      }
    },
    async updateRuntimeSettings(deviceId: string, maxConcurrentTasks: number) {
      const settings = await runtimeWorkApi.updateRuntimeSettings({ maxConcurrentTasks })
      return {
        device_id: deviceId,
        max_concurrent_tasks: settings.maxConcurrentTasks,
        active_tasks: 0,
        queued_tasks: 0,
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
    async listWorkspaceEntries(
      _deviceId: string,
      path: string,
      workspaceRoot = path
    ): Promise<WorkspaceTreeResponse> {
      return listWorkspaceEntries(workspaceRoot, path)
    },
    async readWorkspaceTextFile(
      _deviceId: string,
      filePath: string,
      workspaceRoot: string
    ): Promise<WorkspaceTextFileResponse> {
      return readWorkspaceTextFile(workspaceRoot, filePath)
    },
    async readWorkspaceFileChunk(
      _deviceId: string,
      filePath: string,
      offset: number,
      workspaceRoot: string
    ) {
      return readWorkspaceFileChunk(workspaceRoot, filePath, offset)
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
      user: deps.user,
    }
  ) as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>
  const automationApi = createAutomationApiFromIpc(
    request,
    (method, params) => request(method, params as Record<string, unknown>),
    {
      cloudModelGateway: deps.cloudModelGateway,
      user: deps.user,
      prepareRuntimeModel: data => runtimeWorkApi.prepareRuntimeModel(data),
    }
  )
  const deliveryApi = createLocalDeliveryApi(request)
  const externalIssueApi = createExternalIssueApi(request)
  // Local project-space identity is the local session user, not the connected
  // cloud account. The approval/creator checks compare against LOCAL_USER, so
  // robots created with the cloud user id would never be approvable locally.
  const localProjectChatAgentApi = createLocalProjectChatAgentApi(request, LOCAL_USER.id)
  const localLoopItemExecutionApi = createLocalLoopItemExecutionApi(request)
  const localProjectChatClient = createLocalProjectChatClient(request, {
    currentUser: LOCAL_USER,
  })
  const aitableApi = createLocalAITableApi(request)
  const dwsApi = createDwsApi(request)
  const teamApi = {
    listTeams: async () => [LOCAL_WORKBENCH_TEAM],
    getDefaultWorkbenchTeam: async () => LOCAL_WORKBENCH_TEAM,
  }
  const modelApi = {
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
  }

  return {
    teamApi,
    modelApi,
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
    deliveryApi,
    externalIssueApi,
    localProjectChatAgentApi,
    localLoopItemExecutionApi,
    localHarnessModelApi: {
      async resolveLaunch(harnessId: LocalHarnessId, option: LocalHarnessModelOption | null) {
        if (!option) return null
        await ensureStatus()
        const registration = await request<HarnessProxyRegistration>(
          'runtime.harness_proxy.register',
          {
            scope: `harness:${harnessId}:${crypto.randomUUID()}`,
            upstream: harnessProxyUpstream(harnessId, option, deps.cloudModelGateway),
          }
        )
        const launch = harnessLaunchThroughMessagesProxy(harnessId, option, registration)
        if (harnessId !== 'opencode') return launch
        try {
          const context = await request<HarnessContextRegistration>(
            'runtime.harness_context.register',
            {
              scope: 'harness:' + harnessId + ':' + crypto.randomUUID(),
              user: buildHarnessUserContext(
                deps.user ?? getLocalUser(),
                deps.cloudModelGateway ? 'cloud' : 'local'
              ),
              model: buildHarnessModelContext(option),
            }
          )
          return { ...launch, context }
        } catch (error) {
          await request('runtime.harness_proxy.unregister', { token: registration.token }).catch(
            () => undefined
          )
          throw error
        }
      },
      async unregisterProxy(token: string) {
        await request('runtime.harness_proxy.unregister', { token })
      },
      async unregisterContext(token: string) {
        await request('runtime.harness_context.unregister', { token })
      },
    },
    localProjectChatClient,
    aitableApi,
    dwsApi,
    projectSpaceApis: {
      local: deliveryApi,
      defaultLocation: 'local',
    },
    projectSpaceDetailServices: {
      local: {
        deliveryApi,
        projectChatClient: localProjectChatClient,
        projectChatAgentApi: localProjectChatAgentApi,
        loopItemExecutionApi: localLoopItemExecutionApi,
        deviceApi,
        modelApi,
        teamApi,
      },
    },
    runtimeWorkApi,
    automationApi,
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
