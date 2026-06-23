import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createDeviceApi } from '@/api/devices'
import {
  checkoutProjectBranch,
  commitProjectChanges,
  createAndCheckoutProjectBranch,
  listProjectBranches,
  loadProjectEnvironment,
  loadProjectEnvironmentDiff,
} from '@/api/environment'
import { createGitApi } from '@/api/git'
import { ApiError, createHttpClient } from '@/api/http'
import { createImSessionApi } from '@/api/imSessions'
import { createModelApi } from '@/api/models'
import { createProjectApi } from '@/api/projects'
import { createRuntimeWorkApi } from '@/api/runtimeWork'
import { createSkillApi } from '@/api/skills'
import { createTaskApi } from '@/api/tasks'
import { createTeamApi } from '@/api/teams'
import { createUserApi } from '@/api/users'
import { getToken } from '@/api/auth'
import { getRuntimeConfig, stripAppBasePath } from '@/config/runtime'
import i18n from '@/i18n'
import { createChatStream } from '@/stream/chatStream'
import { appendCodeCommentContexts } from '@/lib/code-comment-context'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  canRequestDeviceUpgrade,
  filterClaudeCodeDevices,
  isDeviceBelowWeWorkVersion,
  isWeWorkCompatibleDevice,
} from '@/lib/device-capabilities'
import { getModelCompatibilityFamily } from '@/lib/model-ui'
import { buildRuntimeTaskRoute, navigateTo, parseRuntimeTaskRoute } from '@/lib/navigation'
import type { RuntimeTaskRoute } from '@/lib/navigation'
import { supportsGitWorktreeExecution } from '@/lib/projectClassification'
import {
  findWorkbenchDevice,
  getActiveWorkbenchDeviceId,
  getWorkbenchDeviceDisplayName,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import type {
  Attachment,
  BindRuntimeTaskIMSessionsResponse,
  ChatBlock,
  ChatMessagePayload,
  ChatSendPayload,
  CreateProjectRequest,
  CreateGitWorkspaceProjectRequest,
  DeleteDeviceWorkspaceRequest,
  DeviceWorkspacePrepareRequest,
  DeviceWorkspacePrepareResponse,
  GitBranch,
  GitRepoInfo,
  DeviceInfo,
  IMPrivateSessionListResponse,
  LocalDeviceSkill,
  ModelCompatibilityDisabledReason,
  ModelOptions,
  ModelSelectionConfig,
  NormalizedRuntimeMessage,
  ProjectExecutionMode,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  RuntimeDeviceWorkspace,
  RuntimeProjectWork,
  RuntimeTaskForkTarget,
  RuntimeGlobalIMNotificationUpdateRequest,
  RuntimeIMNotificationSettingsResponse,
  RuntimeTaskIMNotificationSubscriptionRequest,
  RuntimeTaskIMNotificationSubscriptionResponse,
  RuntimeWorkListResponse,
  SkillRef,
  TurnFileChangesSummary,
  UnifiedModel,
  UnifiedSkill,
  User,
} from '@/types/api'
import type { DeviceUpgradeState, DeviceUpgradeStatusPayload } from '@/types/device-events'
import type { EnvironmentInfo } from '@/types/environment'
import type { CodeCommentContext, WorkspaceTarget } from '@/types/workspace-files'
import type {
  GuidanceWorkbenchMessage,
  MessageSource,
  ProcessingBlock,
  QueuedWorkbenchMessage,
  WorkbenchMessage,
  WorkbenchState,
} from '@/types/workbench'
import {
  createSocketClient,
  normalizeWorkbenchBlockStatus,
  reduceWorkbenchMessages,
} from '@wegent/chat-core'
import type { AuthenticatedSocketClient } from '@wegent/chat-core'
import { useWorkbenchAttachments } from './useWorkbenchAttachments'
import { useWorkbenchModels } from './useWorkbenchModels'
import { useWorkbenchSkills } from './useWorkbenchSkills'
import { normalizeTurnFileChanges } from './turnFileChanges'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'
import { WorkbenchContext } from './useWorkbench'

const WEWORK_CLIENT_ORIGIN = 'wework'
const CODEX_RUNTIME_MODEL_NAME = 'codex-gpt-5.5'
const OPENAI_RESPONSES_RUNTIME_FAMILY = 'openai.openai-responses'
const OPENAI_RESPONSES_PROTOCOL = 'openai-responses'
const RESPONSES_API_FORMAT = 'responses'
const LOCAL_SKILLS_CACHE_TTL_MS = 60_000
const STANDALONE_PROJECT_ID = 0
const EMPTY_MESSAGE_TASK_TITLE = '新对话'
const RUNTIME_BLOCK_SUBTASK_ID_OFFSET = 1_000_000_000

type ProjectMutationOptions = {
  refreshWorkLists?: boolean
}

const DEVICE_STATUS_LABELS: Record<string, string> = {
  online: '在线',
  busy: '忙碌',
  offline: '离线',
}
const TERMINAL_UPGRADE_STATUSES = new Set(['success', 'error', 'skipped', 'busy'])
const UPGRADE_STATE_CLEAR_DELAY_MS = 5000
const UPGRADE_REFRESH_INTERVAL_MS = 3000
const DEVICE_LIST_CACHE_KEY = 'wework.workbench.lastNonEmptyDevices'
const DEVICE_LIST_CACHE_TTL_MS = 5 * 60 * 1000
const EMPTY_RUNTIME_WORK: RuntimeWorkListResponse = {
  projects: [],
  unmappedDeviceWorkspaces: [],
  totalLocalTasks: 0,
}

function getModelLabel(model?: UnifiedModel | null): string {
  return model?.displayName || model?.modelId || model?.name || '该模型'
}

function getBlockedModelSelectionMessage(
  reason: ModelCompatibilityDisabledReason | 'locked',
  model?: UnifiedModel | null
): string {
  const modelLabel = getModelLabel(model)
  if (reason === 'locked') {
    return '当前任务的模型选择已锁定'
  }
  if (reason === 'missing_current_runtime_family') {
    return '当前对话缺少模型运行时信息，不能切换模型'
  }
  if (reason === 'missing_target_runtime_family') {
    return `${modelLabel} 缺少运行时信息，不能用于当前对话`
  }
  return `${modelLabel} 与当前对话的模型协议不兼容，请新建对话后使用该模型`
}

function readCachedDeviceList(): DeviceInfo[] {
  try {
    const value = window.sessionStorage.getItem(DEVICE_LIST_CACHE_KEY)
    if (!value) return []
    const parsed = JSON.parse(value)
    if (!parsed || !Array.isArray(parsed.devices) || typeof parsed.updatedAt !== 'number') {
      return []
    }
    if (Date.now() - parsed.updatedAt > DEVICE_LIST_CACHE_TTL_MS) return []
    return filterClaudeCodeDevices(parsed.devices as DeviceInfo[])
  } catch {
    return []
  }
}

function writeCachedDeviceList(devices: DeviceInfo[]) {
  const claudeCodeDevices = filterClaudeCodeDevices(devices)
  if (claudeCodeDevices.length === 0) return
  try {
    window.sessionStorage.setItem(
      DEVICE_LIST_CACHE_KEY,
      JSON.stringify({ devices: claudeCodeDevices, updatedAt: Date.now() })
    )
  } catch {
    // The live state remains authoritative when browser storage is unavailable.
  }
}

function resolveDeviceListWithCache(devices: DeviceInfo[]): DeviceInfo[] {
  const claudeCodeDevices = filterClaudeCodeDevices(devices)
  if (claudeCodeDevices.length > 0) {
    writeCachedDeviceList(claudeCodeDevices)
    return claudeCodeDevices
  }

  const cachedDevices = readCachedDeviceList()
  if (cachedDevices.length > 0) {
    return cachedDevices
  }

  return devices
}

interface QueuedWorkbenchSend extends QueuedWorkbenchMessage {
  payload: ChatSendPayload
  activeDeviceId?: string
  attachments?: Attachment[]
  codeComments?: CodeCommentContext[]
}

function isTerminalDeviceUpgradeStatus(status: string): boolean {
  return TERMINAL_UPGRADE_STATUSES.has(status)
}

function getUpgradeStatusMessage(payload: DeviceUpgradeStatusPayload): string {
  if (payload.message) return payload.message
  if (payload.status === 'success') return '升级完成，正在检查设备版本'
  if (payload.status === 'error') return payload.error ?? '升级失败'
  if (payload.status === 'busy') return '设备正在执行任务，空闲后再升级'
  if (payload.status === 'skipped') return '设备已是最新版本'
  return '设备升级中'
}

export interface WorkbenchServices {
  teamApi: ReturnType<typeof createTeamApi>
  modelApi: ReturnType<typeof createModelApi>
  skillApi: ReturnType<typeof createSkillApi>
  projectApi: Omit<ReturnType<typeof createProjectApi>, 'createGitWorkspaceProject'> & {
    createGitWorkspaceProject?: ReturnType<typeof createProjectApi>['createGitWorkspaceProject']
  }
  gitApi?: ReturnType<typeof createGitApi>
  taskApi: Pick<
    ReturnType<typeof createTaskApi>,
    'getTurnFileChangesDiff' | 'revertTurnFileChanges'
  >
  deviceApi: Pick<
    ReturnType<typeof createDeviceApi>,
    | 'listDevices'
    | 'getHomeDirectory'
    | 'getProjectWorkspaceRoot'
    | 'listDirectories'
    | 'createDirectory'
    | 'executeCommand'
    | 'upgradeDevice'
    | 'listSkills'
  >
  imSessionApi?: ReturnType<typeof createImSessionApi>
  runtimeWorkApi?: ReturnType<typeof createRuntimeWorkApi>
  userApi?: ReturnType<typeof createUserApi>
  socketClient?: Pick<AuthenticatedSocketClient, 'ensureConnected' | 'dispose'>
  chatStream: ReturnType<typeof createChatStream>
}

export interface WorkbenchContextValue {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  queuedMessages: QueuedWorkbenchMessage[]
  guidanceMessages: GuidanceWorkbenchMessage[]
  codeCommentContexts: CodeCommentContext[]
  isRuntimeTranscriptLoading: boolean
  projectChat: {
    models: UnifiedModel[]
    skills: UnifiedSkill[]
    selectedModel: UnifiedModel | null
    selectedModelOptions: ModelOptions
    isModelSelectionReady: boolean
    selectedSkills: SkillRef[]
    attachments: Attachment[]
    uploadingFiles: Map<string, { file: File; progress: number }>
    errors: Map<string, string>
    isOptionsLocked: boolean
    isAttachmentReadyToSend: boolean
    setSelectedModel: (model: UnifiedModel | null) => void
    setSelectedModelOption: (optionId: string, value: string) => void
    onBlockedModelSelect: (model: UnifiedModel, message?: string) => void
    setSelectedSkills: (skills: SkillRef[]) => void
    toggleSkill: (skill: SkillRef) => void
    handleFileSelect: (files: File | File[]) => Promise<void>
    addExistingAttachment: (attachment: Attachment) => void
    removeAttachment: (attachmentId: number) => Promise<void>
    resetAttachments: () => void
    listLocalSkills: () => Promise<LocalDeviceSkill[]>
  }
  upgradingDevices: Record<string, DeviceUpgradeState>
  projectExecutionMode: ProjectExecutionMode
  setProjectExecutionMode: (mode: ProjectExecutionMode) => void
  projectWorktreeBaseBranch: string | null
  setProjectWorktreeBaseBranch: (branchName: string | null) => void
  selectProject: (projectId: number | null) => void
  selectProjectWorkspace: (projectId: number, deviceWorkspaceId: number | null) => void
  selectStandaloneDevice: (deviceId: string | null) => void
  startNewChat: () => void
  startStandaloneChat: () => void
  startNewProjectChat: (projectId: number) => void
  openRuntimeLocalTask: (address: RuntimeTaskAddress) => Promise<void>
  archiveRuntimeLocalTask: (address: RuntimeTaskAddress) => Promise<void>
  forkCurrentRuntimeTask: (target: RuntimeTaskForkTarget) => Promise<void>
  listImPrivateSessions: () => Promise<IMPrivateSessionListResponse>
  bindRuntimeTaskToImSessions: (
    address: RuntimeTaskAddress,
    sessionKeys: string[]
  ) => Promise<BindRuntimeTaskIMSessionsResponse>
  getImNotificationSettings: () => Promise<RuntimeIMNotificationSettingsResponse>
  updateGlobalImNotification: (
    data: RuntimeGlobalIMNotificationUpdateRequest
  ) => Promise<RuntimeIMNotificationSettingsResponse>
  subscribeRuntimeTaskNotifications: (
    data: RuntimeTaskIMNotificationSubscriptionRequest
  ) => Promise<RuntimeTaskIMNotificationSubscriptionResponse>
  unsubscribeRuntimeTaskNotifications: (
    address: RuntimeTaskAddress
  ) => Promise<RuntimeTaskIMNotificationSubscriptionResponse>
  rememberExecutionDevice: (deviceId: string) => void
  refreshWorkLists: () => Promise<void>
  refreshDevices: () => Promise<void>
  upgradeDevice: (deviceId: string) => Promise<void>
  createProject: (
    data: CreateProjectRequest,
    options?: ProjectMutationOptions
  ) => Promise<ProjectWithTasks>
  createGitWorkspaceProject: (data: CreateGitWorkspaceProjectRequest) => Promise<ProjectWithTasks>
  prepareDeviceWorkspace: (
    data: DeviceWorkspacePrepareRequest,
    options?: ProjectMutationOptions
  ) => Promise<DeviceWorkspacePrepareResponse>
  deleteDeviceWorkspace: (data: DeleteDeviceWorkspaceRequest) => Promise<void>
  listGitRepositories: () => Promise<GitRepoInfo[]>
  listGitBranches: (repo: GitRepoInfo) => Promise<GitBranch[]>
  updateProjectName: (projectId: number, name: string) => Promise<void>
  removeProject: (projectId: number) => Promise<void>
  getDeviceHomeDirectory: (deviceId: string) => Promise<string>
  getProjectWorkspaceRoot: (deviceId: string) => Promise<string>
  listDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  createDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  loadEnvironmentInfo: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<EnvironmentInfo>
  loadEnvironmentDiff: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<string>
  commitEnvironmentChanges: (
    project: ProjectWithTasks | null,
    message: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  listEnvironmentBranches: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<string[]>
  checkoutEnvironmentBranch: (
    project: ProjectWithTasks | null,
    branchName: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  createEnvironmentBranch: (
    project: ProjectWithTasks | null,
    branchName: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  setInput: (input: string) => void
  addCodeCommentContext: (context: CodeCommentContext) => void
  removeCodeCommentContext: (contextId: string) => void
  clearCodeCommentContexts: () => void
  sendCurrentInput: () => Promise<void>
  retryFailedMessage: (messageId: string) => Promise<void>
  pauseCurrentResponse: () => Promise<void>
  isResponseStreaming: boolean
  cancelQueuedMessage: (id: string) => void
  sendQueuedAsGuidance: (id: string) => Promise<void>
  editQueuedMessage: (id: string) => void
  cancelGuidanceMessage: (id: string) => void
  loadTurnFileChangesDiff: (subtaskId: number) => Promise<string>
  revertTurnFileChanges: (subtaskId: number) => Promise<TurnFileChangesSummary>
}

interface WorkbenchProviderProps {
  children: ReactNode
  user: User
  services?: WorkbenchServices
}

function createDefaultServices(): WorkbenchServices {
  const { apiBaseUrl, socketBaseUrl, socketPath } = getRuntimeConfig()
  const client = createHttpClient({ baseUrl: apiBaseUrl })
  const socketClient = createSocketClient({
    socketBaseUrl: () => socketBaseUrl,
    path: socketPath,
    namespace: '/chat',
    getToken,
    logger: console,
  })

  return {
    teamApi: createTeamApi(client),
    modelApi: createModelApi(client),
    skillApi: createSkillApi(client),
    projectApi: createProjectApi(client),
    gitApi: createGitApi(client),
    taskApi: createTaskApi(client),
    deviceApi: createDeviceApi(client),
    imSessionApi: createImSessionApi(client),
    runtimeWorkApi: createRuntimeWorkApi(client),
    userApi: createUserApi(client),
    socketClient,
    chatStream: createChatStream(socketClient.socket),
  }
}

function getCurrentAppPath(): string {
  return stripAppBasePath(window.location.pathname)
}

function getRuntimeTaskRouteKey(route: RuntimeTaskRoute): string {
  return `${route.deviceId}:${route.localTaskId}`
}

function isSameRuntimeTaskIdentity(
  address: RuntimeTaskAddress | null,
  route: RuntimeTaskRoute
): boolean {
  return Boolean(
    address && address.deviceId === route.deviceId && address.localTaskId === route.localTaskId
  )
}

function resolveRuntimeTaskRouteAddress(
  runtimeWork: RuntimeWorkListResponse | null,
  route: RuntimeTaskRoute
): RuntimeTaskAddress | null {
  if (!runtimeWork) return null

  const workspaces = [
    ...runtimeWork.projects.flatMap(projectWork => projectWork.deviceWorkspaces),
    ...runtimeWork.unmappedDeviceWorkspaces,
  ]

  for (const workspace of workspaces) {
    if (workspace.deviceId !== route.deviceId) continue

    const task = workspace.localTasks.find(item => item.localTaskId === route.localTaskId)
    if (!task) continue

    return {
      deviceId: workspace.deviceId,
      localTaskId: task.localTaskId,
    }
  }

  return null
}

function isCurrentLocalTaskEvent(
  currentRuntimeTask: RuntimeTaskAddress | null,
  payload: { device_id?: string; local_task_id?: string }
): boolean {
  if (!payload.local_task_id) return false
  return Boolean(
    currentRuntimeTask &&
    payload.device_id === currentRuntimeTask.deviceId &&
    payload.local_task_id === currentRuntimeTask.localTaskId
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getBlockTimestamp(value: unknown, fallbackTimestamp = Date.now()): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallbackTimestamp
  }
  if (value > 1_000_000_000_000) return value
  if (value > 1_000_000_000) return value * 1000
  return fallbackTimestamp
}

function normalizeProcessingBlock(
  subtaskId: number,
  block: unknown,
  index: number,
  fallbackTimestamp?: number
): ProcessingBlock | null {
  if (!isRecord(block)) return null

  const timestamp = getBlockTimestamp(block.timestamp, fallbackTimestamp)
  const status = normalizeWorkbenchBlockStatus(
    typeof block.status === 'string' ? block.status : undefined
  )

  if (block.type === 'tool') {
    const id =
      typeof block.id === 'string'
        ? block.id
        : typeof block.tool_use_id === 'string'
          ? block.tool_use_id
          : `tool-${subtaskId}-${index}`
    return {
      id,
      subtaskId,
      type: 'tool',
      toolName: typeof block.tool_name === 'string' ? block.tool_name : 'unknown',
      toolInput: isRecord(block.tool_input) ? block.tool_input : undefined,
      toolOutput: block.tool_output,
      status,
      createdAt: timestamp,
    }
  }

  if (block.type === 'thinking') {
    const id = typeof block.id === 'string' ? block.id : `thinking-${subtaskId}-${index}`
    return {
      id,
      subtaskId,
      type: 'thinking',
      content: typeof block.content === 'string' ? block.content : '',
      status,
      createdAt: timestamp,
    }
  }

  if (block.type === 'text') {
    const id = typeof block.id === 'string' ? block.id : `text-${subtaskId}-${index}`
    const content =
      typeof block.content === 'string'
        ? block.content
        : typeof block.text === 'string'
          ? block.text
          : ''
    return {
      id,
      subtaskId,
      type: 'text',
      content,
      status,
      createdAt: timestamp,
    }
  }

  return null
}

function normalizeProcessingBlocks(
  subtaskId: number,
  blocks?: unknown[],
  fallbackTimestamp?: number
): ProcessingBlock[] {
  if (!blocks) return []

  return blocks.flatMap((block, index) => {
    const normalized = normalizeProcessingBlock(subtaskId, block, index, fallbackTimestamp)
    return normalized ? [normalized] : []
  })
}

function getResultBlocks(subtaskId: number, result: unknown): ProcessingBlock[] | undefined {
  if (!isRecord(result) || !Array.isArray(result.blocks)) return undefined
  const blocks = normalizeProcessingBlocks(subtaskId, result.blocks)
  return blocks.length > 0 ? blocks : undefined
}

function getReasoningChunk(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  return typeof result.reasoning_chunk === 'string' ? result.reasoning_chunk : undefined
}

function normalizeChatBlock(subtaskId: number, block: ChatBlock): ProcessingBlock | null {
  return normalizeProcessingBlock(subtaskId, block, 0)
}

function getRuntimeMessageBlockSubtaskId(
  message: NormalizedRuntimeMessage,
  subtaskId?: number
): number {
  if (typeof subtaskId === 'number') return subtaskId

  let hash = 0
  for (let index = 0; index < message.id.length; index += 1) {
    hash = (hash * 31 + message.id.charCodeAt(index)) % 1_000_000
  }

  return RUNTIME_BLOCK_SUBTASK_ID_OFFSET + hash
}

function runtimeMessageToWorkbenchMessage(
  address: RuntimeTaskAddress,
  message: NormalizedRuntimeMessage
): WorkbenchMessage {
  const role = message.role.toLowerCase() === 'user' ? 'user' : 'assistant'
  const subtaskId =
    typeof message.subtaskId === 'number'
      ? message.subtaskId
      : typeof message.subtask_id === 'number'
        ? message.subtask_id
        : undefined
  const normalizedStatus = String(message.status ?? '').toLowerCase()
  const status: WorkbenchMessage['status'] =
    normalizedStatus === 'failed'
      ? 'failed'
      : normalizedStatus === 'streaming'
        ? 'streaming'
        : 'done'
  const source =
    role === 'user' && message.source?.source === 'im'
      ? ({ ...message.source, source: 'im' } as MessageSource)
      : undefined
  const blocks = normalizeProcessingBlocks(
    getRuntimeMessageBlockSubtaskId(message, subtaskId),
    message.blocks
  )
  return {
    id: `runtime-${address.localTaskId}-${message.id}`,
    role,
    subtaskId,
    content: message.content,
    status,
    source,
    attachments: message.attachments,
    blocks: blocks.length > 0 ? blocks : undefined,
    createdAt: message.createdAt ?? new Date().toISOString(),
  }
}

function chatMessageToWorkbenchMessage(payload: ChatMessagePayload): WorkbenchMessage {
  const role = payload.role.toLowerCase() === 'user' ? 'user' : 'assistant'
  const source =
    role === 'user' && payload.source?.source === 'im'
      ? ({ ...payload.source, source: 'im' } as MessageSource)
      : undefined
  const messageKey = payload.message_id ?? payload.subtask_id
  const localPrefix = payload.local_task_id ? `runtime-${payload.local_task_id}-` : ''
  return {
    id: `${localPrefix}message-${messageKey}`,
    taskId: payload.task_id,
    subtaskId: payload.subtask_id,
    role,
    content: payload.content,
    status: 'done',
    attachments: payload.attachments,
    source,
    createdAt: payload.created_at,
  }
}

function getLastProjectStorageKey(userId: number) {
  return `wework.lastProjectId.${userId}`
}

function writeLastProjectId(userId: number, projectId: number) {
  try {
    window.localStorage.setItem(getLastProjectStorageKey(userId), String(projectId))
  } catch {
    // Ignore storage failures; project selection still works for the current session.
  }
}

function getNewChatModelSelection(user: User | null): ModelSelectionConfig | null {
  return user?.preferences?.wework_new_chat_model_selection ?? null
}

function getStringConfigValue(
  config: Record<string, unknown> | null | undefined,
  key: string
): string {
  const value = config?.[key]
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function isCodexCompatibleModel(model: UnifiedModel): boolean {
  if (model.name === CODEX_RUNTIME_MODEL_NAME) return true
  return (
    getModelCompatibilityFamily(model) === OPENAI_RESPONSES_RUNTIME_FAMILY ||
    getStringConfigValue(model.config, 'protocol') === OPENAI_RESPONSES_PROTOCOL ||
    getStringConfigValue(model.config, 'apiFormat') === RESPONSES_API_FORMAT ||
    getStringConfigValue(model.config, 'api_format') === RESPONSES_API_FORMAT
  )
}

function resolveAutomaticModel(models: UnifiedModel[]): UnifiedModel | null {
  return models.find(model => !model.compatibilityDisabled) ?? null
}

function normalizeGuidanceError(error?: string) {
  if (!error) return '引导发送失败'
  if (error.includes('Chat Shell')) {
    return '当前智能体不支持引导，请编辑后排队发送'
  }
  if (error.includes('Subtask not found')) {
    return '当前回复已结束，请编辑后重新发送'
  }
  if (error.includes('Not connected') || error.includes('连接未建立')) {
    return '连接未建立，请稍后重试'
  }
  return error
}

function getRememberedStandaloneDeviceId(
  user: User,
  devices: DeviceInfo[],
  fallbackDeviceId?: string | null
) {
  return getPreferredStandaloneDeviceId(
    devices,
    user.preferences?.default_execution_target ?? fallbackDeviceId
  )
}

function findRuntimeWorkspaceForDevice(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  deviceId: string | undefined
): string | null {
  if (!deviceId) return null
  const workspaces = [
    ...(runtimeWork?.unmappedDeviceWorkspaces ?? []),
    ...(runtimeWork?.projects ?? []).flatMap(project => project.deviceWorkspaces),
  ]
  const matches = workspaces.filter(
    item => item.deviceId === deviceId && item.available && item.workspacePath
  )
  const workspacePaths = [...new Set(matches.map(item => item.workspacePath))]
  return workspacePaths.length === 1 ? workspacePaths[0] : null
}

function getSelectableProjectDeviceWorkspaces(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number | null | undefined
): RuntimeDeviceWorkspace[] {
  if (!projectId) return []
  const projectWork = runtimeWork?.projects.find(item => item.project.id === projectId)
  return projectWork?.deviceWorkspaces.filter(workspace => workspace.available) ?? []
}

function getSingleProjectDeviceWorkspaceId(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number | null | undefined
): number | null {
  const workspaces = getSelectableProjectDeviceWorkspaces(runtimeWork, projectId)
  return workspaces.length === 1 ? (workspaces[0].id ?? null) : null
}

function runtimeProjectToProject(projectWork: RuntimeProjectWork): ProjectWithTasks {
  return {
    id: projectWork.project.id,
    name: projectWork.project.name,
    description: projectWork.project.description,
    color: projectWork.project.color,
    tasks: [],
  }
}

function findSelectableProject(
  projects: ProjectWithTasks[],
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number
): ProjectWithTasks | null {
  const project = projects.find(item => item.id === projectId)
  if (project) return project
  const runtimeProject = runtimeWork?.projects.find(item => item.project.id === projectId)
  return runtimeProject ? runtimeProjectToProject(runtimeProject) : null
}

function findProjectDeviceWorkspace(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number | null | undefined,
  deviceWorkspaceId: number | null | undefined
): RuntimeDeviceWorkspace | null {
  const workspaces = getSelectableProjectDeviceWorkspaces(runtimeWork, projectId)
  if (deviceWorkspaceId) {
    return workspaces.find(workspace => workspace.id === deviceWorkspaceId) ?? null
  }
  return workspaces.length === 1 ? workspaces[0] : null
}

function inferRuntimeName(model: UnifiedModel | null): 'codex' | 'claude_code' {
  if (model && isCodexCompatibleModel(model)) return 'codex'
  return 'claude_code'
}

function buildRuntimeTaskTitle(message: string, fallback?: string): string {
  const title = (fallback || message).trim()
  return title ? title.slice(0, 100) : EMPTY_MESSAGE_TASK_TITLE
}

export function WorkbenchProvider({ children, user, services }: WorkbenchProviderProps) {
  const resolvedServices = useMemo(() => services ?? createDefaultServices(), [services])
  const [state, dispatch] = useReducer(workbenchReducer, initialWorkbenchState)
  const [messages, dispatchMessages] = useReducer(
    reduceWorkbenchMessages<Attachment, TurnFileChangesSummary>,
    [] as WorkbenchMessage[]
  )
  const [queuedSends, setQueuedSends] = useState<QueuedWorkbenchSend[]>([])
  const [guidanceMessages, setGuidanceMessages] = useState<GuidanceWorkbenchMessage[]>([])
  const [codeCommentContexts, setCodeCommentContexts] = useState<CodeCommentContext[]>([])
  const [upgradingDevices, setUpgradingDevices] = useState<Record<string, DeviceUpgradeState>>({})
  const [runtimeTranscriptLoadingKey, setRuntimeTranscriptLoadingKey] = useState<string | null>(
    null
  )
  const [, setIsAwaitingAssistantStart] = useState(false)
  const [routePath, setRoutePath] = useState(getCurrentAppPath)
  const [routeSearch, setRouteSearch] = useState(() => window.location.search)
  const [projectExecutionMode, setProjectExecutionMode] =
    useState<ProjectExecutionMode>('current_workspace')
  const [projectWorktreeBaseBranch, setProjectWorktreeBaseBranchState] = useState<string | null>(
    null
  )
  const upgradeClearTimersRef = useRef<Record<string, ReturnType<typeof window.setTimeout>>>({})
  const localSkillsCacheRef = useRef<
    Map<string, { expiresAt: number; skills: LocalDeviceSkill[] }>
  >(new Map())
  const handledRuntimeTaskRouteRef = useRef<string | null>(null)
  const runtimeOpenRequestIdRef = useRef(0)
  const currentRuntimeTaskRef = useRef<RuntimeTaskAddress | null>(null)
  const isOptionsLocked = Boolean(state.currentRuntimeTask)
  const currentRuntimeTaskKey = state.currentRuntimeTask
    ? getRuntimeTaskRouteKey(state.currentRuntimeTask)
    : null
  const isRuntimeTranscriptLoading =
    Boolean(currentRuntimeTaskKey) && runtimeTranscriptLoadingKey === currentRuntimeTaskKey
  const currentUser = state.user ?? user
  const activeProject = state.currentProject
  const activeDeviceId = getActiveWorkbenchDeviceId({
    currentProject: activeProject,
    standaloneDeviceId: state.standaloneDeviceId,
  })

  useEffect(() => {
    currentRuntimeTaskRef.current = state.currentRuntimeTask
  }, [state.currentRuntimeTask])

  useEffect(() => {
    const socketClient = resolvedServices.socketClient
    if (!socketClient) return undefined

    let isMounted = true
    void socketClient.ensureConnected().catch(error => {
      if (isMounted) {
        console.error('[Workbench] Failed to connect chat socket', error)
      }
    })

    return () => {
      isMounted = false
      socketClient.dispose()
    }
  }, [resolvedServices.socketClient])

  const cancelRuntimeTranscriptLoad = useCallback(() => {
    runtimeOpenRequestIdRef.current += 1
    setRuntimeTranscriptLoadingKey(null)
  }, [])

  const selectProjectExecutionMode = useCallback(
    (mode: ProjectExecutionMode) => {
      setProjectExecutionMode(mode)
      if (!state.currentProject || !supportsGitWorktreeExecution(state.currentProject)) {
        return
      }
      const preferences = {
        ...(currentUser.preferences ?? {}),
        wework_project_execution_mode: mode,
      }
      dispatch({ type: 'user_preferences_updated', preferences })
      void resolvedServices.userApi?.updateCurrentUser({ preferences }).catch(() => {
        dispatch({ type: 'error_set', error: '启动模式保存失败' })
      })
    },
    [currentUser.preferences, resolvedServices.userApi, state.currentProject]
  )

  useEffect(() => {
    const nextMode =
      !state.currentProject || !supportsGitWorktreeExecution(state.currentProject)
        ? 'current_workspace'
        : (currentUser.preferences?.wework_project_execution_mode ?? 'current_workspace')
    const timer = window.setTimeout(() => {
      setProjectExecutionMode(nextMode)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [currentUser.preferences?.wework_project_execution_mode, state.currentProject])
  const setProjectWorktreeBaseBranch = useCallback((branchName: string | null) => {
    const normalizedBranch = branchName?.trim() || null
    setProjectWorktreeBaseBranchState(normalizedBranch)
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setProjectWorktreeBaseBranchState(null)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [state.currentProject?.id])
  useEffect(() => {
    if (projectExecutionMode === 'git_worktree') return
    const timer = window.setTimeout(() => {
      setProjectWorktreeBaseBranchState(null)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [projectExecutionMode])
  const modelSelectionConfig = useMemo(() => {
    return getNewChatModelSelection(currentUser) ?? null
  }, [currentUser])
  const modelCompatibilityConfig = useMemo(() => null, [])
  const defaultModelSelectionConfig = useCallback(() => null, [])
  const persistNewChatModelSelection = useCallback(
    (selection: ModelSelectionConfig) => {
      const preferences = {
        ...(currentUser.preferences ?? {}),
        wework_new_chat_model_selection: selection,
      }
      dispatch({ type: 'user_preferences_updated', preferences })
      void resolvedServices.userApi?.updateCurrentUser({ preferences }).catch(() => {
        dispatch({ type: 'error_set', error: '模型配置保存失败' })
      })
    },
    [currentUser.preferences, resolvedServices.userApi]
  )
  const handleBlockedModelSelection = useCallback(
    (reason: ModelCompatibilityDisabledReason | 'locked', model?: UnifiedModel | null) => {
      dispatch({
        type: 'error_set',
        error: getBlockedModelSelectionMessage(reason, model),
      })
    },
    []
  )
  const handleBlockedModelSelect = useCallback((model: UnifiedModel, message?: string) => {
    dispatch({
      type: 'error_set',
      error: message || getBlockedModelSelectionMessage('runtime_family_mismatch', model),
    })
  }, [])
  const reportSendBlocked = useCallback((error: string, details?: Record<string, unknown>) => {
    console.warn('[Wework] send blocked:', error, details ?? {})
    dispatch({ type: 'error_set', error })
  }, [])
  useEffect(() => {
    const handlePopState = () => {
      setRoutePath(getCurrentAppPath())
      setRouteSearch(window.location.search)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  const modelSelection = useWorkbenchModels({
    api: resolvedServices.modelApi,
    locked: false,
    selectionConfig: modelSelectionConfig,
    compatibilityConfig: modelCompatibilityConfig,
    defaultSelectionConfig: defaultModelSelectionConfig,
    selectionReady: !state.isBootstrapping,
    onSelectionChange: persistNewChatModelSelection,
    onSelectionBlocked: handleBlockedModelSelection,
  })
  const skillSelection = useWorkbenchSkills({
    api: resolvedServices.skillApi,
    teamId: state.defaultTeam?.id,
    locked: isOptionsLocked,
  })
  const attachmentSelection = useWorkbenchAttachments()
  const addCodeCommentContext = useCallback((context: CodeCommentContext) => {
    setCodeCommentContexts(items => [...items.filter(item => item.id !== context.id), context])
  }, [])
  const removeCodeCommentContext = useCallback((contextId: string) => {
    setCodeCommentContexts(items => items.filter(item => item.id !== contextId))
  }, [])
  const clearCodeCommentContexts = useCallback(() => {
    setCodeCommentContexts([])
  }, [])

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      const [defaultTeamResult, devicesResult, runtimeWorkResult] = await Promise.allSettled([
        resolvedServices.teamApi.getDefaultWorkbenchTeam(),
        resolvedServices.deviceApi.listDevices(),
        resolvedServices.runtimeWorkApi?.listRuntimeWork() ?? Promise.resolve(EMPTY_RUNTIME_WORK),
      ])

      if (cancelled) return

      const rawDevices = devicesResult.status === 'fulfilled' ? devicesResult.value : []
      const devices = resolveDeviceListWithCache(rawDevices)

      dispatch({
        type: 'bootstrapped',
        user,
        defaultTeam: defaultTeamResult.status === 'fulfilled' ? defaultTeamResult.value : null,
        projects: [],
        devices,
        runtimeWork:
          runtimeWorkResult.status === 'fulfilled' ? runtimeWorkResult.value : EMPTY_RUNTIME_WORK,
        currentProject: null,
        standaloneDeviceId: getRememberedStandaloneDeviceId(user, devices),
      })
      if (defaultTeamResult.status === 'rejected') {
        dispatch({
          type: 'error_set',
          error:
            defaultTeamResult.reason instanceof Error
              ? defaultTeamResult.reason.message
              : 'Wework default team is not configured',
        })
      }
    }

    bootstrap()
    return () => {
      cancelled = true
    }
  }, [resolvedServices, user])

  const refreshWorkLists = useCallback(async () => {
    const [devicesResult, runtimeWorkResult] = await Promise.all([
      resolvedServices.deviceApi.listDevices().catch(error => {
        const cachedDevices = readCachedDeviceList()
        if (cachedDevices.length === 0) throw error
        return cachedDevices
      }),
      resolvedServices.runtimeWorkApi?.listRuntimeWork().catch(() => undefined) ??
        Promise.resolve(undefined),
    ])
    const devices = resolveDeviceListWithCache(devicesResult)
    dispatch({
      type: 'lists_refreshed',
      projects: state.projects,
      devices,
      runtimeWork: runtimeWorkResult,
      standaloneDeviceId: getPreferredStandaloneDeviceId(devices, state.standaloneDeviceId),
    })
  }, [resolvedServices, state.projects, state.standaloneDeviceId])

  const refreshDevices = useCallback(async () => {
    let devices: DeviceInfo[]
    try {
      devices = await resolvedServices.deviceApi.listDevices()
    } catch (error) {
      const cachedDevices = readCachedDeviceList()
      if (cachedDevices.length > 0) {
        devices = cachedDevices
      } else {
        throw error
      }
    }
    devices = resolveDeviceListWithCache(devices)
    dispatch({
      type: 'devices_refreshed',
      devices,
      standaloneDeviceId: getPreferredStandaloneDeviceId(devices, state.standaloneDeviceId),
    })
  }, [resolvedServices, state.standaloneDeviceId])

  const clearUpgradeStateTimer = useCallback((deviceId: string) => {
    const timer = upgradeClearTimersRef.current[deviceId]
    if (!timer) return
    window.clearTimeout(timer)
    delete upgradeClearTimersRef.current[deviceId]
  }, [])

  const scheduleUpgradeStateClear = useCallback(
    (deviceId: string) => {
      clearUpgradeStateTimer(deviceId)
      upgradeClearTimersRef.current[deviceId] = window.setTimeout(() => {
        setUpgradingDevices(current => {
          const next = { ...current }
          delete next[deviceId]
          return next
        })
        delete upgradeClearTimersRef.current[deviceId]
      }, UPGRADE_STATE_CLEAR_DELAY_MS)
    },
    [clearUpgradeStateTimer]
  )

  const setDeviceUpgradeState = useCallback(
    (deviceId: string, upgradeState: DeviceUpgradeState) => {
      clearUpgradeStateTimer(deviceId)
      setUpgradingDevices(current => ({
        ...current,
        [deviceId]: upgradeState,
      }))
      if (isTerminalDeviceUpgradeStatus(upgradeState.status)) {
        scheduleUpgradeStateClear(deviceId)
      }
    },
    [clearUpgradeStateTimer, scheduleUpgradeStateClear]
  )

  const upgradeDevice = useCallback(
    async (deviceId: string) => {
      const device = state.devices.find(item => item.device_id === deviceId)
      if (device && !canRequestDeviceUpgrade(device)) {
        const message =
          device.status !== 'online'
            ? '设备离线，恢复在线后再升级'
            : '设备正在执行任务，空闲后再升级'
        setDeviceUpgradeState(deviceId, {
          status: 'busy',
          message,
        })
        dispatch({ type: 'error_set', error: message })
        return
      }

      setDeviceUpgradeState(deviceId, {
        status: 'pending',
        message: '正在发送升级指令',
      })

      try {
        await resolvedServices.deviceApi.upgradeDevice(deviceId, {
          auto_confirm: true,
        })
        setDeviceUpgradeState(deviceId, {
          status: 'checking',
          message: '升级指令已发送，正在等待设备更新',
        })
        void refreshDevices().catch(() => undefined)
      } catch (error) {
        const message = error instanceof Error ? error.message : '升级失败'
        setDeviceUpgradeState(deviceId, {
          status: 'error',
          message,
          error: message,
        })
        dispatch({ type: 'error_set', error: message })
      }
    },
    [refreshDevices, resolvedServices.deviceApi, setDeviceUpgradeState, state.devices]
  )

  useEffect(() => {
    const handleDeviceChanged = () => {
      void refreshDevices()
    }
    const handleDeviceUpgradeStatus = (payload: DeviceUpgradeStatusPayload) => {
      setDeviceUpgradeState(payload.device_id, {
        status: payload.status,
        message: getUpgradeStatusMessage(payload),
        progress: payload.progress,
        error: payload.error,
      })
      if (payload.status === 'success' || payload.status === 'skipped') {
        void refreshDevices()
      }
    }

    return resolvedServices.chatStream.subscribe({
      onDeviceOnline: handleDeviceChanged,
      onDeviceOffline: handleDeviceChanged,
      onDeviceStatus: handleDeviceChanged,
      onDeviceSlotUpdate: handleDeviceChanged,
      onDeviceUpgradeStatus: handleDeviceUpgradeStatus,
      onChatMessage: payload => {
        if (!isCurrentLocalTaskEvent(currentRuntimeTaskRef.current, payload)) return
        dispatchMessages({
          type: 'user_added',
          message: chatMessageToWorkbenchMessage(payload),
        })
      },
      onChatStart: payload => {
        if (!isCurrentLocalTaskEvent(currentRuntimeTaskRef.current, payload)) return
        setIsAwaitingAssistantStart(false)
        dispatchMessages({
          type: 'assistant_started',
          subtaskId: payload.subtask_id,
          shellType: payload.shell_type,
        })
      },
      onChatChunk: payload => {
        if (!isCurrentLocalTaskEvent(currentRuntimeTaskRef.current, payload)) return
        dispatchMessages({
          type: 'assistant_chunk',
          subtaskId: payload.subtask_id,
          content: payload.content,
          reasoningChunk: getReasoningChunk(payload.result),
          blocks: getResultBlocks(payload.subtask_id, payload.result),
        })
      },
      onChatDone: payload => {
        if (!isCurrentLocalTaskEvent(currentRuntimeTaskRef.current, payload)) return
        setIsAwaitingAssistantStart(false)
        dispatchMessages({
          type: 'assistant_done',
          subtaskId: payload.subtask_id,
          content: typeof payload.result.value === 'string' ? payload.result.value : undefined,
          blocks: getResultBlocks(payload.subtask_id, payload.result),
          fileChanges: normalizeTurnFileChanges(payload.result.file_changes),
        })
        void refreshWorkLists().catch(() => undefined)
      },
      onChatError: payload => {
        if (!isCurrentLocalTaskEvent(currentRuntimeTaskRef.current, payload)) return
        setIsAwaitingAssistantStart(false)
        dispatchMessages({
          type: 'assistant_error',
          subtaskId: payload.subtask_id,
          error: payload.error,
          errorType: payload.type,
        })
        void refreshWorkLists().catch(() => undefined)
      },
      onBlockCreated: payload => {
        if (!isCurrentLocalTaskEvent(currentRuntimeTaskRef.current, payload)) return
        const block = normalizeChatBlock(payload.subtask_id, payload.block)
        if (!block) return
        dispatchMessages({
          type: 'block_created',
          subtaskId: payload.subtask_id,
          block,
        })
      },
      onBlockUpdated: payload => {
        if (!isCurrentLocalTaskEvent(currentRuntimeTaskRef.current, payload)) return
        dispatchMessages({
          type: 'block_updated',
          subtaskId: payload.subtask_id,
          blockId: payload.block_id,
          updates: {
            ...(payload.content !== undefined && { content: payload.content }),
            ...(payload.tool_input !== undefined && { toolInput: payload.tool_input }),
            ...(payload.tool_output !== undefined && { toolOutput: payload.tool_output }),
            ...(payload.status && { status: normalizeWorkbenchBlockStatus(payload.status) }),
          },
        })
      },
      onGuidanceQueued: payload => {
        setGuidanceMessages(items =>
          items.map(item =>
            item.id === payload.guidance_id || item.id === payload.client_guidance_id
              ? {
                  ...item,
                  id: payload.guidance_id,
                  content: payload.message ?? payload.content ?? item.content,
                  status: 'queued',
                }
              : item
          )
        )
      },
      onGuidanceApplied: payload => {
        setGuidanceMessages(items =>
          items.filter(
            item => item.id !== payload.guidance_id && item.id !== payload.client_guidance_id
          )
        )
      },
      onGuidanceExpired: payload => {
        setGuidanceMessages(items =>
          items.map(item =>
            payload.guidance_ids.includes(item.id) ? { ...item, status: 'expired' } : item
          )
        )
      },
    })
  }, [refreshWorkLists, refreshDevices, resolvedServices, setDeviceUpgradeState])

  useEffect(() => {
    return () => {
      Object.values(upgradeClearTimersRef.current).forEach(timer => {
        window.clearTimeout(timer)
      })
      upgradeClearTimersRef.current = {}
    }
  }, [])

  useEffect(() => {
    const hasActiveUpgrade = Object.values(upgradingDevices).some(
      upgradeState => !isTerminalDeviceUpgradeStatus(upgradeState.status)
    )
    if (!hasActiveUpgrade) return undefined

    const interval = window.setInterval(() => {
      void refreshDevices().catch(() => undefined)
    }, UPGRADE_REFRESH_INTERVAL_MS)

    return () => window.clearInterval(interval)
  }, [refreshDevices, upgradingDevices])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setUpgradingDevices(current => {
        let changed = false
        const next = { ...current }
        Object.keys(next).forEach(deviceId => {
          const device = state.devices.find(item => item.device_id === deviceId)
          if (device && device.status === 'online' && isWeWorkCompatibleDevice(device)) {
            clearUpgradeStateTimer(deviceId)
            delete next[deviceId]
            changed = true
          }
        })
        return changed ? next : current
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [clearUpgradeStateTimer, state.devices])

  const rememberExecutionDevice = useCallback(
    (deviceId: string) => {
      dispatch({
        type: 'standalone_device_preference_changed',
        standaloneDeviceId: getPreferredStandaloneDeviceId(state.devices, deviceId) ?? deviceId,
      })
      void resolvedServices.userApi
        ?.updateCurrentUser({
          preferences: {
            ...(currentUser.preferences ?? {}),
            default_execution_target: deviceId,
          },
        })
        .catch(() => {
          // Keep the in-session selection even if preference persistence fails.
        })
    },
    [currentUser.preferences, resolvedServices.userApi, state.devices]
  )

  const selectProject = useCallback(
    (projectId: number | null) => {
      if (projectId === null) {
        dispatch({
          type: 'project_cleared',
          standaloneDeviceId: getRememberedStandaloneDeviceId(
            user,
            state.devices,
            state.standaloneDeviceId
          ),
        })
        dispatchMessages({ type: 'reset', messages: [] })
        setQueuedSends([])
        setGuidanceMessages([])
        setCodeCommentContexts([])
        cancelRuntimeTranscriptLoad()
        handledRuntimeTaskRouteRef.current = null
        navigateTo('/')
        return
      }
      const project = findSelectableProject(state.projects, state.runtimeWork, projectId)
      if (project) {
        writeLastProjectId(user.id, project.id)
        dispatch({ type: 'project_selected', project })
        dispatchMessages({ type: 'reset', messages: [] })
        setQueuedSends([])
        setGuidanceMessages([])
        setCodeCommentContexts([])
        cancelRuntimeTranscriptLoad()
        handledRuntimeTaskRouteRef.current = null
        navigateTo('/')
      }
    },
    [
      cancelRuntimeTranscriptLoad,
      state.devices,
      state.projects,
      state.runtimeWork,
      state.standaloneDeviceId,
      user,
    ]
  )

  const selectProjectWorkspace = useCallback(
    (projectId: number, deviceWorkspaceId: number | null) => {
      const project = findSelectableProject(state.projects, state.runtimeWork, projectId)
      if (!project) return
      writeLastProjectId(user.id, project.id)
      dispatch({
        type: 'project_workspace_selected',
        project,
        deviceWorkspaceId,
      })
      dispatchMessages({ type: 'reset', messages: [] })
      setQueuedSends([])
      setGuidanceMessages([])
      setCodeCommentContexts([])
      cancelRuntimeTranscriptLoad()
      handledRuntimeTaskRouteRef.current = null
      navigateTo('/')
    },
    [cancelRuntimeTranscriptLoad, state.projects, state.runtimeWork, user.id]
  )

  const selectStandaloneDevice = useCallback(
    (deviceId: string | null) => {
      const standaloneDeviceId = getPreferredStandaloneDeviceId(
        state.devices,
        deviceId ?? user.preferences?.default_execution_target ?? state.standaloneDeviceId
      )
      if (standaloneDeviceId) {
        rememberExecutionDevice(standaloneDeviceId)
      }
      dispatch({
        type: 'project_cleared',
        standaloneDeviceId,
      })
      dispatchMessages({ type: 'reset', messages: [] })
      setQueuedSends([])
      setGuidanceMessages([])
      setCodeCommentContexts([])
      cancelRuntimeTranscriptLoad()
      handledRuntimeTaskRouteRef.current = null
      navigateTo('/')
    },
    [
      rememberExecutionDevice,
      cancelRuntimeTranscriptLoad,
      state.devices,
      state.standaloneDeviceId,
      user.preferences?.default_execution_target,
    ]
  )

  const startNewChat = useCallback(() => {
    dispatch({
      type: 'project_cleared',
      standaloneDeviceId: getRememberedStandaloneDeviceId(
        user,
        state.devices,
        state.standaloneDeviceId
      ),
    })
    dispatchMessages({ type: 'reset', messages: [] })
    setQueuedSends([])
    setGuidanceMessages([])
    setCodeCommentContexts([])
    cancelRuntimeTranscriptLoad()
    handledRuntimeTaskRouteRef.current = null
    navigateTo(`/?projectId=${STANDALONE_PROJECT_ID}`)
  }, [cancelRuntimeTranscriptLoad, state.devices, state.standaloneDeviceId, user])

  const startStandaloneChat = useCallback(() => {
    dispatch({
      type: 'project_cleared',
      standaloneDeviceId: getRememberedStandaloneDeviceId(
        user,
        state.devices,
        state.standaloneDeviceId
      ),
    })
    dispatchMessages({ type: 'reset', messages: [] })
    setQueuedSends([])
    setGuidanceMessages([])
    setCodeCommentContexts([])
    cancelRuntimeTranscriptLoad()
    handledRuntimeTaskRouteRef.current = null
    navigateTo(`/?projectId=${STANDALONE_PROJECT_ID}`)
  }, [cancelRuntimeTranscriptLoad, state.devices, state.standaloneDeviceId, user])

  const startNewProjectChat = useCallback(
    (projectId: number) => {
      const deviceWorkspaceId = getSingleProjectDeviceWorkspaceId(state.runtimeWork, projectId)
      selectProjectWorkspace(projectId, deviceWorkspaceId)
      dispatchMessages({ type: 'reset', messages: [] })
    },
    [selectProjectWorkspace, state.runtimeWork]
  )

  const openRuntimeLocalTask = useCallback(
    async (address: RuntimeTaskAddress) => {
      if (!resolvedServices.runtimeWorkApi) {
        dispatch({ type: 'error_set', error: 'Local runtime work is unavailable' })
        return
      }

      const requestId = runtimeOpenRequestIdRef.current + 1
      runtimeOpenRequestIdRef.current = requestId
      const loadingKey = getRuntimeTaskRouteKey(address)

      const runtimeProjectWork = state.runtimeWork?.projects.find(item =>
        item.deviceWorkspaces.some(
          workspace =>
            workspace.deviceId === address.deviceId &&
            workspace.localTasks.some(task => task.localTaskId === address.localTaskId)
        )
      )
      const project = runtimeProjectWork
        ? (state.projects.find(item => item.id === runtimeProjectWork.project.id) ?? {
            id: runtimeProjectWork.project.id,
            name: runtimeProjectWork.project.name,
            color: runtimeProjectWork.project.color,
            tasks: [],
          })
        : null

      if (project) {
        writeLastProjectId(user.id, project.id)
      }
      dispatch({
        type: 'runtime_task_opened',
        address,
        project,
      })
      currentRuntimeTaskRef.current = address
      dispatchMessages({ type: 'reset', messages: [] })
      setQueuedSends([])
      setGuidanceMessages([])
      setCodeCommentContexts([])
      setRuntimeTranscriptLoadingKey(loadingKey)
      handledRuntimeTaskRouteRef.current = loadingKey
      navigateTo(buildRuntimeTaskRoute(address))

      try {
        const transcript = await resolvedServices.runtimeWorkApi.getRuntimeTranscript(address)
        if (runtimeOpenRequestIdRef.current !== requestId) return

        dispatchMessages({
          type: 'reset',
          messages: transcript.messages.map(message =>
            runtimeMessageToWorkbenchMessage(address, message)
          ),
        })
      } finally {
        if (runtimeOpenRequestIdRef.current === requestId) {
          setRuntimeTranscriptLoadingKey(null)
        }
      }
    },
    [resolvedServices.runtimeWorkApi, state.projects, state.runtimeWork, user.id]
  )

  const archiveRuntimeLocalTask = useCallback(
    async (address: RuntimeTaskAddress) => {
      if (!resolvedServices.runtimeWorkApi) {
        dispatch({ type: 'error_set', error: 'Local runtime work is unavailable' })
        return
      }

      const response = await resolvedServices.runtimeWorkApi.archiveRuntimeTask(address)
      if (!response.accepted) {
        dispatch({ type: 'error_set', error: response.error || 'Failed to archive runtime task' })
        return
      }

      if (
        state.currentRuntimeTask?.deviceId === address.deviceId &&
        state.currentRuntimeTask.localTaskId === address.localTaskId
      ) {
        dispatch({ type: 'current_task_cleared' })
        currentRuntimeTaskRef.current = null
        dispatchMessages({ type: 'reset', messages: [] })
        setQueuedSends([])
        setGuidanceMessages([])
        setCodeCommentContexts([])
        handledRuntimeTaskRouteRef.current = null
        navigateTo('/')
      }

      await refreshWorkLists()
    },
    [refreshWorkLists, resolvedServices.runtimeWorkApi, state.currentRuntimeTask]
  )

  const forkCurrentRuntimeTask = useCallback(
    async (target: RuntimeTaskForkTarget) => {
      if (!resolvedServices.runtimeWorkApi) {
        dispatch({ type: 'error_set', error: 'Local runtime work is unavailable' })
        return
      }
      if (!state.currentRuntimeTask) {
        dispatch({ type: 'error_set', error: 'No runtime task is selected' })
        return
      }

      const response = await resolvedServices.runtimeWorkApi.forkRuntimeTask({
        source: state.currentRuntimeTask,
        target,
      })
      if (!response.accepted) {
        dispatch({ type: 'error_set', error: response.error || 'Failed to fork runtime task' })
        return
      }

      await refreshWorkLists()
      await openRuntimeLocalTask(response.target)
    },
    [
      openRuntimeLocalTask,
      refreshWorkLists,
      resolvedServices.runtimeWorkApi,
      state.currentRuntimeTask,
    ]
  )

  const refreshRuntimeTranscript = useCallback(
    async (address: RuntimeTaskAddress, shouldApply: () => boolean = () => true) => {
      if (!resolvedServices.runtimeWorkApi) return
      const transcript = await resolvedServices.runtimeWorkApi.getRuntimeTranscript(address)
      if (!shouldApply()) return
      dispatchMessages({
        type: 'reset',
        messages: transcript.messages.map(message =>
          runtimeMessageToWorkbenchMessage(address, message)
        ),
      })
    },
    [resolvedServices.runtimeWorkApi]
  )

  useEffect(() => {
    if (state.isBootstrapping) return

    const runtimeTaskRoute = parseRuntimeTaskRoute(routePath, routeSearch)
    if (!runtimeTaskRoute) return

    const routeKey = getRuntimeTaskRouteKey(runtimeTaskRoute)
    if (handledRuntimeTaskRouteRef.current === routeKey) return

    if (isSameRuntimeTaskIdentity(state.currentRuntimeTask, runtimeTaskRoute)) {
      handledRuntimeTaskRouteRef.current = routeKey
      return
    }

    const runtimeTaskAddress = resolveRuntimeTaskRouteAddress(state.runtimeWork, runtimeTaskRoute)
    if (!runtimeTaskAddress) return

    handledRuntimeTaskRouteRef.current = routeKey
    const timer = window.setTimeout(() => {
      void openRuntimeLocalTask(runtimeTaskAddress)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [
    openRuntimeLocalTask,
    routePath,
    routeSearch,
    state.currentRuntimeTask,
    state.isBootstrapping,
    state.runtimeWork,
  ])

  const listImPrivateSessions = useCallback(
    () =>
      resolvedServices.imSessionApi?.listPrivateSessions() ??
      Promise.resolve({ total: 0, items: [] }),
    [resolvedServices]
  )

  const bindRuntimeTaskToImSessions = useCallback(
    (address: RuntimeTaskAddress, sessionKeys: string[]) => {
      if (!resolvedServices.runtimeWorkApi) {
        return Promise.reject(new Error('Runtime work API is unavailable'))
      }
      return resolvedServices.runtimeWorkApi.bindRuntimeTaskImSessions({
        address,
        sessionKeys,
      })
    },
    [resolvedServices]
  )

  const getImNotificationSettings = useCallback(() => {
    if (!resolvedServices.runtimeWorkApi) {
      return Promise.reject(new Error('Runtime work API is unavailable'))
    }
    return resolvedServices.runtimeWorkApi.getImNotificationSettings()
  }, [resolvedServices])

  const updateGlobalImNotification = useCallback(
    (data: RuntimeGlobalIMNotificationUpdateRequest) => {
      if (!resolvedServices.runtimeWorkApi) {
        return Promise.reject(new Error('Runtime work API is unavailable'))
      }
      return resolvedServices.runtimeWorkApi.updateGlobalImNotification(data)
    },
    [resolvedServices]
  )

  const subscribeRuntimeTaskNotifications = useCallback(
    (data: RuntimeTaskIMNotificationSubscriptionRequest) => {
      if (!resolvedServices.runtimeWorkApi) {
        return Promise.reject(new Error('Runtime work API is unavailable'))
      }
      return resolvedServices.runtimeWorkApi.subscribeRuntimeTaskNotifications(data)
    },
    [resolvedServices]
  )

  const unsubscribeRuntimeTaskNotifications = useCallback(
    (address: RuntimeTaskAddress) => {
      if (!resolvedServices.runtimeWorkApi) {
        return Promise.reject(new Error('Runtime work API is unavailable'))
      }
      return resolvedServices.runtimeWorkApi.unsubscribeRuntimeTaskNotifications(address)
    },
    [resolvedServices]
  )

  const setInput = useCallback((input: string) => {
    dispatch({ type: 'input_changed', input })
  }, [])

  const createProject = useCallback(
    async (data: CreateProjectRequest, options: ProjectMutationOptions = {}) => {
      const project = await resolvedServices.projectApi.createProject(data)
      const projectDeviceId = data.config?.execution?.deviceId ?? data.config?.device_id
      if (projectDeviceId) {
        rememberExecutionDevice(projectDeviceId)
      }
      if (options.refreshWorkLists === false) {
        dispatch({ type: 'project_created', project })
      } else {
        await refreshWorkLists()
      }
      writeLastProjectId(user.id, project.id)
      dispatch({ type: 'project_selected', project })
      dispatchMessages({ type: 'reset', messages: [] })
      setQueuedSends([])
      setGuidanceMessages([])
      setCodeCommentContexts([])
      return project
    },
    [refreshWorkLists, rememberExecutionDevice, resolvedServices, user.id]
  )

  const createGitWorkspaceProject = useCallback(
    async (data: CreateGitWorkspaceProjectRequest) => {
      if (!resolvedServices.projectApi.createGitWorkspaceProject) {
        throw new Error('Git workspace project creation is unavailable')
      }
      const response = await resolvedServices.projectApi.createGitWorkspaceProject(data)
      const project: ProjectWithTasks = {
        ...response.project,
        tasks: response.project.tasks ?? [],
      }
      rememberExecutionDevice(data.device_id)
      await refreshWorkLists()
      writeLastProjectId(user.id, project.id)
      dispatch({ type: 'project_selected', project })
      dispatchMessages({ type: 'reset', messages: [] })
      setQueuedSends([])
      setGuidanceMessages([])
      setCodeCommentContexts([])
      return project
    },
    [refreshWorkLists, rememberExecutionDevice, resolvedServices, user.id]
  )

  const prepareDeviceWorkspace = useCallback(
    async (data: DeviceWorkspacePrepareRequest, options: ProjectMutationOptions = {}) => {
      if (!resolvedServices.runtimeWorkApi) {
        throw new Error('Runtime work is unavailable')
      }
      const response = await resolvedServices.runtimeWorkApi.prepareDeviceWorkspace(data)
      rememberExecutionDevice(data.deviceId)
      if (options.refreshWorkLists === false) {
        dispatch({ type: 'device_workspace_prepared', mapping: response.mapping })
        void refreshWorkLists().catch(() => {
          // Keep the optimistic workspace mapping when the background refresh fails.
        })
      } else {
        await refreshWorkLists()
      }
      return response
    },
    [refreshWorkLists, rememberExecutionDevice, resolvedServices.runtimeWorkApi]
  )

  const deleteDeviceWorkspace = useCallback(
    async (data: DeleteDeviceWorkspaceRequest) => {
      if (!resolvedServices.runtimeWorkApi) {
        throw new Error('Runtime work is unavailable')
      }
      await resolvedServices.runtimeWorkApi.deleteDeviceWorkspace(data)
      await refreshWorkLists()
    },
    [refreshWorkLists, resolvedServices.runtimeWorkApi]
  )

  const listGitRepositories = useCallback(
    () => resolvedServices.gitApi?.listRepositories() ?? Promise.resolve([]),
    [resolvedServices]
  )

  const listGitBranches = useCallback(
    (repo: GitRepoInfo) => resolvedServices.gitApi?.listBranches(repo) ?? Promise.resolve([]),
    [resolvedServices]
  )

  const updateProjectName = useCallback(
    async (projectId: number, name: string) => {
      await resolvedServices.projectApi.updateProject(projectId, { name })
      await refreshWorkLists()
    },
    [refreshWorkLists, resolvedServices]
  )

  const removeProject = useCallback(
    async (projectId: number) => {
      await resolvedServices.projectApi.deleteProject(projectId)
      await refreshWorkLists()
    },
    [refreshWorkLists, resolvedServices]
  )

  const getDeviceHomeDirectory = useCallback(
    (deviceId: string) => resolvedServices.deviceApi.getHomeDirectory(deviceId),
    [resolvedServices]
  )

  const getProjectWorkspaceRoot = useCallback(
    (deviceId: string) => resolvedServices.deviceApi.getProjectWorkspaceRoot(deviceId),
    [resolvedServices]
  )

  const listDeviceDirectories = useCallback(
    (deviceId: string, path: string) => resolvedServices.deviceApi.listDirectories(deviceId, path),
    [resolvedServices]
  )

  const createDeviceDirectory = useCallback(
    (deviceId: string, path: string) => resolvedServices.deviceApi.createDirectory(deviceId, path),
    [resolvedServices]
  )

  const loadEnvironmentInfo = useCallback(
    (project: ProjectWithTasks | null, workspaceTarget?: WorkspaceTarget | null) =>
      loadProjectEnvironment(resolvedServices.deviceApi, project, workspaceTarget),
    [resolvedServices]
  )

  const loadEnvironmentDiff = useCallback(
    (project: ProjectWithTasks | null, workspaceTarget?: WorkspaceTarget | null) =>
      loadProjectEnvironmentDiff(resolvedServices.deviceApi, project, workspaceTarget),
    [resolvedServices]
  )

  const commitEnvironmentChanges = useCallback(
    (project: ProjectWithTasks | null, message: string, workspaceTarget?: WorkspaceTarget | null) =>
      commitProjectChanges(resolvedServices.deviceApi, project, message, workspaceTarget),
    [resolvedServices]
  )

  const listEnvironmentBranches = useCallback(
    (project: ProjectWithTasks | null, workspaceTarget?: WorkspaceTarget | null) =>
      listProjectBranches(resolvedServices.deviceApi, project, workspaceTarget),
    [resolvedServices]
  )

  const checkoutEnvironmentBranch = useCallback(
    (
      project: ProjectWithTasks | null,
      branchName: string,
      workspaceTarget?: WorkspaceTarget | null
    ) => checkoutProjectBranch(resolvedServices.deviceApi, project, branchName, workspaceTarget),
    [resolvedServices]
  )

  const createEnvironmentBranch = useCallback(
    (
      project: ProjectWithTasks | null,
      branchName: string,
      workspaceTarget?: WorkspaceTarget | null
    ) =>
      createAndCheckoutProjectBranch(
        resolvedServices.deviceApi,
        project,
        branchName,
        workspaceTarget
      ),
    [resolvedServices]
  )

  const activeAssistantMessage = useMemo(
    () =>
      [...messages]
        .reverse()
        .find(
          message =>
            message.role === 'assistant' && message.status === 'streaming' && message.subtaskId
        ),
    [messages]
  )
  const hasActiveTurn = Boolean(activeAssistantMessage)

  const buildSendPayload = useCallback(
    (
      message: string,
      sourceAttachments?: Attachment[]
    ): { payload: ChatSendPayload; activeDeviceId?: string } | null => {
      if (!state.defaultTeam) return null
      const activeProject = state.currentProject

      const selectedProjectWorkspace = findProjectDeviceWorkspace(
        state.runtimeWork,
        activeProject?.id,
        state.selectedDeviceWorkspaceId
      )
      const activeDeviceId =
        activeProject && selectedProjectWorkspace
          ? selectedProjectWorkspace.deviceId
          : getActiveWorkbenchDeviceId({
              currentProject: activeProject,
              standaloneDeviceId: state.standaloneDeviceId,
            })

      const payload: ChatSendPayload = {
        team_id: state.defaultTeam.id,
        project_id: activeProject?.id ?? STANDALONE_PROJECT_ID,
        client_origin: WEWORK_CLIENT_ORIGIN,
        device_id: activeDeviceId,
        task_type: 'code',
        message,
      }

      const selectedModel =
        modelSelection.selectedModel ?? resolveAutomaticModel(modelSelection.models)

      if (
        activeProject &&
        projectExecutionMode === 'git_worktree' &&
        supportsGitWorktreeExecution(activeProject)
      ) {
        const branch = projectWorktreeBaseBranch?.trim()
        payload.execution = {
          workspace: {
            source: 'git_worktree',
            ...(branch ? { branch } : {}),
          },
        }
      }

      if (selectedModel) {
        payload.force_override_bot_model = selectedModel.name
        payload.force_override_bot_model_type = selectedModel.type
        if (
          modelSelection.selectedModel &&
          Object.keys(modelSelection.selectedModelOptions).length > 0
        ) {
          payload.model_options = modelSelection.selectedModelOptions
        }
      }

      if (!isOptionsLocked && skillSelection.selectedSkills.length > 0) {
        payload.additional_skills = skillSelection.selectedSkills
      }

      const payloadAttachments = sourceAttachments ?? attachmentSelection.attachments
      if (payloadAttachments.length > 0) {
        payload.attachment_ids = payloadAttachments.map(attachment => attachment.id)
        if (!message) {
          payload.title = EMPTY_MESSAGE_TASK_TITLE
        }
      }

      return { payload, activeDeviceId }
    },
    [
      attachmentSelection.attachments,
      isOptionsLocked,
      modelSelection.models,
      modelSelection.selectedModel,
      modelSelection.selectedModelOptions,
      skillSelection.selectedSkills,
      projectWorktreeBaseBranch,
      projectExecutionMode,
      state.currentProject,
      state.defaultTeam,
      state.runtimeWork,
      state.selectedDeviceWorkspaceId,
      state.standaloneDeviceId,
    ]
  )

  const sendPreparedRuntimeMessage = useCallback(
    async (
      displayMessage: string,
      payload: ChatSendPayload,
      activeDeviceId?: string
    ): Promise<boolean> => {
      if (!resolvedServices.runtimeWorkApi) {
        reportSendBlocked('Local runtime work is unavailable')
        return false
      }
      const projectId = payload.project_id && payload.project_id > 0 ? payload.project_id : null
      const selectedProjectWorkspace = findProjectDeviceWorkspace(
        state.runtimeWork,
        projectId,
        state.selectedDeviceWorkspaceId
      )
      let runtimeTaskTarget: Pick<
        RuntimeTaskCreateRequest,
        'projectId' | 'deviceWorkspaceId' | 'deviceId' | 'workspacePath'
      >
      if (projectId) {
        if (!selectedProjectWorkspace) {
          reportSendBlocked('请选择任务运行位置')
          return false
        }
        runtimeTaskTarget =
          selectedProjectWorkspace.id != null
            ? {
                projectId,
                deviceWorkspaceId: selectedProjectWorkspace.id,
              }
            : {
                deviceId: selectedProjectWorkspace.deviceId,
                workspacePath: selectedProjectWorkspace.workspacePath,
              }
      } else {
        const workspacePath = findRuntimeWorkspaceForDevice(state.runtimeWork, activeDeviceId)
        if (!activeDeviceId || !workspacePath) {
          reportSendBlocked('请选择项目或打开设备工作区后再发送')
          return false
        }
        runtimeTaskTarget = {
          deviceId: activeDeviceId,
          workspacePath,
        }
      }

      const selectedModel =
        modelSelection.selectedModel ?? resolveAutomaticModel(modelSelection.models)
      const createRequest: RuntimeTaskCreateRequest = {
        ...runtimeTaskTarget,
        teamId: payload.team_id,
        runtime: inferRuntimeName(selectedModel),
        message: payload.message,
        title: buildRuntimeTaskTitle(displayMessage, payload.title),
        modelId: payload.force_override_bot_model,
        modelType: payload.force_override_bot_model_type ?? null,
        modelOptions: payload.model_options ?? {},
        additionalSkills: payload.additional_skills ?? [],
        attachmentIds: payload.attachment_ids ?? [],
        execution: payload.execution,
      }

      dispatch({ type: 'sending_started' })
      dispatchMessages({
        type: 'user_added',
        message: {
          id: `runtime-local-${Date.now()}`,
          role: 'user',
          content: displayMessage,
          status: 'done',
          createdAt: new Date().toISOString(),
        },
      })

      try {
        const response = await resolvedServices.runtimeWorkApi.createRuntimeTask(createRequest)
        if (!response.accepted) {
          throw new Error(response.error || '发送失败')
        }
        const address: RuntimeTaskAddress = {
          deviceId: response.deviceId,
          localTaskId: response.localTaskId,
        }
        const runtimeProject = projectId
          ? (state.projects.find(project => project.id === projectId) ?? state.currentProject)
          : null
        if (address.deviceId) rememberExecutionDevice(address.deviceId)
        currentRuntimeTaskRef.current = address
        dispatch({
          type: 'runtime_task_opened',
          address,
          project: runtimeProject,
        })
        await refreshWorkLists()
        await refreshRuntimeTranscript(address)
        handledRuntimeTaskRouteRef.current = getRuntimeTaskRouteKey(address)
        navigateTo(buildRuntimeTaskRoute(address))
        return true
      } catch (error) {
        dispatch({
          type: 'error_set',
          error: error instanceof Error ? error.message : '发送失败',
        })
        return false
      } finally {
        dispatch({ type: 'sending_finished' })
      }
    },
    [
      modelSelection.models,
      modelSelection.selectedModel,
      refreshWorkLists,
      refreshRuntimeTranscript,
      rememberExecutionDevice,
      reportSendBlocked,
      resolvedServices.runtimeWorkApi,
      state.currentProject,
      state.projects,
      state.runtimeWork,
      state.selectedDeviceWorkspaceId,
    ]
  )

  const sendCurrentInput = useCallback(async () => {
    const trimmedMessage = state.input.trim()
    const hasAttachments = attachmentSelection.attachments.length > 0
    const hasCodeComments = codeCommentContexts.length > 0
    if (!trimmedMessage && !hasAttachments && !hasCodeComments) {
      reportSendBlocked('请输入内容或添加附件后再发送')
      return
    }
    const message =
      trimmedMessage || (hasCodeComments ? i18n.t('workbench.code_comment_fallback') : '')
    const payloadMessage = appendCodeCommentContexts(message, codeCommentContexts)

    if (state.currentRuntimeTask) {
      if (hasAttachments || hasCodeComments) {
        reportSendBlocked('当前 LocalTask 暂不支持附件或代码评论')
        return
      }
      if (!resolvedServices.runtimeWorkApi) {
        reportSendBlocked('Local runtime work is unavailable')
        return
      }

      dispatch({ type: 'input_changed', input: '' })
      dispatch({ type: 'sending_started' })
      dispatchMessages({
        type: 'user_added',
        message: {
          id: `runtime-local-${Date.now()}`,
          role: 'user',
          content: payloadMessage,
          status: 'done',
          createdAt: new Date().toISOString(),
        },
      })

      try {
        const response = await resolvedServices.runtimeWorkApi.sendRuntimeMessage({
          address: state.currentRuntimeTask,
          message: payloadMessage,
        })
        if (!response.accepted) {
          throw new Error(response.error || '发送失败')
        }
        await refreshWorkLists()
      } catch (error) {
        dispatch({
          type: 'error_set',
          error: error instanceof Error ? error.message : '发送失败',
        })
      } finally {
        dispatch({ type: 'sending_finished' })
      }
      return
    }

    const prepared = buildSendPayload(payloadMessage)
    if (!prepared) {
      reportSendBlocked('Wework default team is not configured', {
        hasDefaultTeam: Boolean(state.defaultTeam),
      })
      return
    }
    if (prepared.activeDeviceId) {
      const activeDevice = findWorkbenchDevice(state.devices, prepared.activeDeviceId)
      if (!isWorkbenchDeviceOnline(activeDevice)) {
        const deviceName = getWorkbenchDeviceDisplayName(activeDevice, prepared.activeDeviceId)
        const status = activeDevice
          ? (DEVICE_STATUS_LABELS[activeDevice.status] ?? activeDevice.status)
          : '不可用'
        reportSendBlocked(`${deviceName} ${status}，恢复在线后可继续对话`, {
          activeDeviceId: prepared.activeDeviceId,
          deviceStatus: activeDevice?.status ?? null,
        })
        return
      }
      if (activeDevice && isDeviceBelowWeWorkVersion(activeDevice)) {
        const deviceName = getWorkbenchDeviceDisplayName(activeDevice, prepared.activeDeviceId)
        reportSendBlocked(
          `${deviceName} 版本低于 ${WEWORK_MIN_EXECUTOR_VERSION}，升级后可继续对话`,
          {
            activeDeviceId: prepared.activeDeviceId,
            executorVersion: activeDevice.executor_version ?? null,
          }
        )
        return
      }
    } else if (!state.currentProject) {
      const hasOnlineCompatibleDevice = state.devices.some(
        device => device.status === 'online' && isWeWorkCompatibleDevice(device)
      )
      if (!hasOnlineCompatibleDevice) {
        reportSendBlocked(`暂无满足 ${WEWORK_MIN_EXECUTOR_VERSION} 的在线设备，请连接或升级设备`, {
          deviceCount: state.devices.length,
        })
        return
      }
    }

    dispatch({ type: 'input_changed', input: '' })

    const sent = await sendPreparedRuntimeMessage(
      message,
      prepared.payload,
      prepared.activeDeviceId
    )
    if (sent) {
      attachmentSelection.resetAttachments()
      clearCodeCommentContexts()
    }
  }, [
    attachmentSelection,
    buildSendPayload,
    clearCodeCommentContexts,
    codeCommentContexts,
    reportSendBlocked,
    sendPreparedRuntimeMessage,
    state.devices,
    state.currentProject,
    state.currentRuntimeTask,
    state.defaultTeam,
    state.input,
    refreshWorkLists,
    resolvedServices.runtimeWorkApi,
  ])

  const retryFailedMessage = useCallback(
    async (messageId: string) => {
      const failedMessageIndex = messages.findIndex(
        message =>
          message.id === messageId && message.role === 'assistant' && message.status === 'failed'
      )
      if (failedMessageIndex === -1) {
        dispatch({ type: 'error_set', error: '未找到可重试的失败消息' })
        return
      }

      const previousUserMessage = [...messages]
        .slice(0, failedMessageIndex)
        .reverse()
        .find(message => message.role === 'user')
      if (!previousUserMessage) {
        dispatch({ type: 'error_set', error: '未找到可重试的用户消息' })
        return
      }

      if (state.currentRuntimeTask) {
        if (!resolvedServices.runtimeWorkApi) {
          reportSendBlocked('Local runtime work is unavailable')
          return
        }
        try {
          const response = await resolvedServices.runtimeWorkApi.sendRuntimeMessage({
            address: state.currentRuntimeTask,
            message: previousUserMessage.content,
          })
          if (!response.accepted) {
            throw new Error(response.error || '发送失败')
          }
          await refreshWorkLists()
        } catch (error) {
          dispatch({
            type: 'error_set',
            error: error instanceof Error ? error.message : '发送失败',
          })
        }
        return
      }

      reportSendBlocked('当前没有可重试的 LocalTask')
    },
    [
      messages,
      refreshWorkLists,
      reportSendBlocked,
      resolvedServices.runtimeWorkApi,
      state.currentRuntimeTask,
    ]
  )

  const cancelQueuedMessage = useCallback((id: string) => {
    setQueuedSends(items => items.filter(item => item.id !== id))
  }, [])

  const editQueuedMessage = useCallback(
    (id: string) => {
      const item = queuedSends.find(queued => queued.id === id)
      if (!item || item.status === 'sending') return

      dispatch({ type: 'input_changed', input: item.content })
      setCodeCommentContexts(item.codeComments ?? [])
      for (const attachment of item.attachments ?? []) {
        attachmentSelection.addExistingAttachment(attachment)
      }
      setQueuedSends(items => items.filter(queued => queued.id !== id))
    },
    [attachmentSelection, queuedSends]
  )

  const cancelGuidanceMessage = useCallback((id: string) => {
    setGuidanceMessages(items => items.filter(item => item.id !== id))
  }, [])

  const loadTurnFileChangesDiff = useCallback(
    async (subtaskId: number) => {
      const loadDiff = resolvedServices.taskApi.getTurnFileChangesDiff
      if (!loadDiff) throw new Error('File changes review is unavailable')
      const response = await loadDiff(subtaskId)
      return response.diff
    },
    [resolvedServices.taskApi]
  )

  const revertTurnFileChanges = useCallback(
    async (subtaskId: number) => {
      const revert = resolvedServices.taskApi.revertTurnFileChanges
      if (!revert) throw new Error('File changes revert is unavailable')
      try {
        const response = await revert(subtaskId)
        const fileChanges = normalizeTurnFileChanges(response.file_changes)
        if (!fileChanges) {
          throw new Error('Invalid file changes response')
        }
        dispatchMessages({
          type: 'file_changes_updated',
          subtaskId,
          fileChanges,
        })
        return fileChanges
      } catch (error) {
        if (error instanceof ApiError && isRecord(error.detail)) {
          const fileChanges = normalizeTurnFileChanges(error.detail.file_changes)
          if (fileChanges) {
            dispatchMessages({
              type: 'file_changes_updated',
              subtaskId,
              fileChanges,
            })
          }
        }
        throw error
      }
    },
    [resolvedServices.taskApi]
  )

  const pauseCurrentResponse = useCallback(async () => {
    if (!activeAssistantMessage?.subtaskId) return

    const ack = await resolvedServices.chatStream.cancelStream({
      subtask_id: activeAssistantMessage.subtaskId,
      partial_content: activeAssistantMessage.content,
      shell_type: activeAssistantMessage.shellType,
    })

    if (ack.error || ack.success === false) {
      dispatch({
        type: 'error_set',
        error: normalizeGuidanceError(ack.error ?? '取消当前回复失败'),
      })
      return
    }

    dispatchMessages({
      type: 'assistant_done',
      subtaskId: activeAssistantMessage.subtaskId,
      content: activeAssistantMessage.content,
    })
  }, [activeAssistantMessage, resolvedServices.chatStream])

  const sendQueuedAsGuidance = useCallback(async (id: string) => {
    setQueuedSends(items =>
      items.map(queued =>
        queued.id === id
          ? { ...queued, status: 'failed', error: '当前 LocalTask 暂不支持引导' }
          : queued
      )
    )
  }, [])

  const listLocalSkills = useCallback(async () => {
    if (!activeDeviceId) return []

    const cached = localSkillsCacheRef.current.get(activeDeviceId)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.skills
    }

    const skills = await resolvedServices.deviceApi.listSkills(activeDeviceId)
    localSkillsCacheRef.current.set(activeDeviceId, {
      expiresAt: Date.now() + LOCAL_SKILLS_CACHE_TTL_MS,
      skills,
    })
    return skills
  }, [activeDeviceId, resolvedServices.deviceApi])

  const value: WorkbenchContextValue = {
    state,
    messages,
    queuedMessages: queuedSends,
    guidanceMessages,
    codeCommentContexts,
    isRuntimeTranscriptLoading,
    upgradingDevices,
    projectExecutionMode,
    setProjectExecutionMode: selectProjectExecutionMode,
    projectWorktreeBaseBranch,
    setProjectWorktreeBaseBranch,
    projectChat: {
      models: modelSelection.models,
      skills: skillSelection.skills,
      selectedModel: modelSelection.selectedModel,
      selectedModelOptions: modelSelection.selectedModelOptions,
      isModelSelectionReady: modelSelection.isSelectionReady,
      selectedSkills: skillSelection.selectedSkills,
      attachments: attachmentSelection.attachments,
      uploadingFiles: attachmentSelection.uploadingFiles,
      errors: attachmentSelection.errors,
      isOptionsLocked,
      isAttachmentReadyToSend: attachmentSelection.isAttachmentReadyToSend,
      setSelectedModel: modelSelection.setSelectedModel,
      setSelectedModelOption: modelSelection.setSelectedModelOption,
      onBlockedModelSelect: handleBlockedModelSelect,
      setSelectedSkills: skillSelection.setSelectedSkills,
      toggleSkill: skillSelection.toggleSkill,
      handleFileSelect: attachmentSelection.handleFileSelect,
      addExistingAttachment: attachmentSelection.addExistingAttachment,
      removeAttachment: attachmentSelection.removeAttachment,
      resetAttachments: attachmentSelection.resetAttachments,
      listLocalSkills,
    },
    selectProject,
    selectProjectWorkspace,
    selectStandaloneDevice,
    startNewChat,
    startStandaloneChat,
    startNewProjectChat,
    openRuntimeLocalTask,
    archiveRuntimeLocalTask,
    forkCurrentRuntimeTask,
    listImPrivateSessions,
    bindRuntimeTaskToImSessions,
    getImNotificationSettings,
    updateGlobalImNotification,
    subscribeRuntimeTaskNotifications,
    unsubscribeRuntimeTaskNotifications,
    rememberExecutionDevice,
    refreshWorkLists,
    refreshDevices,
    upgradeDevice,
    createProject,
    createGitWorkspaceProject,
    prepareDeviceWorkspace,
    deleteDeviceWorkspace,
    listGitRepositories,
    listGitBranches,
    updateProjectName,
    removeProject,
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
    createDeviceDirectory,
    loadEnvironmentInfo,
    loadEnvironmentDiff,
    commitEnvironmentChanges,
    listEnvironmentBranches,
    checkoutEnvironmentBranch,
    createEnvironmentBranch,
    setInput,
    addCodeCommentContext,
    removeCodeCommentContext,
    clearCodeCommentContexts,
    sendCurrentInput,
    retryFailedMessage,
    pauseCurrentResponse,
    isResponseStreaming: hasActiveTurn,
    cancelQueuedMessage,
    sendQueuedAsGuidance,
    editQueuedMessage,
    cancelGuidanceMessage,
    loadTurnFileChangesDiff,
    revertTurnFileChanges,
  }

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
}
