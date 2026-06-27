import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createDeviceApi } from '@/api/devices'
import {
  createExecutorClientFromApis,
  type ExecutorClient,
  type ExecutorTransportKind,
} from '@/api/executorAccess'
import {
  checkoutProjectBranch,
  commitProjectChanges,
  createAndCheckoutProjectBranch,
  listProjectBranches,
  loadProjectEnvironment,
  loadProjectEnvironmentDiff,
  type EnvironmentDiffMode,
} from '@/api/environment'
import { createGitApi } from '@/api/git'
import { ApiError } from '@/api/http'
import { createImSessionApi } from '@/api/imSessions'
import { createLocalAppServices } from '@/api/local/localServices'
import { createHybridWorkbenchServices } from '@/api/hybrid/hybridServices'
import { createModelApi } from '@/api/models'
import { createProjectApi } from '@/api/projects'
import { createRuntimeWorkApi } from '@/api/runtimeWork'
import { createSkillApi } from '@/api/skills'
import { createTaskApi } from '@/api/tasks'
import { createTeamApi } from '@/api/teams'
import { createUserApi } from '@/api/users'
import { createBackendWorkbenchServices, WEWORK_CLIENT_ORIGIN } from '@/api/backend/backendServices'
import { getRuntimeConfig, stripAppBasePath } from '@/config/runtime'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { resolveModelExecutionSelection } from '@/features/cloud-connection/modelExecution'
import i18n from '@/i18n'
import { createChatStream } from '@/stream/chatStream'
import { appendCodeCommentContexts } from '@/lib/code-comment-context'
import { joinDevicePath } from '@/lib/device-workspace-path'
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
import { isTauriRuntime } from '@/lib/runtime-environment'
import { runtimeProjectToProject, runtimeProjectUiId } from '@/lib/runtime-project'
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
  LocalTaskSummary,
  ModelCompatibilityDisabledReason,
  ModelOptions,
  ModelSelectionConfig,
  NormalizedRuntimeMessage,
  ProjectExecutionMode,
  ProjectWithTasks,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  RuntimeDeviceWorkspace,
  RuntimeTaskForkTarget,
  RuntimeGlobalIMNotificationUpdateRequest,
  RuntimeIMNotificationSettingsResponse,
  RuntimeTaskIMNotificationSubscriptionRequest,
  RuntimeTaskIMNotificationSubscriptionResponse,
  RuntimeWorkSearchRequest,
  RuntimeWorkSearchResponse,
  RuntimeWorkListResponse,
  SkillRef,
  TurnFileChangesSummary,
  UnifiedModel,
  UnifiedSkill,
  User,
} from '@/types/api'
import type { DeviceUpgradeState, DeviceUpgradeStatusPayload } from '@/types/device-events'
import type { DockerRemoteDeviceCommandResponse } from '@/types/devices'
import type { EnvironmentInfo } from '@/types/environment'
import type { CodeCommentContext, WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import type {
  CloudWorkCheckKey,
  CloudWorkCheckStatus,
  CloudWorkStatus,
  GuidanceWorkbenchMessage,
  MessageSource,
  ProcessingBlock,
  QueuedWorkbenchMessage,
  WorkbenchMessage,
  WorkbenchState,
} from '@/types/workbench'
import { normalizeWorkbenchBlockStatus, reduceWorkbenchMessages } from '@wegent/chat-core'
import type { AuthenticatedSocketClient } from '@wegent/chat-core'
import { useWorkbenchAttachments } from './useWorkbenchAttachments'
import { useWorkbenchModels } from './useWorkbenchModels'
import { useWorkbenchSkills } from './useWorkbenchSkills'
import { normalizeTurnFileChanges } from './turnFileChanges'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'
import { WorkbenchContext } from './useWorkbench'

const CODEX_RUNTIME_MODEL_NAME = 'codex-gpt-5.5'
const OPENAI_RESPONSES_RUNTIME_FAMILY = 'openai.openai-responses'
const CLAUDE_CODE_RUNTIME_FAMILY = 'claude.claude'
const OPENAI_RESPONSES_PROTOCOL = 'openai-responses'
const RESPONSES_API_FORMAT = 'responses'
const LOCAL_SKILLS_CACHE_TTL_MS = 60_000
const RUNTIME_TRANSCRIPT_PAGE_SIZE = 50
const STANDALONE_PROJECT_ID = 0
const EMPTY_MESSAGE_TASK_TITLE = '新对话'
const DEFAULT_CONVERSATION_WORKSPACE_NAME = 'new-chat'
const MAX_CONVERSATION_WORKSPACE_NAME_LENGTH = 20
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
  chats: [],
  totalLocalTasks: 0,
}
const CLOUD_WORK_CHECK_KEYS: CloudWorkCheckKey[] = ['teams', 'devices', 'runtimeWork']
const EMPTY_CLOUD_WORK_STATUS: CloudWorkStatus = {
  availability: 'idle',
  checks: {
    teams: 'idle',
    devices: 'idle',
    runtimeWork: 'idle',
  },
  error: null,
  updatedAt: null,
}

function cloudWorkAvailability(
  checks: Record<CloudWorkCheckKey, CloudWorkCheckStatus>
): CloudWorkStatus['availability'] {
  const activeStatuses = CLOUD_WORK_CHECK_KEYS.map(key => checks[key]).filter(
    status => status !== 'idle'
  )
  if (activeStatuses.length === 0) return 'idle'
  if (activeStatuses.includes('syncing')) return 'syncing'
  if (activeStatuses.includes('unavailable')) return 'unavailable'
  if (checks.devices === 'empty') return 'empty'
  return 'available'
}

function cloudWorkErrorMessage(
  label: string,
  result: PromiseSettledResult<unknown>
): string | null {
  if (result.status === 'fulfilled') return null
  if (result.reason instanceof Error) return `${label}: ${result.reason.message}`
  return `${label}: ${String(result.reason || 'failed')}`
}

function startCloudWorkSync(keys: CloudWorkCheckKey[]): CloudWorkStatus {
  const checks = { ...EMPTY_CLOUD_WORK_STATUS.checks }
  keys.forEach(key => {
    checks[key] = 'syncing'
  })
  return {
    availability: cloudWorkAvailability(checks),
    checks,
    error: null,
    updatedAt: new Date().toISOString(),
  }
}

function finishCloudWorkCheck(
  current: CloudWorkStatus,
  key: CloudWorkCheckKey,
  label: string,
  result: PromiseSettledResult<unknown>,
  options?: {
    isEmpty?: (value: unknown) => boolean
  }
): CloudWorkStatus {
  const status =
    result.status === 'rejected'
      ? 'unavailable'
      : options?.isEmpty?.(result.value)
        ? 'empty'
        : 'available'
  const checks = {
    ...current.checks,
    [key]: status,
  }
  const nextError = cloudWorkErrorMessage(label, result)
  return {
    availability: cloudWorkAvailability(checks),
    checks,
    error: nextError ?? (status === 'available' || status === 'empty' ? current.error : null),
    updatedAt: new Date().toISOString(),
  }
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

function mergeDeviceLists(
  primaryDevices: DeviceInfo[],
  secondaryDevices: DeviceInfo[]
): DeviceInfo[] {
  const merged = new Map<string, DeviceInfo>()
  primaryDevices.forEach(device => merged.set(device.device_id, device))
  secondaryDevices.forEach(device => {
    const existing = merged.get(device.device_id)
    merged.set(device.device_id, existing ? { ...existing, ...device } : device)
  })
  return Array.from(merged.values())
}

function mergeRuntimeWorkLists(
  primaryWork: RuntimeWorkListResponse,
  secondaryWork: RuntimeWorkListResponse
): RuntimeWorkListResponse {
  return {
    projects: [...primaryWork.projects, ...secondaryWork.projects],
    chats: [...primaryWork.chats, ...secondaryWork.chats],
    totalLocalTasks: primaryWork.totalLocalTasks + secondaryWork.totalLocalTasks,
  }
}

interface QueuedWorkbenchSend extends QueuedWorkbenchMessage {
  runtimeAddress?: RuntimeTaskAddress
  attachments?: Attachment[]
  codeComments?: CodeCommentContext[]
  modelId?: string
  modelType?: RuntimeSendRequest['modelType']
  modelOptions?: ModelOptions
}

interface RuntimeTranscriptPageState {
  hasMoreBefore: boolean
  beforeCursor: string | null
  loadingMore: boolean
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
    | 'listWorkspaceEntries'
    | 'readWorkspaceTextFile'
  > & {
    createDockerRemoteDeviceCommand?: ReturnType<
      typeof createDeviceApi
    >['createDockerRemoteDeviceCommand']
  }
  imSessionApi?: ReturnType<typeof createImSessionApi>
  runtimeWorkApi?: ReturnType<typeof createRuntimeWorkApi>
  executorClient?: ExecutorClient
  userApi?: ReturnType<typeof createUserApi>
  socketClient?: Pick<AuthenticatedSocketClient, 'ensureConnected' | 'dispose'>
  chatStream: ReturnType<typeof createChatStream>
  cloudBackgroundApi?: {
    listTeams?: ReturnType<typeof createTeamApi>['listTeams']
    getDefaultWorkbenchTeam?: ReturnType<typeof createTeamApi>['getDefaultWorkbenchTeam']
    listDevices?: () => Promise<DeviceInfo[]>
    listRuntimeWork?: () => Promise<RuntimeWorkListResponse>
  }
}

async function createConversationWorkspace(
  deviceApi: Pick<WorkbenchServices['deviceApi'], 'createDirectory' | 'getHomeDirectory'>,
  deviceId: string,
  message: string
): Promise<string> {
  const homeDirectory = await deviceApi.getHomeDirectory(deviceId)
  const workspacePath = buildConversationWorkspacePath(homeDirectory, message)
  await deviceApi.createDirectory(deviceId, workspacePath)
  return workspacePath
}

function buildConversationWorkspacePath(homeDirectory: string, message: string): string {
  return joinDevicePath(
    homeDirectory,
    'Documents',
    'Codex',
    formatConversationWorkspaceDate(new Date()),
    slugifyConversationWorkspaceName(message)
  )
}

function formatConversationWorkspaceDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function slugifyConversationWorkspaceName(message: string): string {
  const words = message.match(/[A-Za-z0-9]+/g) ?? []
  const name = words.length > 0 ? words.map(word => word.toLowerCase()).join('-') : ''
  return trimConversationWorkspaceName(name || DEFAULT_CONVERSATION_WORKSPACE_NAME)
}

function trimConversationWorkspaceName(name: string): string {
  const trimmed = name.slice(0, MAX_CONVERSATION_WORKSPACE_NAME_LENGTH).replace(/-+$/g, '')
  return trimmed || DEFAULT_CONVERSATION_WORKSPACE_NAME
}

export interface WorkbenchContextValue {
  state: WorkbenchState
  isStartupReady: boolean
  messages: WorkbenchMessage[]
  queuedMessages: QueuedWorkbenchMessage[]
  guidanceMessages: GuidanceWorkbenchMessage[]
  codeCommentContexts: CodeCommentContext[]
  workspaceFileApi: WorkspaceFileApi
  currentRuntimeTaskRunning: boolean
  cloudWorkStatus: CloudWorkStatus
  isAwaitingAssistantStart: boolean
  isRuntimeTranscriptLoading: boolean
  runtimeTranscriptHasMoreBefore: boolean
  isRuntimeTranscriptLoadingMore: boolean
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
  projectWorktreeBranch: string | null
  setProjectWorktreeBranch: (branchName: string | null) => void
  selectProject: (projectId: number | null) => void
  selectProjectWorkspace: (projectId: number, deviceWorkspaceId: number | null) => void
  selectStandaloneDevice: (deviceId: string | null) => void
  openStandaloneWorkspace: (
    deviceId: string,
    workspacePath: string,
    label?: string
  ) => Promise<void>
  startNewChat: () => void
  startStandaloneChat: () => void
  startNewProjectChat: (projectId: number) => void
  openRuntimeLocalTask: (address: RuntimeTaskAddress) => Promise<void>
  searchRuntimeWork: (request: RuntimeWorkSearchRequest) => Promise<RuntimeWorkSearchResponse>
  loadOlderRuntimeTranscript: () => Promise<void>
  renameRuntimeLocalTask: (address: RuntimeTaskAddress, title: string) => Promise<void>
  archiveRuntimeLocalTask: (address: RuntimeTaskAddress) => Promise<void>
  archiveProjectConversations: (runtimeProjectKey: string) => Promise<void>
  archiveProjectsConversations: (runtimeProjectKeys: string[]) => Promise<void>
  archiveChatConversations: (addresses: RuntimeTaskAddress[]) => Promise<void>
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
  getRemoteDeviceStartupCommand: () => Promise<DockerRemoteDeviceCommandResponse>
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
    workspaceTarget?: WorkspaceTarget | null,
    mode?: EnvironmentDiffMode
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
  onStartupReadyChange?: (ready: boolean) => void
}

function createExecutorClientFromWorkbenchServices(
  services: WorkbenchServices,
  transportKind: ExecutorTransportKind
): ExecutorClient {
  if (!services.runtimeWorkApi) {
    throw new Error('Runtime work API is unavailable')
  }
  return createExecutorClientFromApis({
    transportKind,
    deviceApi: services.deviceApi,
    runtimeWorkApi: services.runtimeWorkApi,
    reviewApi: {
      loadTurnFileChangesDiff: services.taskApi.getTurnFileChangesDiff,
    },
  })
}

interface CloudConnectionServicesSnapshot {
  isConnected: boolean
  backendUrl?: string
  apiBaseUrl?: string
  socketBaseUrl?: string
  socketPath?: string
  token: string | null
}

function createDefaultServices(
  cloudConnection?: CloudConnectionServicesSnapshot
): WorkbenchServices {
  const { runtimeMode } = getRuntimeConfig()
  if (runtimeMode === 'local-first' && isTauriRuntime()) {
    if (
      cloudConnection?.isConnected &&
      cloudConnection.backendUrl &&
      cloudConnection.apiBaseUrl &&
      cloudConnection.socketBaseUrl &&
      cloudConnection.socketPath &&
      cloudConnection.token
    ) {
      return createHybridWorkbenchServices({
        backendUrl: cloudConnection.backendUrl,
        apiBaseUrl: cloudConnection.apiBaseUrl,
        socketBaseUrl: cloudConnection.socketBaseUrl,
        socketPath: cloudConnection.socketPath,
        token: cloudConnection.token,
      })
    }
    return createLocalAppServices()
  }

  return createBackendWorkbenchServices()
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

function isSameRuntimeTaskAddress(
  left: RuntimeTaskAddress | null | undefined,
  right: RuntimeTaskAddress
): boolean {
  return Boolean(left && left.deviceId === right.deviceId && left.localTaskId === right.localTaskId)
}

function workspaceTaskAddresses(workspaces: RuntimeDeviceWorkspace[]): RuntimeTaskAddress[] {
  return workspaces.flatMap(workspace =>
    workspace.localTasks.map(task => ({
      deviceId: workspace.deviceId,
      localTaskId: task.localTaskId,
    }))
  )
}

function projectTaskAddresses(
  runtimeWork: RuntimeWorkListResponse | null,
  runtimeProjectKeys: string[]
): RuntimeTaskAddress[] {
  if (!runtimeWork || runtimeProjectKeys.length === 0) return []

  const keySet = new Set(runtimeProjectKeys)
  return runtimeWork.projects.flatMap(projectWork =>
    keySet.has(projectWork.project.key) ? workspaceTaskAddresses(projectWork.deviceWorkspaces) : []
  )
}

function resolveRuntimeTaskRouteAddress(
  runtimeWork: RuntimeWorkListResponse | null,
  route: RuntimeTaskRoute
): RuntimeTaskAddress | null {
  if (!runtimeWork) return null

  const workspaces = [
    ...runtimeWork.projects.flatMap(projectWork => projectWork.deviceWorkspaces),
    ...runtimeWork.chats,
  ]
  let fallbackAddress: RuntimeTaskAddress | null = null
  let hasMultipleFallbacks = false

  for (const workspace of workspaces) {
    const task = workspace.localTasks.find(item => item.localTaskId === route.localTaskId)
    if (!task) continue

    if (workspace.deviceId !== route.deviceId) {
      if (fallbackAddress) {
        hasMultipleFallbacks = true
      } else {
        fallbackAddress = {
          deviceId: workspace.deviceId,
          localTaskId: task.localTaskId,
        }
      }
      continue
    }

    return {
      deviceId: workspace.deviceId,
      localTaskId: task.localTaskId,
    }
  }

  return hasMultipleFallbacks ? null : fallbackAddress
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

function runtimeAddressDebug(address: RuntimeTaskAddress): Record<string, unknown> {
  return {
    deviceId: address.deviceId,
    localTaskId: address.localTaskId,
    workspacePath: address.workspacePath ?? null,
  }
}

function runtimeTranscriptDebug(response: unknown): Record<string, unknown> {
  if (!isRecord(response)) {
    return { responseType: Array.isArray(response) ? 'array' : typeof response }
  }
  const messages = response.messages
  return {
    keys: Object.keys(response).slice(0, 20),
    success: response.success,
    error: response.error,
    runtime: response.runtime,
    hasMessages: 'messages' in response,
    messagesType: Array.isArray(messages) ? 'array' : typeof messages,
    messageCount: Array.isArray(messages) ? messages.length : null,
    hasMoreBefore: response.hasMoreBefore,
    beforeCursor: response.beforeCursor,
  }
}

function isDeviceStatus(value: unknown): value is DeviceInfo['status'] {
  return value === 'online' || value === 'offline' || value === 'busy'
}

function getDeviceEventId(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.device_id !== 'string') return null
  const deviceId = payload.device_id.trim()
  return deviceId || null
}

function getDeviceEventName(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.name !== 'string') return null
  const name = payload.name.trim()
  return name || null
}

function getBlockTimestamp(value: unknown, fallbackTimestamp = Date.now()): number {
  if (typeof value === 'string' && value.trim()) {
    const numericValue = Number(value)
    if (Number.isFinite(numericValue)) {
      return getBlockTimestamp(numericValue, fallbackTimestamp)
    }

    const parsed = new Date(value).getTime()
    return Number.isFinite(parsed) ? parsed : fallbackTimestamp
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) return fallbackTimestamp

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

  const timestamp = getBlockTimestamp(
    block.timestamp ?? block.created_at ?? block.createdAt,
    fallbackTimestamp
  )
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

  if (block.type === 'file_changes') {
    const fileChanges = normalizeTurnFileChanges(block.fileChanges ?? block.file_changes)
    if (!fileChanges) return null
    const id = typeof block.id === 'string' ? block.id : `file-changes-${subtaskId}-${index}`
    return {
      id,
      subtaskId,
      type: 'file_changes',
      fileChanges,
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

function normalizeRuntimeReferences(
  references: NormalizedRuntimeMessage['references']
): WorkbenchMessage['references'] {
  if (!Array.isArray(references)) return undefined
  const normalized = references.filter(
    reference => reference && typeof reference.path === 'string' && reference.path.trim()
  )
  return normalized.length > 0 ? normalized : undefined
}

function normalizeRuntimeMemoryCitations(
  message: NormalizedRuntimeMessage
): WorkbenchMessage['memoryCitations'] {
  const citations: NonNullable<WorkbenchMessage['memoryCitations']> = []
  const addCitation = (value: unknown) => {
    if (isRecord(value) && Array.isArray(value.entries)) {
      citations.push(value as NonNullable<WorkbenchMessage['memoryCitations']>[number])
    }
  }

  if (Array.isArray(message.memoryCitations)) {
    message.memoryCitations.forEach(addCitation)
  }
  if (Array.isArray(message.memory_citations)) {
    message.memory_citations.forEach(addCitation)
  }
  addCitation(message.memoryCitation)
  addCitation(message.memory_citation)

  return citations.length > 0 ? citations : undefined
}

function normalizeRuntimeContextEvents(
  message: NormalizedRuntimeMessage
): WorkbenchMessage['contextEvents'] {
  const events = [...(message.contextEvents ?? []), ...(message.context_events ?? [])].filter(
    event => event && typeof event.id === 'string' && typeof event.type === 'string'
  )
  return events.length > 0 ? events : undefined
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
  const runtimeStatus = normalizedStatus === 'cancelled' ? 'cancelled' : status
  const source =
    role === 'user' && message.source?.source === 'im'
      ? ({ ...message.source, source: 'im' } as MessageSource)
      : undefined
  const createdAt = message.createdAt ?? new Date().toISOString()
  const completedAt = message.completedAt ?? message.completed_at ?? undefined
  const stoppedNotice = message.stoppedNotice ?? message.stopped_notice ?? undefined
  const messageCreatedAtMs = getBlockTimestamp(createdAt)
  const blocks = normalizeProcessingBlocks(
    getRuntimeMessageBlockSubtaskId(message, subtaskId),
    message.blocks,
    messageCreatedAtMs
  )
  return {
    id: `runtime-${address.localTaskId}-${message.id}`,
    role,
    subtaskId,
    content: message.content,
    status,
    runtimeStatus,
    source,
    attachments: message.attachments,
    blocks: blocks.length > 0 ? blocks : undefined,
    fileChanges: normalizeTurnFileChanges(message.fileChanges ?? message.file_changes),
    references: normalizeRuntimeReferences(message.references),
    memoryCitations: normalizeRuntimeMemoryCitations(message),
    contextEvents: normalizeRuntimeContextEvents(message),
    createdAt,
    completedAt,
    stoppedNotice,
  }
}

function runtimeMessagesToWorkbenchMessages(
  address: RuntimeTaskAddress,
  messages: NormalizedRuntimeMessage[]
): WorkbenchMessage[] {
  return messages.map(message => runtimeMessageToWorkbenchMessage(address, message))
}

function findFileChangesBySubtaskId(
  messages: WorkbenchMessage[],
  subtaskId: number
): TurnFileChangesSummary | undefined {
  return messages.find(message => message.subtaskId === subtaskId)?.fileChanges
}

function getCommandStdoutObject(stdout: unknown): Record<string, unknown> | null {
  return isRecord(stdout) ? stdout : null
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

function findRuntimeLocalTask(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress | null | undefined
): LocalTaskSummary | null {
  if (!runtimeWork || !address) return null
  const workspaces = [
    ...runtimeWork.chats,
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
  ]

  for (const workspace of workspaces) {
    if (workspace.deviceId !== address.deviceId) continue
    const task = workspace.localTasks.find(item => item.localTaskId === address.localTaskId)
    if (task) return task
  }

  return null
}

function getRuntimeCompatibilityFamily(runtime?: string | null): string | null {
  if (runtime === 'codex') return OPENAI_RESPONSES_RUNTIME_FAMILY
  if (runtime === 'claude_code' || runtime === 'claude') return CLAUDE_CODE_RUNTIME_FAMILY
  return null
}

function getCurrentRuntimeTaskCompatibilityFamily(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress | null | undefined
): string | null {
  return getRuntimeCompatibilityFamily(findRuntimeLocalTask(runtimeWork, address)?.runtime)
}

function isRuntimeLocalTaskRunning(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress | null | undefined
): boolean {
  return Boolean(findRuntimeLocalTask(runtimeWork, address)?.running)
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

function getSelectableProjectDeviceWorkspaces(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number | null | undefined
): RuntimeDeviceWorkspace[] {
  if (!projectId) return []
  const projectWork = runtimeWork?.projects.find(
    item => runtimeProjectUiId(item.project) === projectId
  )
  return projectWork?.deviceWorkspaces.filter(workspace => workspace.available) ?? []
}

function getSingleProjectDeviceWorkspaceId(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number | null | undefined
): number | null {
  const workspaces = getSelectableProjectDeviceWorkspaces(runtimeWork, projectId)
  return workspaces.length === 1 ? (workspaces[0].id ?? null) : null
}

function findSelectableProject(
  projects: ProjectWithTasks[],
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number
): ProjectWithTasks | null {
  const project = projects.find(item => item.id === projectId)
  if (project) return project
  const runtimeProject = runtimeWork?.projects.find(
    item => runtimeProjectUiId(item.project) === projectId
  )
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

function createRuntimeLocalTaskId(runtime: RuntimeTaskCreateRequest['runtime']): string {
  const prefix = runtime === 'codex' ? 'codex' : 'runtime'
  const randomId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${randomId}`
}

function selectedModelExecutionFields(
  selectedModel: UnifiedModel | null,
  selectedModelOptions: ModelOptions
): Pick<RuntimeSendRequest, 'modelId' | 'modelType' | 'modelOptions'> {
  if (!selectedModel) return {}
  const executionModel = resolveModelExecutionSelection(selectedModel)
  return {
    modelId: executionModel.modelName,
    modelType: executionModel.modelType,
    ...(Object.keys(selectedModelOptions).length > 0
      ? { modelOptions: { ...selectedModelOptions } }
      : {}),
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

async function timedWorkbenchBootstrapRequest<T>(
  label: string,
  request: Promise<T>
): Promise<PromiseSettledResult<T>> {
  const startedAt = nowMs()
  try {
    const value = await request
    const elapsedMs = Math.round(nowMs() - startedAt)
    if (elapsedMs > 5000) {
      console.warn(`[Wework] Workbench bootstrap ${label} completed slowly in ${elapsedMs}ms.`)
    }
    return { status: 'fulfilled', value }
  } catch (reason) {
    const elapsedMs = Math.round(nowMs() - startedAt)
    console.warn(`[Wework] Workbench bootstrap ${label} failed after ${elapsedMs}ms.`, reason)
    return { status: 'rejected', reason }
  }
}

export function WorkbenchProvider({
  children,
  user,
  services,
  onStartupReadyChange,
}: WorkbenchProviderProps) {
  const cloudConnection = useOptionalCloudConnection()
  const resolvedServices = useMemo(
    () =>
      services ??
      createDefaultServices({
        isConnected: cloudConnection.isConnected,
        backendUrl: cloudConnection.backendUrl,
        apiBaseUrl: cloudConnection.apiBaseUrl,
        socketBaseUrl: cloudConnection.socketBaseUrl,
        socketPath: cloudConnection.socketPath,
        token: cloudConnection.token,
      }),
    [
      cloudConnection.apiBaseUrl,
      cloudConnection.backendUrl,
      cloudConnection.isConnected,
      cloudConnection.socketBaseUrl,
      cloudConnection.socketPath,
      cloudConnection.token,
      services,
    ]
  )
  const executorClient = useMemo(() => {
    if (resolvedServices.executorClient) return resolvedServices.executorClient
    const { runtimeMode } = getRuntimeConfig()
    const transportKind =
      runtimeMode === 'local-first' && isTauriRuntime() ? 'local-ipc' : 'backend-relay'
    return createExecutorClientFromWorkbenchServices(resolvedServices, transportKind)
  }, [resolvedServices])
  const [state, dispatch] = useReducer(workbenchReducer, initialWorkbenchState)
  const [messages, dispatchMessages] = useReducer(
    reduceWorkbenchMessages<Attachment, TurnFileChangesSummary>,
    [] as WorkbenchMessage[]
  )
  const [queuedSends, setQueuedSends] = useState<QueuedWorkbenchSend[]>([])
  const [cloudWorkStatus, setCloudWorkStatus] = useState<CloudWorkStatus>(EMPTY_CLOUD_WORK_STATUS)
  const [guidanceMessages, setGuidanceMessages] = useState<GuidanceWorkbenchMessage[]>([])
  const [codeCommentContexts, setCodeCommentContexts] = useState<CodeCommentContext[]>([])
  const [upgradingDevices, setUpgradingDevices] = useState<Record<string, DeviceUpgradeState>>({})
  const [runtimeTranscriptLoadingKey, setRuntimeTranscriptLoadingKey] = useState<string | null>(
    null
  )
  const [runtimeTranscriptPage, setRuntimeTranscriptPage] = useState<RuntimeTranscriptPageState>({
    hasMoreBefore: false,
    beforeCursor: null,
    loadingMore: false,
  })
  const [isAwaitingAssistantStart, setIsAwaitingAssistantStart] = useState(false)
  const [routePath, setRoutePath] = useState(getCurrentAppPath)
  const [routeSearch, setRouteSearch] = useState(() => window.location.search)
  const [projectExecutionMode, setProjectExecutionMode] =
    useState<ProjectExecutionMode>('current_workspace')
  const [projectWorktreeBranch, setProjectWorktreeBranchState] = useState<string | null>(null)
  const upgradeClearTimersRef = useRef<Record<string, ReturnType<typeof window.setTimeout>>>({})
  const messagesRef = useRef<WorkbenchMessage[]>(messages)
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
  const currentRuntimeTaskRunning = useMemo(
    () => isRuntimeLocalTaskRunning(state.runtimeWork, state.currentRuntimeTask),
    [state.currentRuntimeTask, state.runtimeWork]
  )

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])
  const isRuntimeTranscriptLoading =
    Boolean(currentRuntimeTaskKey) && runtimeTranscriptLoadingKey === currentRuntimeTaskKey
  const currentUser = state.user ?? user

  useEffect(() => {
    if (!resolvedServices.cloudBackgroundApi) {
      setCloudWorkStatus(EMPTY_CLOUD_WORK_STATUS)
    }
  }, [resolvedServices.cloudBackgroundApi])
  const activeProject = state.currentProject
  const activeDeviceId =
    state.currentRuntimeTask?.deviceId ??
    getActiveWorkbenchDeviceId({
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
    setRuntimeTranscriptPage({
      hasMoreBefore: false,
      beforeCursor: null,
      loadingMore: false,
    })
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
  const setProjectWorktreeBranch = useCallback((branchName: string | null) => {
    const normalizedBranch = branchName?.trim() || null
    setProjectWorktreeBranchState(normalizedBranch)
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setProjectWorktreeBranchState(null)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [state.currentProject?.id])
  useEffect(() => {
    if (projectExecutionMode === 'git_worktree') return
    const timer = window.setTimeout(() => {
      setProjectWorktreeBranchState(null)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [projectExecutionMode])
  const modelSelectionConfig = useMemo(() => {
    return getNewChatModelSelection(currentUser) ?? null
  }, [currentUser])
  const modelCompatibilityConfig = useMemo(() => null, [])
  const modelCompatibilityFamily = useMemo(
    () => getCurrentRuntimeTaskCompatibilityFamily(state.runtimeWork, state.currentRuntimeTask),
    [state.currentRuntimeTask, state.runtimeWork]
  )
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
    compatibilityFamily: modelCompatibilityFamily,
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
  const isWorkbenchShellReady = !state.isBootstrapping
  const isStartupReady =
    isWorkbenchShellReady && modelSelection.isSelectionReady && !skillSelection.isLoading

  useEffect(() => {
    onStartupReadyChange?.(isWorkbenchShellReady)
  }, [isWorkbenchShellReady, onStartupReadyChange])

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

  const refreshCloudBackgroundData = useCallback(
    async (
      baseDevices: DeviceInfo[],
      baseRuntimeWork: RuntimeWorkListResponse,
      options?: {
        projects: ProjectWithTasks[]
        standaloneDeviceId: string | null
        isCancelled?: () => boolean
      }
    ) => {
      const backgroundApi = resolvedServices.cloudBackgroundApi
      const activeChecks: CloudWorkCheckKey[] = []
      if (backgroundApi?.listTeams) activeChecks.push('teams')
      if (backgroundApi?.listDevices) activeChecks.push('devices')
      if (backgroundApi?.listRuntimeWork) activeChecks.push('runtimeWork')

      if (activeChecks.length === 0) {
        return
      }

      setCloudWorkStatus(startCloudWorkSync(activeChecks))

      if (backgroundApi?.listTeams) {
        void timedWorkbenchBootstrapRequest('cloudTeams', backgroundApi.listTeams()).then(
          result => {
            if (options?.isCancelled?.()) return
            setCloudWorkStatus(current =>
              finishCloudWorkCheck(current, 'teams', '云端团队', result)
            )
          }
        )
      }

      const [devicesResult, runtimeWorkResult] = await Promise.all([
        backgroundApi?.listDevices
          ? timedWorkbenchBootstrapRequest('cloudDevices', backgroundApi.listDevices())
          : Promise.resolve({ status: 'fulfilled', value: [] } as PromiseFulfilledResult<
              DeviceInfo[]
            >),
        backgroundApi?.listRuntimeWork
          ? timedWorkbenchBootstrapRequest('cloudRuntimeWork', backgroundApi.listRuntimeWork())
          : Promise.resolve({
              status: 'fulfilled',
              value: EMPTY_RUNTIME_WORK,
            } as PromiseFulfilledResult<RuntimeWorkListResponse>),
      ])

      if (options?.isCancelled?.()) {
        return
      }

      if (backgroundApi?.listDevices) {
        setCloudWorkStatus(current =>
          finishCloudWorkCheck(current, 'devices', '云端设备', devicesResult, {
            isEmpty: value => Array.isArray(value) && value.length === 0,
          })
        )
      }
      if (backgroundApi?.listRuntimeWork) {
        setCloudWorkStatus(current =>
          finishCloudWorkCheck(current, 'runtimeWork', '云端任务列表', runtimeWorkResult)
        )
      }

      const devices = resolveDeviceListWithCache(
        mergeDeviceLists(
          baseDevices,
          devicesResult.status === 'fulfilled' ? devicesResult.value : []
        )
      )
      const runtimeWork =
        runtimeWorkResult.status === 'fulfilled'
          ? mergeRuntimeWorkLists(baseRuntimeWork, runtimeWorkResult.value)
          : baseRuntimeWork

      dispatch({
        type: 'lists_refreshed',
        projects: options?.projects ?? [],
        devices,
        runtimeWork,
        standaloneDeviceId: getPreferredStandaloneDeviceId(
          devices,
          options?.standaloneDeviceId ?? null
        ),
      })
    },
    [resolvedServices.cloudBackgroundApi]
  )

  useEffect(() => {
    let cancelled = false
    const startedAt = nowMs()
    const slowTimer = window.setTimeout(() => {
      if (!cancelled) {
        console.warn('[Wework] Workbench shell bootstrap is still running after 5000ms.')
      }
    }, 5000)

    async function bootstrap() {
      const [defaultTeamResult, devicesResult] = await Promise.all([
        timedWorkbenchBootstrapRequest(
          'defaultTeam',
          resolvedServices.teamApi.getDefaultWorkbenchTeam()
        ),
        timedWorkbenchBootstrapRequest('devices', executorClient.commands.listDevices()),
      ])

      if (cancelled) return
      window.clearTimeout(slowTimer)

      const elapsedMs = Math.round(nowMs() - startedAt)
      if (elapsedMs > 5000) {
        console.warn(`[Wework] Workbench shell bootstrap completed slowly in ${elapsedMs}ms.`, {
          defaultTeam: defaultTeamResult.status,
          devices: devicesResult.status,
        })
      }

      const rawDevices = devicesResult.status === 'fulfilled' ? devicesResult.value : []
      const devices = resolveDeviceListWithCache(rawDevices)
      const standaloneDeviceId = getRememberedStandaloneDeviceId(user, devices)

      dispatch({
        type: 'bootstrapped',
        user,
        defaultTeam: defaultTeamResult.status === 'fulfilled' ? defaultTeamResult.value : null,
        projects: [],
        devices,
        runtimeWork: EMPTY_RUNTIME_WORK,
        currentProject: null,
        standaloneDeviceId,
      })

      void timedWorkbenchBootstrapRequest(
        'runtimeWork',
        executorClient.runtime.listRuntimeWork()
      ).then(runtimeWorkResult => {
        if (cancelled) return
        const runtimeWork =
          runtimeWorkResult.status === 'fulfilled' ? runtimeWorkResult.value : EMPTY_RUNTIME_WORK
        if (runtimeWorkResult.status === 'fulfilled') {
          dispatch({ type: 'runtime_work_refreshed', runtimeWork })
        }
        void refreshCloudBackgroundData(devices, runtimeWork, {
          projects: [],
          standaloneDeviceId,
          isCancelled: () => cancelled,
        }).catch(() => undefined)
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
      window.clearTimeout(slowTimer)
    }
  }, [executorClient, refreshCloudBackgroundData, resolvedServices.teamApi, user])

  const refreshWorkLists = useCallback(async () => {
    const [devicesResult, runtimeWorkResult] = await Promise.all([
      executorClient.commands.listDevices().catch(error => {
        const cachedDevices = readCachedDeviceList()
        if (cachedDevices.length === 0) throw error
        return cachedDevices
      }),
      executorClient.runtime.listRuntimeWork().catch(() => undefined),
    ])
    const devices = resolveDeviceListWithCache(devicesResult)
    const runtimeWork = runtimeWorkResult ?? state.runtimeWork ?? EMPTY_RUNTIME_WORK
    dispatch({
      type: 'lists_refreshed',
      projects: state.projects,
      devices,
      runtimeWork,
      standaloneDeviceId: getPreferredStandaloneDeviceId(devices, state.standaloneDeviceId),
    })
    void refreshCloudBackgroundData(devices, runtimeWork, {
      projects: state.projects,
      standaloneDeviceId: state.standaloneDeviceId,
    }).catch(() => undefined)
  }, [
    executorClient,
    refreshCloudBackgroundData,
    state.projects,
    state.runtimeWork,
    state.standaloneDeviceId,
  ])

  const loadDevicesForRefresh = useCallback(
    async (options?: { useCacheFallback?: boolean }): Promise<DeviceInfo[]> => {
      let devices: DeviceInfo[]
      try {
        devices = await executorClient.commands.listDevices()
      } catch (error) {
        if (options?.useCacheFallback === false) {
          throw error
        }
        const cachedDevices = readCachedDeviceList()
        if (cachedDevices.length > 0) {
          devices = cachedDevices
        } else {
          throw error
        }
      }
      return resolveDeviceListWithCache(devices)
    },
    [executorClient]
  )

  const refreshDevices = useCallback(
    async (options?: { useCacheFallback?: boolean }) => {
      const devices = await loadDevicesForRefresh(options)
      dispatch({
        type: 'devices_refreshed',
        devices,
        standaloneDeviceId: getPreferredStandaloneDeviceId(devices, state.standaloneDeviceId),
      })
      void refreshCloudBackgroundData(devices, state.runtimeWork ?? EMPTY_RUNTIME_WORK, {
        projects: state.projects,
        standaloneDeviceId: state.standaloneDeviceId,
      }).catch(() => undefined)
    },
    [
      loadDevicesForRefresh,
      refreshCloudBackgroundData,
      state.projects,
      state.runtimeWork,
      state.standaloneDeviceId,
    ]
  )

  const getRemoteDeviceStartupCommand =
    useCallback(async (): Promise<DockerRemoteDeviceCommandResponse> => {
      const createCommand = resolvedServices.deviceApi.createDockerRemoteDeviceCommand
      if (!createCommand) {
        throw new Error('当前连接不支持生成云设备启动脚本')
      }
      return createCommand({ client_origin: window.location.origin })
    }, [resolvedServices.deviceApi])

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
        await executorClient.commands.upgradeDevice(deviceId, {
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
    [executorClient, refreshDevices, setDeviceUpgradeState, state.devices]
  )

  useEffect(() => {
    const refreshDevicesAfterEvent = () => {
      void refreshDevices({ useCacheFallback: false }).catch(() => undefined)
    }
    const handleDeviceOnline = (payload: unknown) => {
      const deviceId = getDeviceEventId(payload)
      if (deviceId) {
        dispatch({
          type: 'device_status_changed',
          deviceId,
          status: 'online',
          name: getDeviceEventName(payload),
        })
      }
      refreshDevicesAfterEvent()
    }
    const handleDeviceOffline = (payload: unknown) => {
      const deviceId = getDeviceEventId(payload)
      if (deviceId) {
        dispatch({
          type: 'device_status_changed',
          deviceId,
          status: 'offline',
        })
      }
      refreshDevicesAfterEvent()
    }
    const handleDeviceStatus = (payload: unknown) => {
      const deviceId = getDeviceEventId(payload)
      const status = isRecord(payload) ? payload.status : undefined
      if (deviceId && isDeviceStatus(status)) {
        dispatch({
          type: 'device_status_changed',
          deviceId,
          status,
        })
      }
      refreshDevicesAfterEvent()
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
      onDeviceOnline: handleDeviceOnline,
      onDeviceOffline: handleDeviceOffline,
      onDeviceStatus: handleDeviceStatus,
      onDeviceSlotUpdate: refreshDevicesAfterEvent,
      onDeviceUpgradeStatus: handleDeviceUpgradeStatus,
      onChatStart: payload => {
        if (!isCurrentLocalTaskEvent(currentRuntimeTaskRef.current, payload)) return
        setIsAwaitingAssistantStart(false)
        dispatchMessages({
          type: 'assistant_started',
          taskId: payload.task_id,
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
          standaloneWorkspacePath: null,
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
        standaloneWorkspacePath: null,
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

  const openStandaloneWorkspace = useCallback(
    async (deviceId: string, workspacePath: string, label?: string) => {
      const normalizedDeviceId = deviceId.trim()
      const normalizedWorkspacePath = workspacePath.trim()
      if (!normalizedDeviceId || !normalizedWorkspacePath) return
      const normalizedLabel = label?.trim()

      const response = await executorClient.runtime.openRuntimeWorkspace({
        deviceId: normalizedDeviceId,
        workspacePath: normalizedWorkspacePath,
        runtime: 'codex',
        ...(normalizedLabel ? { label: normalizedLabel } : {}),
      })
      if (!response.accepted) {
        throw new Error(response.error || 'Failed to register runtime workspace')
      }
      await refreshWorkLists()

      rememberExecutionDevice(normalizedDeviceId)
      dispatch({
        type: 'project_cleared',
        standaloneDeviceId: normalizedDeviceId,
        standaloneWorkspacePath: normalizedWorkspacePath,
      })
      dispatchMessages({ type: 'reset', messages: [] })
      setQueuedSends([])
      setGuidanceMessages([])
      setCodeCommentContexts([])
      cancelRuntimeTranscriptLoad()
      handledRuntimeTaskRouteRef.current = null
      navigateTo('/')
    },
    [cancelRuntimeTranscriptLoad, executorClient, refreshWorkLists, rememberExecutionDevice]
  )

  const startNewChat = useCallback(() => {
    dispatch({
      type: 'project_cleared',
      standaloneDeviceId: getRememberedStandaloneDeviceId(
        user,
        state.devices,
        state.standaloneDeviceId
      ),
      standaloneWorkspacePath: null,
    })
    dispatchMessages({ type: 'reset', messages: [] })
    setQueuedSends([])
    setGuidanceMessages([])
    setCodeCommentContexts([])
    setIsAwaitingAssistantStart(false)
    cancelRuntimeTranscriptLoad()
    handledRuntimeTaskRouteRef.current = null
    navigateTo('/')
  }, [cancelRuntimeTranscriptLoad, state.devices, state.standaloneDeviceId, user])

  const startStandaloneChat = useCallback(() => {
    dispatch({
      type: 'project_cleared',
      standaloneDeviceId: getRememberedStandaloneDeviceId(
        user,
        state.devices,
        state.standaloneDeviceId
      ),
      standaloneWorkspacePath: null,
    })
    dispatchMessages({ type: 'reset', messages: [] })
    setQueuedSends([])
    setGuidanceMessages([])
    setCodeCommentContexts([])
    setIsAwaitingAssistantStart(false)
    cancelRuntimeTranscriptLoad()
    handledRuntimeTaskRouteRef.current = null
    navigateTo('/')
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
      if (isSameRuntimeTaskIdentity(currentRuntimeTaskRef.current, address)) {
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
        ? (state.projects.find(
            item => item.id === runtimeProjectUiId(runtimeProjectWork.project)
          ) ?? runtimeProjectToProject(runtimeProjectWork))
        : null

      if (project) {
        writeLastProjectId(user.id, project.id)
      }
      setIsAwaitingAssistantStart(false)
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
      setRuntimeTranscriptPage({
        hasMoreBefore: false,
        beforeCursor: null,
        loadingMore: false,
      })
      setRuntimeTranscriptLoadingKey(loadingKey)
      handledRuntimeTaskRouteRef.current = loadingKey
      navigateTo(buildRuntimeTaskRoute(address))

      try {
        console.info('[Wework] Runtime transcript open request', {
          address: runtimeAddressDebug(address),
          loadingKey,
        })
        const transcript = await executorClient.runtime.getRuntimeTranscript({
          ...address,
          limit: RUNTIME_TRANSCRIPT_PAGE_SIZE,
        })
        if (runtimeOpenRequestIdRef.current !== requestId) return
        console.info('[Wework] Runtime transcript open response', {
          address: runtimeAddressDebug(address),
          response: runtimeTranscriptDebug(transcript),
        })
        if (!Array.isArray(transcript.messages)) {
          console.error('[Wework] Runtime transcript response missing messages array', {
            address: runtimeAddressDebug(address),
            response: runtimeTranscriptDebug(transcript),
          })
        }

        dispatchMessages({
          type: 'reset',
          messages: runtimeMessagesToWorkbenchMessages(address, transcript.messages),
        })
        setRuntimeTranscriptPage({
          hasMoreBefore: Boolean(transcript.hasMoreBefore),
          beforeCursor: transcript.beforeCursor ?? null,
          loadingMore: false,
        })
      } catch (error) {
        if (runtimeOpenRequestIdRef.current === requestId) {
          console.error('[Wework] Runtime transcript open failed', {
            address: runtimeAddressDebug(address),
            loadingKey,
            error,
          })
        }
      } finally {
        if (runtimeOpenRequestIdRef.current === requestId) {
          setRuntimeTranscriptLoadingKey(null)
        }
      }
    },
    [executorClient, state.projects, state.runtimeWork, user.id]
  )

  const clearCurrentRuntimeTaskView = useCallback(() => {
    dispatch({ type: 'current_task_cleared' })
    currentRuntimeTaskRef.current = null
    dispatchMessages({ type: 'reset', messages: [] })
    setQueuedSends([])
    setGuidanceMessages([])
    setCodeCommentContexts([])
    handledRuntimeTaskRouteRef.current = null
    navigateTo('/')
  }, [])

  const clearCurrentRuntimeTaskIfArchived = useCallback(
    (addresses: RuntimeTaskAddress[]) => {
      if (
        !addresses.some(address => isSameRuntimeTaskAddress(currentRuntimeTaskRef.current, address))
      ) {
        return
      }
      clearCurrentRuntimeTaskView()
    },
    [clearCurrentRuntimeTaskView]
  )

  const archiveRuntimeLocalTask = useCallback(
    async (address: RuntimeTaskAddress) => {
      const response = await executorClient.runtime.archiveConversation(address)
      if (!response.accepted) {
        dispatch({ type: 'error_set', error: response.error || 'Failed to archive runtime task' })
        return
      }

      if (
        state.currentRuntimeTask?.deviceId === address.deviceId &&
        state.currentRuntimeTask.localTaskId === address.localTaskId
      ) {
        clearCurrentRuntimeTaskView()
      }

      await refreshWorkLists()
    },
    [clearCurrentRuntimeTaskView, executorClient, refreshWorkLists, state.currentRuntimeTask]
  )

  const renameRuntimeLocalTask = useCallback(
    async (address: RuntimeTaskAddress, title: string) => {
      const response = await executorClient.runtime.renameRuntimeTask({
        address,
        title,
      })
      if (!response.accepted) {
        dispatch({ type: 'error_set', error: response.error || 'Failed to rename runtime task' })
        return
      }

      await refreshWorkLists()
    },
    [executorClient, refreshWorkLists]
  )

  const archiveProjectConversations = useCallback(
    async (runtimeProjectKey: string) => {
      const response = await executorClient.runtime.archiveProjectConversations({
        runtimeProjectKey,
      })
      if (!response.accepted) {
        dispatch({ type: 'error_set', error: response.error || 'Failed to archive project' })
        return
      }
      clearCurrentRuntimeTaskIfArchived(
        projectTaskAddresses(state.runtimeWork, [runtimeProjectKey])
      )
      await refreshWorkLists()
    },
    [clearCurrentRuntimeTaskIfArchived, executorClient, refreshWorkLists, state.runtimeWork]
  )

  const archiveProjectsConversations = useCallback(
    async (runtimeProjectKeys: string[]) => {
      const uniqueProjectKeys = [...new Set(runtimeProjectKeys.filter(Boolean))]
      if (uniqueProjectKeys.length === 0) return

      const archivedAddresses = projectTaskAddresses(state.runtimeWork, uniqueProjectKeys)
      const responses = await Promise.all(
        uniqueProjectKeys.map(runtimeProjectKey =>
          executorClient.runtime.archiveProjectConversations({ runtimeProjectKey })
        )
      )
      const failedResponse = responses.find(response => !response.accepted)
      if (failedResponse) {
        dispatch({
          type: 'error_set',
          error: failedResponse.error || 'Failed to archive project conversations',
        })
        return
      }

      clearCurrentRuntimeTaskIfArchived(archivedAddresses)
      await refreshWorkLists()
    },
    [clearCurrentRuntimeTaskIfArchived, executorClient, refreshWorkLists, state.runtimeWork]
  )

  const archiveChatConversations = useCallback(
    async (addresses: RuntimeTaskAddress[]) => {
      if (addresses.length === 0) return

      const responses = await Promise.all(
        addresses.map(address => executorClient.runtime.archiveConversation(address))
      )
      const failedResponse = responses.find(response => !response.accepted)
      if (failedResponse) {
        dispatch({
          type: 'error_set',
          error: failedResponse.error || 'Failed to archive chat conversations',
        })
        return
      }

      clearCurrentRuntimeTaskIfArchived(addresses)
      await refreshWorkLists()
    },
    [clearCurrentRuntimeTaskIfArchived, executorClient, refreshWorkLists]
  )

  const searchRuntimeWork = useCallback(
    async (request: RuntimeWorkSearchRequest) => executorClient.runtime.searchRuntimeWork(request),
    [executorClient]
  )

  const forkCurrentRuntimeTask = useCallback(
    async (target: RuntimeTaskForkTarget) => {
      if (!state.currentRuntimeTask) {
        dispatch({ type: 'error_set', error: 'No runtime task is selected' })
        return
      }

      const response = await executorClient.runtime.forkRuntimeTask({
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
    [executorClient, openRuntimeLocalTask, refreshWorkLists, state.currentRuntimeTask]
  )

  const loadOlderRuntimeTranscript = useCallback(async () => {
    const address = currentRuntimeTaskRef.current
    if (!address) return
    if (!runtimeTranscriptPage.hasMoreBefore || !runtimeTranscriptPage.beforeCursor) return
    if (runtimeTranscriptPage.loadingMore) return

    const requestKey = getRuntimeTaskRouteKey(address)
    const beforeCursor = runtimeTranscriptPage.beforeCursor
    setRuntimeTranscriptPage(previous => ({ ...previous, loadingMore: true }))

    try {
      console.info('[Wework] Runtime transcript load-more request', {
        address: runtimeAddressDebug(address),
        beforeCursor,
      })
      const transcript = await executorClient.runtime.getRuntimeTranscript({
        ...address,
        limit: RUNTIME_TRANSCRIPT_PAGE_SIZE,
        beforeCursor,
      })
      const currentAddress = currentRuntimeTaskRef.current
      if (!currentAddress || getRuntimeTaskRouteKey(currentAddress) !== requestKey) return
      console.info('[Wework] Runtime transcript load-more response', {
        address: runtimeAddressDebug(address),
        response: runtimeTranscriptDebug(transcript),
      })
      if (!Array.isArray(transcript.messages)) {
        console.error('[Wework] Runtime transcript load-more response missing messages array', {
          address: runtimeAddressDebug(address),
          response: runtimeTranscriptDebug(transcript),
        })
      }

      const olderMessages = runtimeMessagesToWorkbenchMessages(address, transcript.messages)
      dispatchMessages({
        type: 'reset',
        messages: [...olderMessages, ...messages],
      })
      setRuntimeTranscriptPage({
        hasMoreBefore: Boolean(transcript.hasMoreBefore),
        beforeCursor: transcript.beforeCursor ?? null,
        loadingMore: false,
      })
    } catch (error) {
      const currentAddress = currentRuntimeTaskRef.current
      if (currentAddress && getRuntimeTaskRouteKey(currentAddress) === requestKey) {
        console.error('[Wework] Runtime transcript load-more failed', {
          address: runtimeAddressDebug(address),
          beforeCursor,
          error,
        })
      }
    } finally {
      const currentAddress = currentRuntimeTaskRef.current
      if (currentAddress && getRuntimeTaskRouteKey(currentAddress) === requestKey) {
        setRuntimeTranscriptPage(previous => ({ ...previous, loadingMore: false }))
      }
    }
  }, [
    executorClient,
    messages,
    runtimeTranscriptPage.beforeCursor,
    runtimeTranscriptPage.hasMoreBefore,
    runtimeTranscriptPage.loadingMore,
  ])

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

    const runtimeTaskAddress =
      resolveRuntimeTaskRouteAddress(state.runtimeWork, runtimeTaskRoute) ?? runtimeTaskRoute

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
      const response = await executorClient.runtime.prepareDeviceWorkspace(data)
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
    [executorClient, refreshWorkLists, rememberExecutionDevice]
  )

  const deleteDeviceWorkspace = useCallback(
    async (data: DeleteDeviceWorkspaceRequest) => {
      await executorClient.runtime.deleteDeviceWorkspace(data)
      await refreshWorkLists()
    },
    [executorClient, refreshWorkLists]
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
      const runtimeWorkspace = findProjectDeviceWorkspace(state.runtimeWork, projectId, null)
      if (runtimeWorkspace) {
        const response = await executorClient.runtime.renameRuntimeWorkspace({
          deviceId: runtimeWorkspace.deviceId,
          workspacePath: runtimeWorkspace.workspacePath,
          runtime: 'codex',
          name,
        })
        if (!response.accepted) {
          const message = response.error || 'Failed to rename runtime workspace'
          dispatch({ type: 'error_set', error: message })
          throw new Error(message)
        }
        await refreshWorkLists()
        return
      }
      await resolvedServices.projectApi.updateProject(projectId, { name })
      await refreshWorkLists()
    },
    [executorClient, refreshWorkLists, resolvedServices, state.runtimeWork]
  )

  const removeProject = useCallback(
    async (projectId: number) => {
      const runtimeWorkspace = findProjectDeviceWorkspace(state.runtimeWork, projectId, null)
      if (runtimeWorkspace) {
        const response = await executorClient.runtime.removeRuntimeWorkspace({
          deviceId: runtimeWorkspace.deviceId,
          workspacePath: runtimeWorkspace.workspacePath,
          runtime: 'codex',
        })
        if (!response.accepted) {
          const message = response.error || 'Failed to remove runtime workspace'
          dispatch({ type: 'error_set', error: message })
          throw new Error(message)
        }
        await refreshWorkLists()
        return
      }
      await resolvedServices.projectApi.deleteProject(projectId)
      await refreshWorkLists()
    },
    [executorClient, refreshWorkLists, resolvedServices, state.runtimeWork]
  )

  const getDeviceHomeDirectory = useCallback(
    (deviceId: string) => executorClient.commands.getHomeDirectory(deviceId),
    [executorClient]
  )

  const getProjectWorkspaceRoot = useCallback(
    (deviceId: string) => executorClient.commands.getProjectWorkspaceRoot(deviceId),
    [executorClient]
  )

  const listDeviceDirectories = useCallback(
    (deviceId: string, path: string) => executorClient.commands.listDirectories(deviceId, path),
    [executorClient]
  )

  const createDeviceDirectory = useCallback(
    (deviceId: string, path: string) => executorClient.commands.createDirectory(deviceId, path),
    [executorClient]
  )

  const loadEnvironmentInfo = useCallback(
    (project: ProjectWithTasks | null, workspaceTarget?: WorkspaceTarget | null) =>
      loadProjectEnvironment(executorClient.commands, project, workspaceTarget),
    [executorClient]
  )

  const loadEnvironmentDiff = useCallback(
    (
      project: ProjectWithTasks | null,
      workspaceTarget?: WorkspaceTarget | null,
      mode?: EnvironmentDiffMode
    ) => loadProjectEnvironmentDiff(executorClient.commands, project, workspaceTarget, mode),
    [executorClient]
  )

  const commitEnvironmentChanges = useCallback(
    (project: ProjectWithTasks | null, message: string, workspaceTarget?: WorkspaceTarget | null) =>
      commitProjectChanges(executorClient.commands, project, message, workspaceTarget),
    [executorClient]
  )

  const listEnvironmentBranches = useCallback(
    (project: ProjectWithTasks | null, workspaceTarget?: WorkspaceTarget | null) =>
      listProjectBranches(executorClient.commands, project, workspaceTarget),
    [executorClient]
  )

  const checkoutEnvironmentBranch = useCallback(
    (
      project: ProjectWithTasks | null,
      branchName: string,
      workspaceTarget?: WorkspaceTarget | null
    ) => checkoutProjectBranch(executorClient.commands, project, branchName, workspaceTarget),
    [executorClient]
  )

  const createEnvironmentBranch = useCallback(
    (
      project: ProjectWithTasks | null,
      branchName: string,
      workspaceTarget?: WorkspaceTarget | null
    ) =>
      createAndCheckoutProjectBranch(executorClient.commands, project, branchName, workspaceTarget),
    [executorClient]
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
  const currentRuntimeTaskBusy =
    currentRuntimeTaskRunning || hasActiveTurn || isAwaitingAssistantStart

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
              standaloneDeviceId: getPreferredStandaloneDeviceId(
                state.devices,
                state.standaloneDeviceId
              ),
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
        const branch = projectWorktreeBranch?.trim()
        payload.execution = {
          workspace: {
            source: 'git_worktree',
            ...(branch ? { branch } : {}),
          },
        }
      }

      if (selectedModel) {
        const executionModel = selectedModelExecutionFields(
          selectedModel,
          modelSelection.selectedModelOptions
        )
        payload.force_override_bot_model = executionModel.modelId
        if (executionModel.modelType) {
          payload.force_override_bot_model_type = executionModel.modelType
        }
        if (
          modelSelection.selectedModel &&
          executionModel.modelOptions &&
          Object.keys(executionModel.modelOptions).length > 0
        ) {
          payload.model_options = executionModel.modelOptions
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
      projectWorktreeBranch,
      skillSelection.selectedSkills,
      projectExecutionMode,
      state.currentProject,
      state.devices,
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
      activeDeviceId?: string,
      displayAttachments: Attachment[] = []
    ): Promise<boolean> => {
      const projectId = payload.project_id && payload.project_id > 0 ? payload.project_id : null
      const selectedModel =
        modelSelection.selectedModel ?? resolveAutomaticModel(modelSelection.models)
      const runtime = inferRuntimeName(selectedModel)
      const localTaskId = createRuntimeLocalTaskId(runtime)
      const selectedProjectWorkspace = findProjectDeviceWorkspace(
        state.runtimeWork,
        projectId,
        state.selectedDeviceWorkspaceId
      )
      let runtimeTaskTarget: Pick<
        RuntimeTaskCreateRequest,
        'projectId' | 'deviceWorkspaceId' | 'deviceId' | 'workspacePath'
      >
      let optimisticDeviceId: string
      if (projectId) {
        if (!selectedProjectWorkspace) {
          reportSendBlocked('请选择任务运行位置')
          return false
        }
        optimisticDeviceId = selectedProjectWorkspace.deviceId
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
        let workspacePath = state.standaloneWorkspacePath
        if (!workspacePath && activeDeviceId) {
          try {
            workspacePath = await createConversationWorkspace(
              executorClient.commands,
              activeDeviceId,
              displayMessage
            )
          } catch (error) {
            reportSendBlocked(error instanceof Error ? error.message : '创建对话工作区失败')
            return false
          }
        }
        if (!activeDeviceId || !workspacePath) {
          reportSendBlocked('请选择项目或打开设备工作区后再发送')
          return false
        }
        optimisticDeviceId = activeDeviceId
        runtimeTaskTarget = {
          deviceId: activeDeviceId,
          workspacePath,
        }
      }

      const createRequest: RuntimeTaskCreateRequest = {
        ...runtimeTaskTarget,
        localTaskId,
        teamId: payload.team_id,
        runtime,
        message: payload.message,
        title: buildRuntimeTaskTitle(displayMessage, payload.title),
        modelId: payload.force_override_bot_model,
        modelType: payload.force_override_bot_model_type ?? null,
        modelOptions: payload.model_options ?? {},
        additionalSkills: payload.additional_skills ?? [],
        attachmentIds: payload.attachment_ids ?? [],
        execution: payload.execution,
      }
      const optimisticAddress: RuntimeTaskAddress = {
        deviceId: optimisticDeviceId,
        localTaskId,
      }
      const runtimeProject = projectId
        ? (state.projects.find(project => project.id === projectId) ?? state.currentProject)
        : null

      if (optimisticAddress.deviceId) rememberExecutionDevice(optimisticAddress.deviceId)
      currentRuntimeTaskRef.current = optimisticAddress
      dispatch({
        type: 'runtime_task_opened',
        address: optimisticAddress,
        project: runtimeProject,
      })
      handledRuntimeTaskRouteRef.current = getRuntimeTaskRouteKey(optimisticAddress)
      navigateTo(buildRuntimeTaskRoute(optimisticAddress))
      setIsAwaitingAssistantStart(true)

      dispatch({ type: 'sending_started' })
      dispatchMessages({
        type: 'user_added',
        message: {
          id: `runtime-local-${Date.now()}`,
          role: 'user',
          content: displayMessage,
          attachments: displayAttachments,
          status: 'done',
          createdAt: new Date().toISOString(),
        },
      })
      attachmentSelection.resetAttachments()

      try {
        const response = await executorClient.runtime.createRuntimeTask(createRequest)
        if (!response.accepted) {
          throw new Error(response.error || '发送失败')
        }
        const address: RuntimeTaskAddress = {
          deviceId: response.deviceId || optimisticAddress.deviceId,
          localTaskId: response.localTaskId || optimisticAddress.localTaskId,
        }
        if (!isSameRuntimeTaskIdentity(optimisticAddress, address)) {
          if (address.deviceId) rememberExecutionDevice(address.deviceId)
          currentRuntimeTaskRef.current = address
          dispatch({
            type: 'runtime_task_opened',
            address,
            project: runtimeProject,
          })
          handledRuntimeTaskRouteRef.current = getRuntimeTaskRouteKey(address)
          navigateTo(buildRuntimeTaskRoute(address))
        }
        await refreshWorkLists()
        // A freshly created task has no prior history, so reset pagination
        // directly instead of re-fetching the transcript. Re-fetching here would
        // reset the message list with a stale snapshot and clobber both the
        // optimistic user message and the live WebSocket "thinking" turn, causing
        // the indicator to flicker (appear -> disappear -> reappear).
        setRuntimeTranscriptPage({
          hasMoreBefore: false,
          beforeCursor: null,
          loadingMore: false,
        })
        handledRuntimeTaskRouteRef.current = getRuntimeTaskRouteKey(address)
        navigateTo(buildRuntimeTaskRoute(address))
        return true
      } catch (error) {
        if (isSameRuntimeTaskIdentity(currentRuntimeTaskRef.current, optimisticAddress)) {
          currentRuntimeTaskRef.current = null
          setIsAwaitingAssistantStart(false)
          dispatch({ type: 'current_task_cleared' })
          handledRuntimeTaskRouteRef.current = null
          navigateTo('/')
        }
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
      attachmentSelection,
      modelSelection.models,
      modelSelection.selectedModel,
      refreshWorkLists,
      rememberExecutionDevice,
      reportSendBlocked,
      executorClient,
      state.currentProject,
      state.projects,
      state.runtimeWork,
      state.selectedDeviceWorkspaceId,
      state.standaloneWorkspacePath,
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
    const runtimeSelectedModel =
      modelSelection.selectedModel ?? resolveAutomaticModel(modelSelection.models)
    const runtimeModelFields = selectedModelExecutionFields(
      runtimeSelectedModel,
      modelSelection.selectedModelOptions
    )

    if (state.currentRuntimeTask) {
      if (hasCodeComments) {
        reportSendBlocked('当前 LocalTask 暂不支持代码评论')
        return
      }
      if (currentRuntimeTaskBusy) {
        const currentAttachments = attachmentSelection.attachments
        setQueuedSends(items => [
          ...items,
          {
            id: `queued-runtime-${Date.now()}-${items.length}`,
            content: payloadMessage,
            status: 'queued',
            createdAt: new Date().toISOString(),
            runtimeAddress: state.currentRuntimeTask ?? undefined,
            attachments: currentAttachments,
            ...runtimeModelFields,
          },
        ])
        dispatch({ type: 'input_changed', input: '' })
        attachmentSelection.resetAttachments()
        return
      }
      const currentAttachments = attachmentSelection.attachments
      dispatch({ type: 'input_changed', input: '' })
      dispatch({ type: 'sending_started' })
      dispatchMessages({
        type: 'user_added',
        message: {
          id: `runtime-local-${Date.now()}`,
          role: 'user',
          content: payloadMessage,
          attachments: currentAttachments,
          status: 'done',
          createdAt: new Date().toISOString(),
        },
      })
      attachmentSelection.resetAttachments()
      setIsAwaitingAssistantStart(true)

      try {
        const runtimeSendRequest: RuntimeSendRequest = {
          address: state.currentRuntimeTask,
          message: payloadMessage,
          ...runtimeModelFields,
        }
        if (currentAttachments.length > 0) {
          runtimeSendRequest.attachmentIds = currentAttachments.map(attachment => attachment.id)
        }
        const response = await executorClient.runtime.sendRuntimeMessage(runtimeSendRequest)
        if (!response.accepted) {
          throw new Error(response.error || '发送失败')
        }
        await refreshWorkLists()
      } catch (error) {
        setIsAwaitingAssistantStart(false)
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
      prepared.activeDeviceId,
      attachmentSelection.attachments
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
    currentRuntimeTaskBusy,
    modelSelection.models,
    modelSelection.selectedModel,
    modelSelection.selectedModelOptions,
    reportSendBlocked,
    sendPreparedRuntimeMessage,
    state.devices,
    state.currentProject,
    state.currentRuntimeTask,
    state.defaultTeam,
    state.input,
    refreshWorkLists,
    executorClient,
  ])

  useEffect(() => {
    const queuedMessage = queuedSends.find(item => item.status === 'queued')
    if (!queuedMessage) return
    if (!state.currentRuntimeTask || currentRuntimeTaskBusy) return
    if (queuedSends.some(item => item.status === 'sending')) return
    const queuedMessageToSend = queuedMessage
    const runtimeAddress = queuedMessage.runtimeAddress ?? state.currentRuntimeTask

    setQueuedSends(items =>
      items.map(item =>
        item.id === queuedMessageToSend.id ? { ...item, status: 'sending' } : item
      )
    )
    setIsAwaitingAssistantStart(true)

    async function sendQueuedRuntimeMessage() {
      try {
        const runtimeSendRequest: RuntimeSendRequest = {
          address: runtimeAddress,
          message: queuedMessageToSend.content,
          ...(queuedMessageToSend.modelId
            ? {
                modelId: queuedMessageToSend.modelId,
                modelType: queuedMessageToSend.modelType,
                ...(queuedMessageToSend.modelOptions
                  ? { modelOptions: queuedMessageToSend.modelOptions }
                  : {}),
              }
            : {}),
        }
        if (queuedMessageToSend.attachments && queuedMessageToSend.attachments.length > 0) {
          runtimeSendRequest.attachmentIds = queuedMessageToSend.attachments.map(
            attachment => attachment.id
          )
        }

        dispatchMessages({
          type: 'user_added',
          message: {
            id: `runtime-local-${Date.now()}`,
            role: 'user',
            content: queuedMessageToSend.content,
            attachments: queuedMessageToSend.attachments,
            status: 'done',
            createdAt: new Date().toISOString(),
          },
        })

        const response = await executorClient.runtime.sendRuntimeMessage(runtimeSendRequest)
        if (!response.accepted) {
          throw new Error(response.error || '发送失败')
        }
        setQueuedSends(items => items.filter(item => item.id !== queuedMessageToSend.id))
        await refreshWorkLists()
      } catch (error) {
        setIsAwaitingAssistantStart(false)
        setQueuedSends(items =>
          items.map(item =>
            item.id === queuedMessageToSend.id
              ? {
                  ...item,
                  status: 'failed',
                  error: error instanceof Error ? error.message : '发送失败',
                }
              : item
          )
        )
      }
    }

    void sendQueuedRuntimeMessage()
  }, [
    currentRuntimeTaskBusy,
    executorClient,
    queuedSends,
    refreshWorkLists,
    state.currentRuntimeTask,
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
        if (currentRuntimeTaskRunning) {
          reportSendBlocked(i18n.t('workbench.runtime_task_running_message'))
          return
        }
        try {
          const runtimeSelectedModel =
            modelSelection.selectedModel ?? resolveAutomaticModel(modelSelection.models)
          const response = await executorClient.runtime.sendRuntimeMessage({
            address: state.currentRuntimeTask,
            message: previousUserMessage.content,
            ...selectedModelExecutionFields(
              runtimeSelectedModel,
              modelSelection.selectedModelOptions
            ),
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
      executorClient,
      refreshWorkLists,
      reportSendBlocked,
      currentRuntimeTaskRunning,
      modelSelection.models,
      modelSelection.selectedModel,
      modelSelection.selectedModelOptions,
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
      const runtimeFileChanges = state.currentRuntimeTask
        ? findFileChangesBySubtaskId(messagesRef.current, subtaskId)
        : undefined
      if (runtimeFileChanges?.diff) return runtimeFileChanges.diff
      if (runtimeFileChanges) {
        const response = await executorClient.commands.executeCommand(
          runtimeFileChanges.device_id,
          {
            command_key: 'turn_file_changes_review',
            path: runtimeFileChanges.workspace_path,
            args: [runtimeFileChanges.artifact_id],
            timeout_seconds: 30,
            max_output_bytes: 5 * 1024 * 1024,
          }
        )
        const stdout = getCommandStdoutObject(response.stdout)
        if (
          !response.success ||
          !stdout ||
          stdout.success !== true ||
          typeof stdout.diff !== 'string'
        ) {
          if (stdout?.status === 'artifact_missing') {
            dispatchMessages({
              type: 'file_changes_updated',
              subtaskId,
              fileChanges: { ...runtimeFileChanges, status: 'artifact_missing' },
            })
          }
          throw new Error(
            String(
              stdout?.error || response.error || response.stderr || 'File changes review failed'
            )
          )
        }
        return stdout.diff
      }
      if (state.currentRuntimeTask) {
        throw new Error('Runtime file changes artifact is unavailable')
      }

      const loadDiff = resolvedServices.taskApi.getTurnFileChangesDiff
      if (!loadDiff) throw new Error('File changes review is unavailable')
      const response = await loadDiff(subtaskId)
      return response.diff
    },
    [executorClient, resolvedServices.taskApi, state.currentRuntimeTask]
  )

  const revertTurnFileChanges = useCallback(
    async (subtaskId: number) => {
      const runtimeFileChanges = state.currentRuntimeTask
        ? findFileChangesBySubtaskId(messagesRef.current, subtaskId)
        : undefined
      if (runtimeFileChanges && state.currentRuntimeTask) {
        try {
          const response = await executorClient.runtime.revertRuntimeFileChanges({
            address: state.currentRuntimeTask,
            fileChanges: runtimeFileChanges,
          })
          const fileChanges = normalizeTurnFileChanges(
            response.fileChanges ?? response.file_changes
          )
          if (!fileChanges) {
            throw new Error('Invalid file changes response')
          }
          const nextFileChanges = {
            ...fileChanges,
            diff: runtimeFileChanges.diff,
            revertible: runtimeFileChanges.revertible ?? true,
          }
          dispatchMessages({
            type: 'file_changes_updated',
            subtaskId,
            fileChanges: nextFileChanges,
          })
          return nextFileChanges
        } catch (error) {
          if (error instanceof ApiError && isRecord(error.detail)) {
            const fileChanges = normalizeTurnFileChanges(error.detail.file_changes)
            if (fileChanges) {
              const nextFileChanges = {
                ...fileChanges,
                diff: runtimeFileChanges.diff,
                revertible: runtimeFileChanges.revertible ?? true,
              }
              dispatchMessages({
                type: 'file_changes_updated',
                subtaskId,
                fileChanges: nextFileChanges,
              })
            }
          }
          throw error
        }
      }
      if (state.currentRuntimeTask) {
        throw new Error('Runtime file changes artifact is unavailable')
      }
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
    [executorClient, resolvedServices.taskApi, state.currentRuntimeTask]
  )

  const pauseCurrentResponse = useCallback(async () => {
    if (!activeAssistantMessage?.subtaskId || !state.currentRuntimeTask) return

    const ack = await executorClient.runtime.cancelRuntimeTask(state.currentRuntimeTask)

    if (!ack.accepted) {
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
  }, [activeAssistantMessage, executorClient, state.currentRuntimeTask])

  const sendQueuedAsGuidance = useCallback(
    async (id: string) => {
      const queuedMessage = queuedSends.find(item => item.id === id)
      if (!queuedMessage || queuedMessage.status === 'sending') return

      const runtimeAddress = queuedMessage.runtimeAddress ?? state.currentRuntimeTask
      if (!runtimeAddress) {
        setQueuedSends(items =>
          items.map(item =>
            item.id === id ? { ...item, status: 'failed', error: '当前回复缺少引导上下文' } : item
          )
        )
        return
      }

      setQueuedSends(items =>
        items.map(item =>
          item.id === id
            ? {
                ...item,
                status: 'sending',
                error: undefined,
                notice: '正在暂停当前回复并发送',
              }
            : item
        )
      )

      try {
        const cancelResponse = await executorClient.runtime.cancelRuntimeTask(runtimeAddress)
        if (!cancelResponse.accepted) {
          throw new Error(cancelResponse.error || '暂停当前回复失败')
        }

        if (activeAssistantMessage?.subtaskId) {
          dispatchMessages({
            type: 'assistant_done',
            subtaskId: activeAssistantMessage.subtaskId,
            content: activeAssistantMessage.content,
          })
        }

        const runtimeSendRequest: RuntimeSendRequest = {
          address: runtimeAddress,
          message: queuedMessage.content,
          ...(queuedMessage.modelId
            ? {
                modelId: queuedMessage.modelId,
                modelType: queuedMessage.modelType,
                ...(queuedMessage.modelOptions ? { modelOptions: queuedMessage.modelOptions } : {}),
              }
            : {}),
        }
        if (queuedMessage.attachments && queuedMessage.attachments.length > 0) {
          runtimeSendRequest.attachmentIds = queuedMessage.attachments.map(
            attachment => attachment.id
          )
        }
        setIsAwaitingAssistantStart(true)
        dispatchMessages({
          type: 'user_added',
          message: {
            id: `runtime-guidance-${Date.now()}`,
            role: 'user',
            content: queuedMessage.content,
            attachments: queuedMessage.attachments,
            status: 'done',
            createdAt: new Date().toISOString(),
          },
        })
        const sendResponse = await executorClient.runtime.sendRuntimeMessage(runtimeSendRequest)
        if (!sendResponse.accepted) {
          throw new Error(sendResponse.error || '发送失败')
        }
        setQueuedSends(items => items.filter(item => item.id !== id))
        await refreshWorkLists()
      } catch (error) {
        setIsAwaitingAssistantStart(false)
        setQueuedSends(items =>
          items.map(item =>
            item.id === id
              ? {
                  ...item,
                  status: 'failed',
                  notice: undefined,
                  error: error instanceof Error ? error.message : '引导发送失败',
                }
              : item
          )
        )
      }
    },
    [
      activeAssistantMessage,
      executorClient,
      queuedSends,
      refreshWorkLists,
      state.currentRuntimeTask,
    ]
  )

  const listLocalSkills = useCallback(async () => {
    if (!activeDeviceId) return []

    const cached = localSkillsCacheRef.current.get(activeDeviceId)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.skills
    }

    const skills = await executorClient.commands.listSkills(activeDeviceId)
    localSkillsCacheRef.current.set(activeDeviceId, {
      expiresAt: Date.now() + LOCAL_SKILLS_CACHE_TTL_MS,
      skills,
    })
    return skills
  }, [activeDeviceId, executorClient])

  const workspaceFileApi = useMemo(
    () => ({
      listWorkspaceEntries: executorClient.files.listWorkspaceEntries,
      readWorkspaceTextFile: executorClient.files.readWorkspaceTextFile,
    }),
    [executorClient]
  )

  const value: WorkbenchContextValue = {
    state,
    isStartupReady,
    messages,
    queuedMessages: queuedSends,
    guidanceMessages,
    codeCommentContexts,
    workspaceFileApi,
    currentRuntimeTaskRunning,
    cloudWorkStatus,
    isAwaitingAssistantStart,
    isRuntimeTranscriptLoading,
    runtimeTranscriptHasMoreBefore: runtimeTranscriptPage.hasMoreBefore,
    isRuntimeTranscriptLoadingMore: runtimeTranscriptPage.loadingMore,
    upgradingDevices,
    projectExecutionMode,
    setProjectExecutionMode: selectProjectExecutionMode,
    projectWorktreeBranch,
    setProjectWorktreeBranch,
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
    openStandaloneWorkspace,
    startNewChat,
    startStandaloneChat,
    startNewProjectChat,
    openRuntimeLocalTask,
    searchRuntimeWork,
    loadOlderRuntimeTranscript,
    renameRuntimeLocalTask,
    archiveRuntimeLocalTask,
    archiveProjectConversations,
    archiveProjectsConversations,
    archiveChatConversations,
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
    getRemoteDeviceStartupCommand,
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
